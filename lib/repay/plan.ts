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

/**
 * Everything the sheet shows for the row picked and the amount on screen: the amount field's text, the shares a stock
 * sells, what it repays, what's owed after and its status, who pays the network fee, the line that says why it can't go
 * ahead (or what to look out for), and whether it's ready. A stock reads two quotes: one for all the shares it can sell
 * (`maxQuote`: All, and the floor per share), then one for the shares this amount sells (`quote`).
 */
export function planRepay(p: {
  data: RepayData;
  source: RepaySource;
  form: RepayForm;
  maxQuote?: QuoteState<SellQuote>;
  quote?: QuoteState<SellQuote>;
  now?: Date;
}) {
  const { data, source, form } = p;
  const stock = source.stock;
  const h = source.holding;
  const isStock = source.kind !== "cash" && !!stock && !!h;
  const maxLeg = isStock ? legOf(p.maxQuote, source.maxSharesRaw) : ({ state: "idle" } as const);
  const maxQuote = maxLeg.state === "ready" ? maxLeg.quote : maxLeg.state === "none" ? null : undefined;
  const max = repayMax(source, data, maxQuote);
  const min = minRepayUsd(data.debtUsd);
  const typed = Number(form.amount) || 0;
  const all = form.all || (!max.quoting && max.usd > 0 && typed >= toCents(max.usd, max.coversAll));
  const amountUsd = all ? max.usd : typed;
  const fieldText = form.all ? allText(max) : form.amount;
  // Under the smallest repay: typed, or All once the quote shows the row can't reach it.
  const tooSmall = amountUsd > 0 && amountUsd < min - 1e-9 && !(all && max.quoting);

  let sharesRaw = 0n;
  let sellPlan: SellPlan | null = null;
  let leg: Leg<SellQuote> = { state: "idle" };
  let repayRaw = 0n;
  if (source.kind === "cash") {
    repayRaw = all ? max.raw : usdcRaw(amountUsd);
  } else if (isStock && maxLeg.state === "ready" && amountUsd > 0 && !tooSmall) {
    const full = all && max.coversAll;
    sharesRaw =
      all && !max.coversAll
        ? source.maxSharesRaw
        : sharesForRepay({
            // A full repay aims at what's owed plus Aave's interest buffer, as the batch repays it.
            targetRaw: full ? fullRepayAmount(data.debtRaw, data.debtRaw * 2n + 1n) : usdcRaw(amountUsd),
            full,
            feeFromSale: source.feeFromSale,
            maxSharesRaw: source.maxSharesRaw,
            maxQuote: maxLeg.quote,
            maxFloorRaw: sellMinOut(maxLeg.quote, stock!, h!.priceUsd),
          });
    leg = legOf(p.quote, sharesRaw);
    if (leg.state === "ready") {
      sellPlan = planSell({
        from: source.kind === "free" ? "free" : "repay",
        stock: stock!,
        holding: h!,
        cf: source.cf,
        position: data,
        quote: leg.quote,
        now: p.now,
      });
      repayRaw =
        source.kind === "free" ? freeRepayRaw(sellPlan.minOutRaw, data.debtRaw, source.feeFromSale) : sellPlan.repayRaw;
    }
  }
  const coversAll = source.kind === "cash" ? all && max.coversAll : repayRaw > data.debtRaw;
  const repayUsd = source.kind === "cash" ? amountUsd : Math.min(toUsd(repayRaw), data.debtUsd);
  const quoting = isStock && amountUsd > 0 && !tooSmall && (maxLeg.state === "quoting" || leg.state === "quoting");

  // Why it can't go ahead: the amount, then the markets, then the sale's own stops.
  let blocker: string | null = null;
  if (tooSmall) blocker = REPAY_COPY.minRepay(min);
  else if (isStock && amountUsd > 0 && (maxLeg.state === "none" || leg.state === "none"))
    blocker = REPAY_COPY.noMarket(source.name);
  else if (sellPlan?.block) blocker = blockText(sellPlan.block, source, min);
  else if (isStock && sellPlan && repayRaw <= 0n) blocker = REPAY_COPY.minRepay(min);
  const warn = !blocker && sellPlan?.warn ? REPAY_COPY.warn(pct(sellPlan.discount), source.name) : null;
  const closed = !blocker && !warn && !!sellPlan?.priceMayMove;
  // Typed more than the most: it snapped back to All, and one plain line says what that most is.
  const snapped = !!form.snapped && all && !blocker && amountUsd > 0;
  const snapText = max.coversAll
    ? REPAY_COPY.snappedAll
    : source.kind === "cash"
      ? REPAY_COPY.snappedCash
      : REPAY_COPY.snappedStock(source.name);
  const note = blocker
    ? { text: blocker, tone: "act" as const }
    : warn
      ? { text: warn, tone: "watch" as const }
      : closed
        ? { text: REPAY_COPY.closed, tone: "watch" as const }
        : null;

  // What's owed after, and the status it lands in: the plan's own for a quoted sale, the estimate until then.
  const oweAfterUsd = Math.max(0, data.debtUsd - (coversAll ? data.debtUsd : repayUsd));
  const after: Exclude<Status, "none"> =
    amountUsd <= 0
      ? homeStatus(data.status)
      : coversAll
        ? "safe"
        : source.kind === "backing" && sellPlan
          ? homeStatus(sellPlan.after)
          : source.kind === "free" && sellPlan
            ? homeStatus(statusFor((data.totalBackingUsd * data.avgCf) / (data.debtUsd - repayUsd)))
            : statusAfter(source, amountUsd, data);

  const ready =
    amountUsd > 0 &&
    !blocker &&
    (source.kind === "cash" ? repayRaw > 0n : leg.state === "ready" && !leg.fetching && !!sellPlan && repayRaw > 0n);

  const shares =
    isStock && sharesRaw > 0n ? formatShares(rawToShares(sharesRaw, h!.multiplier, stock!.decimals)) : null;
  return {
    source,
    max,
    all,
    fieldText,
    amountUsd,
    /** "Sells 0.0108 MSFT" under a stock's amount; "Sells …" while quoting. */
    sharesLine:
      isStock && amountUsd > 0 && !tooSmall
        ? shares
          ? REPAY_COPY.sells(shares, tickerOf(stock!.symbol))
          : REPAY_COPY.sellsQuoting
        : null,
    sharesRaw,
    quote: leg.state === "ready" ? leg.quote : null,
    sellPlan,
    repayRaw,
    repayUsd,
    coversAll,
    oweAfterUsd,
    after,
    /** Under the amount, after typing more than the most: "That’s everything you owe." */
    snapLine: snapped ? snapText : null,
    quoting,
    blocker,
    note,
    ready,
    /** The toast once it lands. */
    done: coversAll ? REPAY_COPY.doneAll : REPAY_COPY.done(repayUsd),
  };
}
