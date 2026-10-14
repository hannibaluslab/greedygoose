import { toUsd } from "@/lib/cash";
import { EQUITIES } from "@/lib/tokens/registry";
import { LIMIT_USD, limitRaw, stockLimitsRaw, type StockLimits } from "@/lib/agents/permissions";

/*
 * Protect's settings (the agent sheet, docs/agents-redesign): one daily limit, repay from cash (Job.Protect, always
 * first), selling backing stock as its own grant (Job.ProtectSell, decision 5), what it sells first (the registry's
 * `keepMix`) and the never-sell list (stocks left out of the sell grant). Pure, so the steps a save takes are tested.
 */

/** Protect's daily limit chips; it starts on the boards' "$300 a day". Both wait on calibration (plan item 6 step 9). */
export const PROTECT_LIMIT_USD = { options: [100, 300, 500], start: LIMIT_USD.protect.start } as const;

/** What the chain says Protect runs with now. */
export type ProtectSaved = {
  /** Repay from cash: its grant's daily limit while on (or starting), null while off. */
  repayCapRaw: bigint | null;
  /** Selling: its grant's daily limit and each stock's, while on (or starting), null while off. */
  sell: { capRaw: bigint; limitsRaw: StockLimits } | null;
  /** The registry's "Keep my mix"; null until read (or with no executor). */
  keepMix: boolean | null;
};

/** What the screen shows: the saved settings until the user changes one. */
export type ProtectChoice = { limitUsd: number; sellOn: boolean; keepMix: boolean; never: readonly number[] };

/** One JAW sheet each: the registry setting through useTx, then each grant or revoke on JAW's own screen (D14). */
export type ProtectStep =
  | { kind: "keepMix"; on: boolean }
  | { kind: "grant"; job: "protect"; capRaw: bigint }
  | { kind: "grant"; job: "sell"; capRaw: bigint; limitsRaw: StockLimits }
  | { kind: "revoke"; job: "sell" };

/** The stocks a sell grant leaves out (limit 0), by reserve id. */
export function neverSellOf(limitsRaw: StockLimits | null | undefined): number[] {
  return limitsRaw ? EQUITIES.filter((e) => limitsRaw[e.reserveId] === 0n).map((e) => e.reserveId) : [];
}

/** The screen's starting point: Protect's limit is the repay grant's, else the sell grant's, else $300. */
export function savedChoice(saved: ProtectSaved): ProtectChoice {
  const capRaw = saved.repayCapRaw ?? saved.sell?.capRaw ?? null;
  return {
    limitUsd: capRaw === null ? PROTECT_LIMIT_USD.start : toUsd(capRaw),
    sellOn: saved.sell !== null,
    keepMix: saved.keepMix ?? false,
    never: neverSellOf(saved.sell?.limitsRaw),
  };
}

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((r) => b.includes(r));

/**
 * The sell grant for a never-sell set: every stock but those, each at shares worth twice the limit at Aave's price
 * (`stockLimitsRaw`), so a stock bought and used as backing later is covered without a new grant.
 */
export function sellLimitsFor(capRaw: bigint, capMaxRaw: bigint, pricesRaw: readonly bigint[], never: readonly number[]): StockLimits {
  return stockLimitsRaw(capRaw, capMaxRaw, pricesRaw, EQUITIES.map((e) => !never.includes(e.reserveId)));
}

/**
 * What saving `choice` takes, in order, from what is `saved`: "Sells first" (only while selling stays on), then the
 * repay grant at the new limit (or at the limit on screen while it's off: saving switches Protect on), then the sell grant (switched on, or its limit or never-sell list changed) or its
 * revoke. Selling follows Protect's one limit, so a new limit with selling on is two grants. `blocked` says why it
 * can't save: every stock is on the never-sell list.
 */
export function protectSteps(
  saved: ProtectSaved,
  choice: ProtectChoice,
  ctx: { capMaxRaw: bigint; pricesRaw: readonly bigint[] },
): { steps: ProtectStep[]; blocked: string | null } {
  const start = savedChoice(saved);
  const capRaw = limitRaw(choice.limitUsd, ctx.capMaxRaw);
  const limitChanged = capRaw !== limitRaw(start.limitUsd, ctx.capMaxRaw);
  const steps: ProtectStep[] = [];
  if (choice.sellOn && choice.never.length >= EQUITIES.length) {
    return { steps, blocked: "Leave at least one stock Protect may sell." };
  }
  if (choice.sellOn && saved.keepMix !== null && choice.keepMix !== saved.keepMix) steps.push({ kind: "keepMix", on: choice.keepMix });
  // Repaying from cash always comes first: while it's off, any save switches it on at the limit on screen.
  if (limitChanged || saved.repayCapRaw === null) steps.push({ kind: "grant", job: "protect", capRaw });
  if (choice.sellOn && (!saved.sell || limitChanged || !sameSet(choice.never, start.never))) {
    steps.push({ kind: "grant", job: "sell", capRaw, limitsRaw: sellLimitsFor(capRaw, ctx.capMaxRaw, ctx.pricesRaw, choice.never) });
  }
  if (!choice.sellOn && saved.sell) steps.push({ kind: "revoke", job: "sell" });
  return { steps, blocked: null };
}

/** How many times a save opens JAW's sheet: once a step, and a revoke once for each sell grant JAW still lists. */
export function stepCount(steps: readonly ProtectStep[], sellGrants: number): number {
  return steps.reduce((n, s) => n + (s.kind === "revoke" ? Math.max(1, sellGrants) : 1), 0);
}
