import { fullRepayAmount } from "@/lib/aave/tx";
import { toUsd } from "@/lib/cash";
import { formatShares } from "@/lib/formatting";
import { homeStatus, statusFor, type Status } from "@/lib/risk/status";
import { freeRepayRaw, planSell, type SellPlan } from "@/lib/sell";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { legOf, type Leg, type QuoteState } from "@/lib/trade";
import { rawToShares } from "@/lib/tokens/b20";
import { REPAY_COPY, blockText, tickerOf } from "./copy";
import type { RepayForm } from "./form";
import {
  allText,
  minRepayUsd,
  repayMax,
  sharesForRepay,
  statusAfter,
  toCents,
  usdcRaw,
  type RepayData,
  type RepaySource,
} from "./sources";

const pct = (f: number) => (f * 100).toFixed(1);

export type RepayView = ReturnType<typeof planRepay>;

type RepayInput = {
  data: RepayData;
  source: RepaySource;
  form: RepayForm;
  maxQuote?: QuoteState<SellQuote>;
  quote?: QuoteState<SellQuote>;
  now?: Date;
};
type RepayAmount = ReturnType<typeof repayAmount>;
type RepaySale = { sharesRaw: bigint; leg: Leg<SellQuote>; sellPlan: SellPlan | null; repayRaw: bigint };

const IDLE = { state: "idle" } as const;

/**
 * The amount on screen: the most the row repays (a stock's from the quote for all its shares), whether it's All (tapped,
 * or typed at the most), the dollars, the field's text, and whether it's under the smallest repay.
 */
function repayAmount(p: RepayInput) {
  const { data, source, form } = p;
  const isStock = source.kind !== "cash" && !!source.stock && !!source.holding;
  const maxLeg: Leg<SellQuote> = isStock ? legOf(p.maxQuote, source.maxSharesRaw) : IDLE;
  const maxQuote = maxLeg.state === "ready" ? maxLeg.quote : maxLeg.state === "none" ? null : undefined;
  const max = repayMax(source, data, maxQuote);
  const min = minRepayUsd(data.debtUsd);
  const typed = Number(form.amount) || 0;
  const all = form.all || (!max.quoting && max.usd > 0 && typed >= toCents(max.usd, max.coversAll));
  const amountUsd = all ? max.usd : typed;
  // Under the smallest repay: typed, or All once the quote shows the row can't reach it.
  const tooSmall = amountUsd > 0 && amountUsd < min - 1e-9 && !(all && max.quoting);
  return { isStock, maxLeg, max, min, all, amountUsd, fieldText: form.all ? allText(max) : form.amount, tooSmall };
}

/**
 * What the row repays. Cash: the amount (or the full repay on All). A stock, once the quote for all its shares is in:
 * the shares that bring the amount, the quote for them, its sale's plan and what that sale is sure to repay.
 */
function repaySale(p: RepayInput, a: RepayAmount): RepaySale {
  const { data, source } = p;
  const { stock, holding: h } = source;
  if (source.kind === "cash")
    return { sharesRaw: 0n, leg: IDLE, sellPlan: null, repayRaw: a.all ? a.max.raw : usdcRaw(a.amountUsd) };
  if (!stock || !h || a.maxLeg.state !== "ready" || !(a.amountUsd > 0) || a.tooSmall)
    return { sharesRaw: 0n, leg: IDLE, sellPlan: null, repayRaw: 0n };
  const full = a.all && a.max.coversAll;
  const sharesRaw =
    a.all && !a.max.coversAll
      ? source.maxSharesRaw
      : sharesForRepay({
          // A full repay aims at what's owed plus Aave's interest buffer, as the batch repays it.
          targetRaw: full ? fullRepayAmount(data.debtRaw, data.debtRaw * 2n + 1n) : usdcRaw(a.amountUsd),
          full,
          feeFromSale: source.feeFromSale,
          maxSharesRaw: source.maxSharesRaw,
          maxQuote: a.maxLeg.quote,
          maxFloorRaw: sellMinOut(a.maxLeg.quote, stock, h.priceUsd),
        });
  const leg = legOf(p.quote, sharesRaw);
  if (leg.state !== "ready") return { sharesRaw, leg, sellPlan: null, repayRaw: 0n };
  const sellPlan = planSell({
    from: source.kind === "free" ? "free" : "repay",
    stock,
    holding: h,
    cf: source.cf,
    position: data,
    quote: leg.quote,
    now: p.now,
  });
  const repayRaw =
    source.kind === "free" ? freeRepayRaw(sellPlan.minOutRaw, data.debtRaw, source.feeFromSale) : sellPlan.repayRaw;
  return { sharesRaw, leg, sellPlan, repayRaw };
}

/** Why it can't go ahead: the amount, then the markets, then the sale's own stops. */
function repayBlock(source: RepaySource, a: RepayAmount, s: RepaySale): string | null {
  if (a.tooSmall) return REPAY_COPY.minRepay(a.min);
  if (a.isStock && a.amountUsd > 0 && (a.maxLeg.state === "none" || s.leg.state === "none"))
    return REPAY_COPY.noMarket(source.name);
  if (s.sellPlan?.block) return blockText(s.sellPlan.block, source, a.min);
  if (a.isStock && s.sellPlan && s.repayRaw <= 0n) return REPAY_COPY.minRepay(a.min);
  return null;
}

