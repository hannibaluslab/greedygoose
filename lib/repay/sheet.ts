import { freeAll, planFreeUp } from "@/lib/freeUpPlan";
import { EQUITIES } from "@/lib/tokens/registry";
import { REPAY_COPY, repaySheetSmallPrint } from "./copy";
import type { RepayView } from "./plan";
import type { RepayData, RepayHolding, RepaySource } from "./sources";

/*
 * The Repay sheet's free-up part (canvas boards 1–8): the stocks that back credit, ticked under "Also free up stocks"
 * and taken out in the same signature as the repay, all under one limit at the position's line (lib/freeUpPlan.ts). Pure, so
 * the sheet holds no money maths.
 */

/** A stock ticked under "Also free up stocks": its share, and the repay it was ticked at (see `pricesMoved`). */
export type FreeUpTick = { symbol: string; share: number; atRepayUsd: number };

type SheetData<H> = Omit<RepayData, "holdings"> & { holdings: H[] };
type Plan = ReturnType<typeof planFreeUp>;

const namesOf = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Power that leaves with the repay itself: a stock that backs credit, sold to pay (the shares the sale sells at Aave's
 * price × its factor).
 */
function soldPowerOf(source: RepaySource | null, view: RepayView | null, cfs: Record<string, number> | undefined) {
  if (source?.kind !== "backing" || !view?.sellPlan || !source.stock || !source.holding || !cfs) return 0;
  return (
    (Number(view.sellPlan.sharesRaw) / 10 ** source.stock.decimals) *
    source.holding.priceUsd *
    (cfs[source.stock.symbol] ?? 0)
  );
}

/** Prices moved under a ticked stock: the limit shrank with the repay unchanged, so its amount was cut. */
function pricesMoved(plan: Plan, ticks: readonly FreeUpTick[], repayUsd: number): boolean {
  return ticks.some((p) => {
    const row = plan.rows.find((r) => r.symbol === p.symbol);
    return !!row?.picked && row.share < p.share - 1e-6 && Math.abs(p.atRepayUsd - repayUsd) < 1e-9;
  });
}

/** The button: Repay all, Repay & free up, Free up, or Repay. */
function repayLabel(repaysAll: boolean, freesAny: boolean, repayUsd: number): string {
  if (repaysAll) return "Repay all";
  if (!freesAny) return REPAY_COPY.button;
  return repayUsd > 0 ? "Repay & free up" : "Free up";
}

/** The toast once it lands: what was repaid, and the stocks freed up. */
function doneLineOf(p: {
  repaysAll: boolean;
  repayUsd: number;
  view: RepayView | null;
  freedNames: string[];
  allOut: boolean;
}): string {
  const n = p.freedNames.length;
  const back = n ? `${namesOf(p.freedNames)} ${p.allOut ? (n > 1 ? "are free" : "is free") : "freed up"}` : "";
  if (p.repaysAll) return REPAY_COPY.doneAll;
  if (p.repayUsd > 0 && p.view) return back ? `${p.view.done} · ${back}` : p.view.done;
  return back.charAt(0).toUpperCase() + back.slice(1);
}

/**
 * Everything the sheet shows and signs beyond the row's own view: the stocks that back credit and can be ticked (one
 * being sold to pay can't be ticked too, but Repay all still takes what's left of it out, after the sale), the free-up
 * plan, the take-outs to sign, whether anything changes, the small print (D7: the repay's moves, then each stock that
 * comes out of backing), whether prices moved under a tick and the risk tick is needed, the button and the toast.
 */
export function planRepaySheet<H extends RepayHolding & { backingShares: number }>(p: {
  data: SheetData<H> | undefined;
  cfs: Record<string, number> | undefined;
  source: RepaySource | null;
  view: RepayView | null;
  ticks: readonly FreeUpTick[];
}) {
  const { data, cfs, source, view } = p;
  const repayUsd = view ? view.repayUsd || view.amountUsd : 0;
  const repaysAll = !!view && view.coversAll && view.amountUsd > 0;
  const selling = source?.kind === "backing" ? source.stock?.symbol : undefined;
  const backing = (data?.holdings ?? []).filter(
    (h) => h.backingRaw > 0n && cfs?.[h.symbol] !== undefined && (repaysAll || h.symbol !== selling),
  );
  const stocks = backing.map((h) => ({
    symbol: h.symbol,
    backingRaw: h.backingRaw,
    backingUsd: h.backingUsd,
    cf: cfs?.[h.symbol] ?? 0,
    paused: h.paused,
  }));
  const plan = data
    ? planFreeUp({
        position: data,
        repayUsd,
        repaysAll,
        repayPowerOutUsd: soldPowerOf(source, view, cfs),
        stocks,
        picks: repaysAll ? freeAll(stocks) : p.ticks,
      })
    : null;
  const takeOuts = (plan?.frees ?? []).flatMap((f) => {
    const asset = EQUITIES.find((e) => e.symbol === f.symbol);
    return asset ? [{ stock: asset, amountRaw: f.raw, all: f.all }] : [];
  });
  const changes = !!plan && (repayUsd > 0 || takeOuts.length > 0);
  const smallPrint = changes
    ? repaySheetSmallPrint(
        view?.ready ? view : null,
        takeOuts.map((t) => ({
          ...t,
          multiplier: data?.holdings.find((h) => h.symbol === t.stock.symbol)?.multiplier ?? 10n ** 18n,
        })),
      )
    : null;
  const freed = (plan?.rows ?? []).filter((r) => r.picked);
  const freedNames = freed.map((r) => backing.find((h) => h.symbol === r.symbol)?.name ?? r.symbol);
  return {
    repayUsd,
    repaysAll,
    backing,
    stocks,
    plan,
    takeOuts,
    changes,
    smallPrint,
    moved: !!plan && pricesMoved(plan, p.ticks, repayUsd),
    /** A free-up that ends in Watch asks for one tick. */
    needsTick: asksTick(plan) && takeOuts.length > 0,
    label: repayLabel(repaysAll, takeOuts.length > 0, repayUsd),
    doneLine: doneLineOf({ repaysAll, repayUsd, view, freedNames, allOut: freed.every((r) => r.all) }),
  };
}

/** The free-up asks for the tick: it ends in Watch, or in Act where the line allows it. */
const asksTick = (plan: Plan | null) => !!plan && (plan.risky || plan.intoAct);
