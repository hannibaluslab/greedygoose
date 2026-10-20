import { EQUITIES } from "@/lib/tokens/registry";
import { stockLimitsRaw, type StockLimits } from "@/lib/agents/permissions";

/*
 * Protect's settings (the agent sheet, docs/agents-redesign): repay from cash (Job.Protect, always first), selling
 * backing stock as its own grant (Job.ProtectSell, decision 5), what it sells first (the registry's `keepMix`) and the
 * never-sell list (stocks left out of the sell grant). No amount limit (Adrian, 2026-10-19): both grants carry the
 * executor's CAP_MAX, and there is no limit to choose. Pure, so the steps a save takes are tested.
 */

/** What the chain says Protect runs with now. */
export type ProtectSaved = {
  /** Repay from cash: on (or starting). */
  repayOn: boolean;
  /** Selling: each stock's limit in its grant, while on (or starting); null while off. */
  sell: { limitsRaw: StockLimits } | null;
  /** The registry's "Keep my mix"; null until read (or with no executor). */
  keepMix: boolean | null;
};

/** What the screen shows: the saved settings until the user changes one. */
export type ProtectChoice = { sellOn: boolean; keepMix: boolean; never: readonly number[] };

/**
 * One JAW sheet each: the registry setting through useTx, each grant or revoke on JAW's own screen (D14), and a
 * change's last batch (`withRegistration`): its "Sells first" and the registration of the jobs it granted.
 */
export type ProtectStep =
  | { kind: "keepMix"; on: boolean }
  | { kind: "grant"; job: "protect"; capRaw: bigint }
  | { kind: "grant"; job: "sell"; capRaw: bigint; limitsRaw: StockLimits }
  | { kind: "revoke"; job: "sell" }
  | { kind: "register"; jobs: ProtectJob[]; keepMix?: boolean };

/** Protect's two jobs: repaying from cash, and selling backing stock. */
export type ProtectJob = "protect" | "sell";

/** The stocks a sell grant leaves out (limit 0), by reserve id. */
export function neverSellOf(limitsRaw: StockLimits | null | undefined): number[] {
  return limitsRaw ? EQUITIES.filter((e) => limitsRaw[e.reserveId] === 0n).map((e) => e.reserveId) : [];
}

/** The screen's starting point: what's saved. */
export function savedChoice(saved: ProtectSaved): ProtectChoice {
  return {
    sellOn: saved.sell !== null,
    keepMix: saved.keepMix ?? false,
    never: neverSellOf(saved.sell?.limitsRaw),
  };
}

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((r) => b.includes(r));

/**
 * The sell grant for a never-sell set: every stock but those, each at shares worth twice CAP_MAX at Aave's price, held
 * to what the grant's terms can hold (`stockLimitsRaw`), so a stock bought and used as backing later is covered
 * without a new grant.
 */
export function sellLimitsFor(capMaxRaw: bigint, pricesRaw: readonly bigint[], never: readonly number[]): StockLimits {
  return stockLimitsRaw(
    capMaxRaw,
    capMaxRaw,
    pricesRaw,
    EQUITIES.map((e) => !never.includes(e.reserveId)),
  );
}

/**
 * What saving `choice` takes, in order, from what is `saved`: "Sells first" (only while selling stays on), then the
 * repay grant while it's off (saving switches Protect on), then the sell grant (switched on, or its never-sell list
 * changed) or its revoke. Every grant is at the executor's CAP_MAX. `blocked` says why it can't save: every stock is
 * on the never-sell list.
 */
export function protectSteps(
  saved: ProtectSaved,
  choice: ProtectChoice,
  ctx: { capMaxRaw: bigint; pricesRaw: readonly bigint[] },
): { steps: ProtectStep[]; blocked: string | null } {
  const start = savedChoice(saved);
  const steps: ProtectStep[] = [];
  if (choice.sellOn && choice.never.length >= EQUITIES.length) {
    return { steps, blocked: "Leave at least one stock Protect may sell." };
  }
  if (choice.sellOn && saved.keepMix !== null && choice.keepMix !== saved.keepMix)
    steps.push({ kind: "keepMix", on: choice.keepMix });
  // Repaying from cash always comes first: while it's off, any save switches it on.
  if (!saved.repayOn) steps.push({ kind: "grant", job: "protect", capRaw: ctx.capMaxRaw });
  if (choice.sellOn && (!saved.sell || !sameSet(choice.never, start.never))) {
    steps.push({
      kind: "grant",
      job: "sell",
      capRaw: ctx.capMaxRaw,
      limitsRaw: sellLimitsFor(ctx.capMaxRaw, ctx.pricesRaw, choice.never),
    });
  }
  if (!choice.sellOn && saved.sell) steps.push({ kind: "revoke", job: "sell" });
  return { steps, blocked: null };
}

/**
 * A save as it runs (Adrian, 2026-10-20: "Batch those into one"): when it grants anything, or this sheet's grants still
 * wait for their batch (`waiting`: one that didn't go through; a grant from anywhere else is the Finish card's), its
 * grants and revokes in order, then one batch with "Sells first" (when it changed) and the registration of every job
 * granted or waiting, except one it revokes. With
 * nothing to register, the steps as they are: "Sells first" on its own, first.
 */
export function withRegistration(steps: readonly ProtectStep[], waiting: readonly ProtectJob[] = []): ProtectStep[] {
  const revoked: ProtectJob[] = steps.flatMap((s) => (s.kind === "revoke" ? [s.job] : []));
  const granted: ProtectJob[] = steps.flatMap((s) => (s.kind === "grant" ? [s.job] : []));
  const jobs = (["protect", "sell"] as const).filter(
    (j) => granted.includes(j) || (waiting.includes(j) && !revoked.includes(j)),
  );
  if (jobs.length === 0) return [...steps];
  const keep = steps.find((s) => s.kind === "keepMix");
  return [
    ...steps.filter((s) => s.kind !== "keepMix" && s.kind !== "register"),
    { kind: "register", jobs, ...(keep && { keepMix: keep.on }) },
  ];
}

/**
 * How many times a save opens JAW's sheet, as it runs (`withRegistration`): once a step, and a revoke once for each
 * sell grant JAW still lists.
 */
export function stepCount(
  steps: readonly ProtectStep[],
  sellGrants: number,
  waiting: readonly ProtectJob[] = [],
): number {
  return withRegistration(steps, waiting).reduce((n, s) => n + (s.kind === "revoke" ? Math.max(1, sellGrants) : 1), 0);
}
