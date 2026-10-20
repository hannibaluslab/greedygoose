import { MIX_WHOLE, type MixHolding } from "@/lib/agents/mix";
import type { StockLimits } from "@/lib/agents/permissions";
import type { RebalanceTrade } from "@/lib/agents/rules/rebalance";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

/**
 * The Rebalancer's settings in its agent sheet (agents-redesign spec): what its next run would trade, and what saving
 * takes (`rebalanceSteps`). Saving is one batch, one Face ID (Adrian, 2026-10-20: "the permission, the cash move and
 * the registration in one signature"): the mix (`setMix`, when it changed) and a new grant when one is needed (none
 * yet, one capped below the executor's CAP_MAX from before the Rebalancer had no amount limit, or a stock in the mix
 * has no sell limit in it), approved and registered, with the grant it replaces revoked.
 */

/** What saving runs: one batch when anything changed, else nothing. useManageSave sends exactly it. */
export function rebalanceSteps(p: { needsGrant: boolean; mixChanged: boolean }): "batch"[] {
  return p.needsGrant || p.mixChanged ? ["batch"] : [];
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

/** What the Rebalancer runs with now: its grant's USDC limit and each stock's, while it has one. */
export type RebalanceTerms = { capRaw: bigint; limitsRaw?: StockLimits } | null | undefined;

export type SavePlan = {
  mixChanged: boolean;
  needsGrant: boolean;
  /** How many times saving opens JAW's sheet (0 when there is nothing to save). */
  steps: number;
  canSave: boolean;
  /** Why it can't save, under the button; null when it can. */
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
  /** The executor's CAP_MAX, what a grant made now carries (no amount limit); null before it is read. */
  capMaxRaw: bigint | null;
  /** Whether the Rebalancer runs now (on, or registering). */
  running: boolean;
  feeBlocked: boolean;
  feeLoading: boolean;
  busy: boolean;
}): SavePlan {
  const whole = p.weights.reduce((a, b) => a + b, 0) === MIX_WHOLE;
  const mixChanged = p.configured && p.saved !== null && p.weights.some((w, r) => w !== p.saved![r]);
  // A grant capped below CAP_MAX is from before the Rebalancer had no amount limit: the next Save grants it again.
  const needsGrant =
    p.configured &&
    (!p.terms ||
      (p.capMaxRaw !== null && p.terms.capRaw !== p.capMaxRaw) ||
      p.weights.some((w, r) => w > 0 && !((p.terms!.limitsRaw?.[r] ?? 0n) > 0n)));
  const steps = rebalanceSteps({ needsGrant, mixChanged }).length;
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

/**
 * What a Save's one Face ID lets Rebalance do when it grants (JAW's batch sheet shows no words of ours). With top-ups
 * on, it also puts the cash above what the user keeps into the mix, so the line says so (`topUps`, to build).
 */
export function rebalanceAllows(topUps?: { keepUsd: string }): string {
  return topUps
    ? `Rebalance can trade your stocks toward your mix, and put your top-ups above ${topUps.keepUsd} into it, for a year. You can turn it off here.`
    : "Rebalance can trade your stocks toward your mix, for a year. It never spends your cash. You can turn it off here.";
}
