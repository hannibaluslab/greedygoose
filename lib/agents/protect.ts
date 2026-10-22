import { EQUITIES } from "@/lib/tokens/registry";
import { stockLimitsRaw, type StockLimits } from "@/lib/agents/permissions";

/*
 * Protect's settings (the agent sheet, JUSTALAB-DECISIONS.md "From the Agents redesign"): repay from cash (job 1, always
 * first), selling backing stock as its own grant (job 2, decision 5), what it sells first (GooseGuard's `keepMix`) and
 * the never-sell list (stocks left out of the sell grant). No amount limit (decision 9): there is no limit to choose.
 * Pure, so the steps a save takes are tested.
 */

/** What the chain says Protect runs with now. */
export type ProtectSaved = {
  /** Repay from cash: on (or starting). */
  repayOn: boolean;
  /** Selling: the stocks its grant may sell, while on (or starting); null while off. */
  sell: { limitsRaw: StockLimits } | null;
  /** GooseGuard's "Keep my mix"; null until read (or with no Guard). */
  keepMix: boolean | null;
};

/** What the screen shows: the saved settings until the user changes one. */
export type ProtectChoice = { sellOn: boolean; keepMix: boolean; never: readonly number[] };

/**
 * What a save changes: "Sells first" (GooseGuard's `setKeepMix`), a new grant, or selling's turn-off, all in one
 * batch, one Face ID (`protectBatch`).
 */
export type ProtectStep =
  | { kind: "keepMix"; on: boolean }
  | { kind: "grant"; job: "protect" }
  | { kind: "grant"; job: "sell"; limitsRaw: StockLimits }
  | { kind: "revoke"; job: "sell" };

/** Protect's two jobs: repaying from cash, and selling backing stock. */
type ProtectJob = "protect" | "sell";

/** The stocks a sell grant leaves out (no approve), by reserve id. */
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
 * The sell grant for a never-sell set: every stock but those, with no limit (`stockLimitsRaw`), so a stock bought and
 * used as backing later is covered without a new grant.
 */
export function sellLimitsFor(never: readonly number[]): StockLimits {
  return stockLimitsRaw(EQUITIES.map((e) => !never.includes(e.reserveId)));
}

/**
 * What saving `choice` takes, in order, from what is `saved`: "Sells first" (only while selling stays on), then the
 * repay grant while it's off (saving switches Protect on), then the sell grant (switched on, or its never-sell list
 * changed) or its turn-off. No grant has a limit. `blocked` says why it can't save: every stock is on the never-sell
 * list.
 */
export function protectSteps(
  saved: ProtectSaved,
  choice: ProtectChoice,
): { steps: ProtectStep[]; blocked: string | null } {
  const start = savedChoice(saved);
  const steps: ProtectStep[] = [];
  if (choice.sellOn && choice.never.length >= EQUITIES.length) {
    return { steps, blocked: "Leave at least one stock Protector may sell." };
  }
  if (choice.sellOn && saved.keepMix !== null && choice.keepMix !== saved.keepMix)
    steps.push({ kind: "keepMix", on: choice.keepMix });
  // Repaying from cash always comes first: while it's off, any save switches it on.
  if (!saved.repayOn) steps.push({ kind: "grant", job: "protect" });
  if (choice.sellOn && (!saved.sell || !sameSet(choice.never, start.never)))
    steps.push({ kind: "grant", job: "sell", limitsRaw: sellLimitsFor(choice.never) });
  if (!choice.sellOn && saved.sell) steps.push({ kind: "revoke", job: "sell" });
  return { steps, blocked: null };
}

/**
 * A save's one batch (Adrian, 2026-10-20: "the permission, the cash move and the registration in one signature"): its
 * new grants, each approved and registered (and the grant each replaces revoked), selling's turn-off (revoked and
 * unregistered) when it's switched off, and "Sells first" when it changed; null when there's nothing to save.
 * useProtectSave signs it through useTx (useAgents `changePlan`).
 */
export function protectBatch(steps: readonly ProtectStep[]): {
  grants: { job: ProtectJob; limitsRaw?: StockLimits }[];
  off: ProtectJob[];
  keepMix?: boolean;
} | null {
  if (steps.length === 0) return null;
  const grants = steps.flatMap((s) =>
    s.kind === "grant" ? [{ job: s.job, ...(s.job === "sell" && { limitsRaw: s.limitsRaw }) }] : [],
  );
  const off = steps.flatMap((s) => (s.kind === "revoke" ? [s.job] : []));
  const keep = steps.find((s) => s.kind === "keepMix");
  return { grants, off, ...(keep && { keepMix: keep.on }) };
}

/**
 * What the save's one Face ID lets Protect do, said on our card before the tap (JAW's batch sheet shows no words of
 * ours): null when the save grants nothing. `never`: the stocks it may never sell, by name. Never names the machinery.
 */
export function protectAllows(steps: readonly ProtectStep[], line: string, never: string | null): string | null {
  const grants = protectBatch(steps)?.grants ?? [];
  if (grants.length === 0) return null;
  const repays = grants.some((g) => g.job === "protect");
  const sells = grants.some((g) => g.job === "sell");
  const not = never ? `, never ${never}` : "";
  const repay = `Protector can repay from your cash if your credit falls under ${line}, for a year.`;
  if (!sells) return `${repay} You can turn it off here.`;
  // Selling's grant alone: repaying keeps the grant it has, with its own end.
  if (!repays)
    return `If cash isn’t enough, Protector can also sell stock that backs your credit${not}, for a year. You can turn it off here.`;
  return `${repay} If cash isn’t enough, it can also sell stock that backs your credit${not}. You can turn it off here.`;
}