/** The status it lands in: the plan's own for a quoted sale, the estimate until then (nothing owed reads Safe). */
function repayAfter(
  p: RepayInput,
  a: RepayAmount,
  s: RepaySale,
  coversAll: boolean,
  repayUsd: number,
): Exclude<Status, "none"> {
  const { data, source } = p;
  if (a.amountUsd <= 0) return homeStatus(data.status);
  if (coversAll) return "safe";
  if (source.kind === "backing" && s.sellPlan) return homeStatus(s.sellPlan.after);
  if (source.kind === "free" && s.sellPlan)
    return homeStatus(statusFor((data.totalBackingUsd * data.avgCf) / (data.debtUsd - repayUsd)));
  return statusAfter(source, a.amountUsd, data);
}

/** The line under the amount: blocked (act), something to look out for, or markets closed (watch). */
function repayNote(blocker: string | null, warn: string | null, closed: boolean) {
  if (blocker) return { text: blocker, tone: "act" as const };
  if (warn) return { text: warn, tone: "watch" as const };
  if (closed) return { text: REPAY_COPY.closed, tone: "watch" as const };
  return null;
}

/** Typed more than the most: it snapped back to All, and one plain line says what that most is. */
function snapTextOf(source: RepaySource, coversAll: boolean): string {
  if (coversAll) return REPAY_COPY.snappedAll;
  return source.kind === "cash" ? REPAY_COPY.snappedCash : REPAY_COPY.snappedStock(source.name);
}

/** "Sells 0.0108 MSFT" under a stock's amount; "Sells …" while quoting. */
function sharesLineOf(source: RepaySource, a: RepayAmount, sharesRaw: bigint): string | null {
  const { stock, holding: h } = source;
  if (!a.isStock || !stock || !h || !(a.amountUsd > 0) || a.tooSmall) return null;
  if (sharesRaw <= 0n) return REPAY_COPY.sellsQuoting;
  return REPAY_COPY.sells(formatShares(rawToShares(sharesRaw, h.multiplier, stock.decimals)), tickerOf(stock.symbol));
}

/** Whether what it repays is known: cash's amount, or a stock's sale quoted, not refreshing, with its plan. */
function signable(source: RepaySource, s: RepaySale): boolean {
  if (source.kind === "cash") return s.repayRaw > 0n;
  return s.leg.state === "ready" && !s.leg.fetching && !!s.sellPlan && s.repayRaw > 0n;
}

/**
 * Everything the sheet shows for the row picked and the amount on screen: the amount field's text, the shares a stock
 * sells, what it repays, what's owed after and its status, who pays the network fee, the line that says why it can't go
 * ahead (or what to look out for), and whether it's ready. A stock reads two quotes: one for all the shares it can sell
 * (`maxQuote`: All, and the floor per share), then one for the shares this amount sells (`quote`).
 */
export function planRepay(p: RepayInput) {
  const { data, source, form } = p;
  const a = repayAmount(p);
  const { max, all, amountUsd } = a;
  const s = repaySale(p, a);
  const { sharesRaw, leg, sellPlan, repayRaw } = s;
  const isCash = source.kind === "cash";
  const coversAll = isCash ? all && max.coversAll : repayRaw > data.debtRaw;
  const repayUsd = isCash ? amountUsd : Math.min(toUsd(repayRaw), data.debtUsd);
  const quoting =
    a.isStock && amountUsd > 0 && !a.tooSmall && (a.maxLeg.state === "quoting" || leg.state === "quoting");

  const blocker = repayBlock(source, a, s);
  const warn = !blocker && sellPlan?.warn ? REPAY_COPY.warn(pct(sellPlan.discount), source.name) : null;
  const closed = !blocker && !warn && !!sellPlan?.priceMayMove;
  const snapped = !!form.snapped && all && !blocker && amountUsd > 0;

  return {
    source,
    max,
    all,
    fieldText: a.fieldText,
    amountUsd,
    /** "Sells 0.0108 MSFT" under a stock's amount; "Sells …" while quoting. */
    sharesLine: sharesLineOf(source, a, sharesRaw),
    sharesRaw,
    quote: leg.state === "ready" ? leg.quote : null,
    sellPlan,
    repayRaw,
    repayUsd,
    coversAll,
    // What's owed after, and the status it lands in.
    oweAfterUsd: Math.max(0, data.debtUsd - (coversAll ? data.debtUsd : repayUsd)),
    after: repayAfter(p, a, s, coversAll, repayUsd),
    /** Under the amount, after typing more than the most: "That’s everything you owe." */
    snapLine: snapped ? snapTextOf(source, max.coversAll) : null,
    quoting,
    blocker,
    note: repayNote(blocker, warn, closed),
    ready: amountUsd > 0 && !blocker && signable(source, s),
    /** The toast once it lands. */
    done: coversAll ? REPAY_COPY.doneAll : REPAY_COPY.done(repayUsd),
  };
}
