import type { Call } from "@/lib/aave/tx";
import type { ActivityItem } from "@/lib/activity/decode";
import { cashRaw, feeBufferRaw, maxSpendRaw, payFromCash, toUsd, type Cash } from "@/lib/cash";
import { buildAddSavingsCalls } from "@/lib/savings";
import { saleActivity, type SellPlan } from "@/lib/sell";
import { assertSalesCoverSave } from "@/lib/sell/covers";
import { QUOTE_MOVED, buildBuyCalls, buyActivity, quoteKey } from "@/lib/swap/buy";
import { buildSellCalls, sellMinOut } from "@/lib/swap/sell";
import { MULTI_COPY, buildTradeCalls, saleBlockText, swapMinUsd, tradeActivity } from "@/lib/trade";
import { TxStop, txKey, type TxPlan } from "../prepared";
import type { SwapReads, TradeSign } from "./trade";

/*
 * Multi trade's batch (lib/trade/multi.ts): every row's own calls, as the Trade sheet signs each alone, in one batch.
 *   [savings withdrawal for the buys] → each buy (approve exactly → swap to the user) → each stock → stock (the sale,
 *   then the buy it pays for) → each sale (approve exactly → swap to USDC for the user) → [one savings supply of what
 *   the sales are sure to bring]
 * Buys spend only the cash there was before the batch (the sales come after them), so no buy leans on a sale's price.
 * What the sales bring goes into savings, as one sale's does (Adrian, 2026-10-18), in one supply of their floors.
 * Every quote is read again before JAW's sheet; every call passes the allowlist with the user pinned.
 */

type Buy = Extract<TradeSign, { route: "buy" }>;
type Sale = Extract<TradeSign, { route: "sell" }>;
type Swap = Extract<TradeSign, { route: "swap" }>;

/** The stock a row spends shares of, and how many (sales and stock → stock); null for a buy. */
const sharesOut = (s: TradeSign): { symbol: string; raw: bigint } | null =>
  s.route === "sell"
    ? { symbol: s.stock.symbol, raw: s.plan.sharesRaw }
    : s.route === "swap"
      ? { symbol: s.from.symbol, raw: s.plan.sharesRaw }
      : null;

/**
 * Why the rows can't go ahead together, though each could alone: the buys together spend more than the cash can (the
 * fuel tank kept back), the cash can't pay the network fee, or the rows together sell more of a stock than is free.
 * Null when they can.
 */
export function multiBlock(
  signs: readonly TradeSign[],
  data: { cash: Cash; holdings: readonly { symbol: string; name: string; freeRaw: bigint }[] },
): string | null {
  if (cashRaw(data.cash) < feeBufferRaw) return MULTI_COPY.fee;
  const buyRaw = signs.reduce((sum, s) => sum + (s.route === "buy" ? s.quote.amountIn : 0n), 0n);
  if (buyRaw > maxSpendRaw(data.cash)) return MULTI_COPY.overCash(toUsd(maxSpendRaw(data.cash)));
  const out = new Map<string, bigint>();
  for (const s of signs) {
    const o = sharesOut(s);
    if (o) out.set(o.symbol, (out.get(o.symbol) ?? 0n) + o.raw);
  }
  for (const [symbol, raw] of out) {
    const h = data.holdings.find((x) => x.symbol === symbol);
    if (!h || raw > h.freeRaw) return MULTI_COPY.overShares(h?.name ?? symbol);
  }
  return null;
}

/** A sale's stop, in the Trade sheet's words (as salePlan and swapBatch stop it). */
function stopFor(plan: SellPlan, swap: boolean) {
  if (plan.block) throw new TxStop(saleBlockText(plan.block, swap, swapMinUsd(1 - plan.discount, false)));
}

/** The batch, from fresh quotes and cash, before JAW's sheet (see the top of this file). */
export async function multiTradeBatch(
  user: `0x${string}`,
  signs: readonly TradeSign[],
  reads: SwapReads,
): Promise<Call[]> {
  const buys = signs.filter((s): s is Buy => s.route === "buy");
  const sales = signs.filter((s): s is Sale => s.route === "sell");
  const swaps = signs.filter((s): s is Swap => s.route === "swap");
  for (const s of sales) stopFor(s.plan, false);
  for (const s of swaps) stopFor(s.plan, true);
  const [buyQuotes, saleQuotes, swapQuotes] = await Promise.all([
    Promise.all(buys.map((b) => reads.quoteToSign(b.stock, b.quote, "buy"))),
    Promise.all(sales.map((s) => reads.quoteToSign(s.stock, s.quote, "sell"))),
    Promise.all(
      swaps.map((s) =>
        Promise.all([reads.quoteToSign(s.from, s.sellQuote, "sell"), reads.quoteToSign(s.to, s.buyQuote, "buy")]),
      ),
    ),
  ]);
  const buyCalls = buys.flatMap((b, i) =>
    buildBuyCalls({ user, stock: b.stock, quote: buyQuotes[i], oraclePriceUsd: b.oraclePriceUsd }),
  );
  const swapCalls = swaps.flatMap((s, i) => {
    const [sellQuote, buyQuote] = swapQuotes[i];
    if (buyQuote.amountIn > sellMinOut(sellQuote, s.from, s.oraclePriceUsd)) throw new TxStop(QUOTE_MOVED);
    return buildTradeCalls({
      user,
      from: s.from,
      to: s.to,
      sellQuote,
      buyQuote,
      oraclePriceUsd: s.oraclePriceUsd,
      toPriceUsd: s.toPriceUsd,
    });
  });
  const saleCalls = sales.flatMap((s, i) =>
    buildSellCalls({ user, stock: s.stock, quote: saleQuotes[i], oraclePriceUsd: s.oraclePriceUsd }),
  );
  // What the sales are sure to bring: each swap's floor, together.
  const saveRaw = sales.reduce((sum, s, i) => sum + sellMinOut(saleQuotes[i], s.stock, s.oraclePriceUsd), 0n);
  const buyRaw = buyQuotes.reduce((sum, q) => sum + q.amountIn, 0n);
  const spend = [...buyCalls, ...swapCalls, ...saleCalls, ...(saveRaw > 0n ? buildAddSavingsCalls(user, saveRaw) : [])];
  if (saveRaw === 0n) return payFromCash(user, buyRaw, await reads.cashToSign(user, buyRaw), spend);
  // The supply is the sales' own: checked from the decoded calls, as a single sale's is (lib/sell/covers.ts).
  const calls = payFromCash(user, buyRaw, await reads.cashToSign(user, buyRaw), spend, { saveTo: user });
  return assertSalesCoverSave(user, calls, sales.length);
}

