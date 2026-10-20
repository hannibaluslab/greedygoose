import { MIX_WHOLE, type MixHolding } from "@/lib/agents/mix";
import type { StockLimits } from "@/lib/agents/permissions";
import type { RebalanceTrade } from "@/lib/agents/rules/rebalance";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

/**
 * The Rebalancer's settings in its agent sheet (agents-redesign spec): what its next run would trade, and what saving
 * takes (`rebalanceSteps`). A new grant (none yet, the weekly limit changed, or a stock in the mix has no sell limit in
 * it) opens JAW's sheet, then one batch carries the mix (`setMix`, when it changed) and the grant's registration; with
 * no grant, the mix alone (Adrian, 2026-10-20: "Batch those into one").
 */

/**
 * What saving runs, one JAW sheet each: the grant then the batch, the batch alone when this sheet's grant is still
 * waiting for it (`waiting`: a batch that didn't go through), the mix alone, or nothing. useManageSave runs exactly
 * these, so the count the button shows is what opens.
 */
export function rebalanceSteps(p: {
  needsGrant: boolean;
  mixChanged: boolean;
  waiting: boolean;
}): ("grant" | "batch" | "mix")[] {
  if (p.needsGrant) return ["grant", "batch"];
  if (p.waiting) return ["batch"];
  return p.mixChanged ? ["mix"] : [];
}

/** One trade of the preview: sells first, then buys, each largest first, in whole dollars at Aave's price. */
type TradeLine = { reserveId: number; name: string; buy: boolean; usd: number };

export function tradeLines(trades: readonly RebalanceTrade[], holdings: readonly MixHolding[]): TradeLine[] {
  const usd = (t: RebalanceTrade) => {
    const price = holdings.find((h) => h.reserveId === t.reserveId)?.priceRaw ?? 0n;
    const raw = t.buy ? t.amountIn : (t.amountIn * price) / 10n ** 10n;
    return Math.round(Number(raw) / 10 ** USDC.decimals);
  };
  return trades
    .map((t) => ({ reserveId: t.reserveId, name: EQUITIES[t.reserveId].name, buy: t.buy, usd: usd(t) }))
    .filter((l) => l.usd > 0)
    .sort((a, b) => Number(a.buy) - Number(b.buy) || b.usd - a.usd);
}

/** What the Rebalancer runs with now: its grant's weekly limit and each stock's, while it has one. */
export type RebalanceTerms = { capRaw: bigint; limitsRaw?: StockLimits } | null | undefined;

export type SavePlan = {
  mixChanged: boolean;
  needsGrant: boolean;
  /** How many times saving opens JAW's sheet (0 when there is nothing to save). */
  steps: number;
  canSave: boolean;
  /** Why it can't save, under the button; null when it can (the button says "2 steps" itself). */
  note: string | null;
};

export function rebalanceSave(p: {
  configured: boolean;
  connected: boolean;
  /** The registry's mix, BPS by reserve id (all 0 before one is saved); null before it is read. */
  saved: readonly number[] | null;
  /** The mix on screen, BPS by reserve id. */
  weights: readonly number[];
  terms: RebalanceTerms;
  /** The weekly limit chosen, in USDC units. */
  capRaw: bigint;
  capMaxRaw: bigint | null;
  /** Whether the Rebalancer runs now (on, or registering). */
  running: boolean;
  /** This sheet's grant landed and its batch didn't: Save sends that batch (useManageSave `registering`). */
  waiting?: boolean;
  feeBlocked: boolean;
  feeLoading: boolean;
  busy: boolean;
}): SavePlan {
  const whole = p.weights.reduce((a, b) => a + b, 0) === MIX_WHOLE;
  const mixChanged = p.configured && p.saved !== null && p.weights.some((w, r) => w !== p.saved![r]);
  const needsGrant =
    p.configured &&
    (!p.terms ||
      p.terms.capRaw !== p.capRaw ||
      p.weights.some((w, r) => w > 0 && !((p.terms!.limitsRaw?.[r] ?? 0n) > 0n)));
  const steps = rebalanceSteps({ needsGrant, mixChanged, waiting: !!p.waiting }).length;
  const canSave =
    p.configured &&
    p.connected &&
    whole &&
    steps > 0 &&
    p.capMaxRaw !== null &&
    !p.feeBlocked &&
    !p.feeLoading &&
    !p.busy;

  const note = !p.configured
    ? "Not live yet"
    : p.connected && p.feeBlocked
      ? "Your account can’t pay network fees from your cash right now."
      : !whole
        ? "Make your mix add up to 100% to save it."
        : null;

  return { mixChanged, needsGrant, steps, canSave, note };
}