/** What Activity shows while the rows confirm: each row's own items, in list order. */
export function multiActivity(signs: readonly TradeSign[]): ActivityItem[] {
  return signs.flatMap((s) =>
    s.route === "buy"
      ? buyActivity(s.stock, s.quote)
      : s.route === "sell"
        ? saleActivity(s.stock, s.plan)
        : tradeActivity({ from: s.from, to: s.to, plan: s.plan, buyQuote: s.buyQuote }),
  );
}

/** One row's part of the key: what shapes its calls (its legs, quotes and floors), as each route's own plan keys it. */
const rowKey = (s: TradeSign) =>
  s.route === "buy"
    ? ["buy", s.stock.symbol, quoteKey(s.quote), s.oraclePriceUsd]
    : s.route === "sell"
      ? [
          "sell",
          s.stock.symbol,
          quoteKey(s.quote),
          sellMinOut(s.quote, s.stock, s.oraclePriceUsd),
          s.plan.block ?? null,
        ]
      : [
          "swap",
          s.from.symbol,
          s.to.symbol,
          quoteKey(s.sellQuote),
          sellMinOut(s.sellQuote, s.from, s.oraclePriceUsd),
          quoteKey(s.buyQuote),
          s.toPriceUsd,
          s.plan.block ?? null,
        ];

/** What the list signs (useTx): keyed by every row, in order, so another list is another batch. */
export const multiTradePlan = (user: `0x${string}`, signs: readonly TradeSign[], reads: SwapReads): TxPlan => ({
  key: txKey("multi", user, signs.map(rowKey)),
  user,
  calls: () => multiTradeBatch(user, signs, reads),
  fallback: MULTI_COPY.fallback,
  activity: multiActivity(signs),
});

/**
 * What the editor can still use while the list holds other trades (Adrian, 2026-10-22: "cash available should
 * decrease if I used it in another trade"): the cash less what the other rows' buys spend (out of the wallet first,
 * as the batch pays), and each stock's free shares less what the other rows sell of it. Their sales' cash isn't
 * counted in: multiBlock doesn't count it either, so what the editor offers is what the list can sign.
 */
export function leftAfter<
  D extends {
    cash: Cash;
    cashUsd: number;
    holdings: readonly { symbol: string; freeRaw: bigint; freeShares: number; freeUsd: number }[];
  },
>(data: D, others: readonly TradeSign[]): D {
  if (others.length === 0) return data;
  const spend = others.reduce((sum, s) => sum + (s.route === "buy" ? s.quote.amountIn : 0n), 0n);
  const fromWallet = spend < data.cash.walletRaw ? spend : data.cash.walletRaw;
  const rest = spend - fromWallet;
  const cash: Cash = {
    ...data.cash,
    walletRaw: data.cash.walletRaw - fromWallet,
    savingsRaw: rest < data.cash.savingsRaw ? data.cash.savingsRaw - rest : 0n,
  };
  const sold = new Map<string, bigint>();
  for (const s of others) {
    const o = sharesOut(s);
    if (o) sold.set(o.symbol, (sold.get(o.symbol) ?? 0n) + o.raw);
  }
  const holdings = data.holdings.map((h) => {
    const out = sold.get(h.symbol);
    if (!out || h.freeRaw === 0n) return h;
    const freeRaw = out < h.freeRaw ? h.freeRaw - out : 0n;
    const share = Number(freeRaw) / Number(h.freeRaw);
    return { ...h, freeRaw, freeShares: h.freeShares * share, freeUsd: h.freeUsd * share };
  });
  return { ...data, cash, cashUsd: data.cashUsd - toUsd(cashRaw(data.cash) - cashRaw(cash)), holdings };
}

/** A key for what the other rows hold back (`leftAfter`), so the editor re-reads only when it changes. */
export const leftKey = (others: readonly TradeSign[]) =>
  others
    .map((s) => {
      const o = sharesOut(s);
      return `${s.route === "buy" ? s.quote.amountIn : 0n}:${o ? `${o.symbol}${o.raw}` : ""}`;
    })
    .join("|");
