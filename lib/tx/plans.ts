import { isAddressEqual } from "viem";
import { buildWithdrawCalls, type Call } from "@/lib/aave/tx";
import { payFromCash, type Cash } from "@/lib/cash";
import { SEND_COPY, sendActivity, type Recipient } from "@/lib/send";
import { TRADE_COPY, buildTradeCalls, saleBlockText, swapMinUsd, tradeActivity } from "@/lib/trade";
import { freeRepayActivity, freeRepayRaw, type SellPlan } from "@/lib/sell";
import { QUOTE_MOVED, quoteKey, type BuyQuote, type Side } from "@/lib/swap/buy";
import { sellMinOut, type SellQuote } from "@/lib/swap/sell";
import { FREE_UP_FLOOR } from "@/lib/freeUpPlan";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";
import { TxStop, txKey, type TxPlan } from "./prepared";

/*
 * The plans of the writes (useTx): what each signs and how it is keyed, pure, so their keys are tested with the others'
 * (tests/unit/tx-keys.test.ts). Some screens build their batch from what's on screen alone; the others pass the batch
 * their hook builds from fresh reads (`Batch`).
 */

type Address = `0x${string}`;
/** A hook's batch builder, run from fresh reads while the screen is idle (useTx). */
type Batch<I> = (p: I) => Promise<Call[]>;

/**
 * Free up: a stock's shares out of backing, an exact amount or all of them. Keyed by the stock, the amount and All. Its
 * simulation reads the health on Aave after it, and one in Act stops it (FREE_UP_FLOOR).
 */
export const withdrawPlan = (p: { user: Address; stock: ReserveAsset; amountRaw: bigint; all: boolean }): TxPlan => ({
  key: txKey("withdraw", p.user, p.stock.symbol, p.amountRaw, p.all),
  user: p.user,
  calls: () => Promise.resolve(buildWithdrawCalls(p)),
  healthFloor: FREE_UP_FLOOR,
  activity: [{ kind: "withdraw", symbol: p.stock.symbol, amount: Number(p.amountRaw) / 10 ** p.stock.decimals }],
});

/** A stock to take out of backing in a repay's batch (planFreeUp's `frees`, with its asset). */
export type TakeOut = { stock: ReserveAsset; amountRaw: bigint; all: boolean };

const takeOutCalls = (user: Address, outs: readonly TakeOut[]) =>
  outs.flatMap((o) => buildWithdrawCalls({ user, stock: o.stock, amountRaw: o.amountRaw, all: o.all }));

const takeOutActivity = (outs: readonly TakeOut[]) =>
  outs.map((o) => ({
    kind: "withdraw" as const,
    symbol: o.stock.symbol,
    amount: Number(o.amountRaw) / 10 ** o.stock.decimals,
  }));

/**
 * Repay and free up in one signature (canvas boards 3–7): the repay's own batch, whatever pays it (cash, a free stock,
 * a stock that backs credit), then each stock taken out. The repay goes first, so Aave checks each take-out against
 * what's owed after it. Keyed by the repay's key and every take-out; its simulation reads the health on Aave after the
 * whole batch, and one in Act stops it (FREE_UP_FLOOR). With no take-outs it is the repay's plan unchanged.
 */
export function withTakeOuts(plan: TxPlan, outs: readonly TakeOut[]): TxPlan {
  if (outs.length === 0) return plan;
  const repay = plan.calls;
  return {
    ...plan,
    key: txKey(
      plan.key,
      "take-out",
      outs.map((o) => [o.stock.symbol, o.amountRaw, o.all]),
    ),
    calls: async () => [...(typeof repay === "function" ? await repay() : repay), ...takeOutCalls(plan.user, outs)],
    healthFloor: FREE_UP_FLOOR,
    activity: [...(plan.activity ?? []), ...takeOutActivity(outs)],
  };
}

/** Free up with nothing repaid (canvas board 6): only the take-outs, held to the same line. */
export const takeOutPlan = (user: Address, outs: readonly TakeOut[]): TxPlan => ({
  key: txKey(
    "take-out",
    user,
    outs.map((o) => [o.stock.symbol, o.amountRaw, o.all]),
  ),
  user,
  calls: () => Promise.resolve(takeOutCalls(user, outs)),
  healthFloor: FREE_UP_FLOOR,
  activity: takeOutActivity(outs),
});

/** What Repay would sign: a chip's exact amount, or All (every cent owed when the cash covers it, else all the cash). */
export type RepayInput = {
  user: `0x${string}`;
  /** All, or a chip. */
  all: boolean;
  /** All and the cash covers what's owed: it repays everything, whatever the interest added since. */
  coversAll: boolean;
  /** The dollars on screen. */
  amount: number;
  /** A chip's exact amount, or All's from the position on screen (all the cash, when it doesn't cover what's owed). */
  amountRaw: bigint;
};

/**
 * What Repay signs (useTx), keyed by what shapes its batch: a chip by its exact amount; All by whether it covers
 * what's owed, and, when it doesn't, by the dollars on screen to the cent (the cash it spends), so a batch for other
 * cash is never signed.
 */
export const repayPlan = (p: RepayInput, batch: Batch<RepayInput>): TxPlan => ({
  key: p.all
    ? txKey("repay", p.user, "all", p.coversAll ? "full" : Math.round(p.amount * 100))
    : txKey("repay", p.user, p.amountRaw),
  user: p.user,
  calls: () => batch(p),
  activity: [{ kind: "repay", symbol: "USDC", amount: p.amount }],
});

/** What a repay with free shares signs (Repay's "Pay with" a stock held free). */
export type FreeRepayInput = {
  user: `0x${string}`;
  stock: ReserveAsset;
  /** The quote the screen shows, for the shares it sells. */
  quote: SellQuote;
  /** planSell (free shares) for that quote: its stop, the shares and what the sale pays. */
  plan: SellPlan;
  /** Aave's price for the stock, for the swap's floor (the holding's priceUsd). */
  oraclePriceUsd: number;
  /** What's owed (the position's debtRaw): the repay is never more than a full repay of it. */
  debtRaw: bigint;
  /** The cash can't keep the network-fee buffer, so the sale pays the fee. */
  feeFromSale: boolean;
};

export const FREE_REPAY_FALLBACK =
  "This repay would fail right now — the price may have moved or the stock may be paused. Try again in a moment.";

/**
 * What a repay with free shares signs (useTx), keyed by what shapes its batch: the account, the stock, the quote and its
 * floor, who pays the fee, the stop, and whether the floor covers what's owed. Not what's owed itself, as a repay by
 * selling: it accrues every block, and the batch only changes when the floor stops (or starts) covering it.
 */
export const freeRepayPlan = (p: FreeRepayInput, batch: Batch<FreeRepayInput>): TxPlan => {
  const floor = sellMinOut(p.quote, p.stock, p.oraclePriceUsd);
  const repayRaw = freeRepayRaw(floor, p.debtRaw, p.feeFromSale);
  return {
    key: txKey(
      "repay-free",
      p.user,
      p.stock.symbol,
      quoteKey(p.quote),
      floor,
      p.feeFromSale,
      p.plan.block ?? null,
      repayRaw > p.debtRaw ? "full" : "part",
    ),
    user: p.user,
    calls: () => batch(p),
    fallback: FREE_REPAY_FALLBACK,
    activity: freeRepayActivity(p.stock, p.plan, repayRaw),
  };
};

/** What a Send signs: from the account, the token, the recipient on screen and the exact amount (raw units). */
export type SendInput = {
  user: Address;
  token: ReserveAsset;
  recipient: Recipient;
  amountRaw: bigint;
};

export const isCashToken = (token: ReserveAsset) => isAddressEqual(token.address, USDC.address);

/**
 * What a Send signs (useTx), keyed by the account, the token, the recipient's address as resolved and the amount: a
 * batch prepared for one recipient is never signed for another (a name that resolved late can't take its place). The
 * recipient's name only labels Activity, so it isn't in the key.
 */
export const sendPlan = (p: SendInput, batch: Batch<SendInput>): TxPlan => ({
  key: txKey(
    "send",
    p.user.toLowerCase(),
    p.token.address.toLowerCase(),
    p.recipient.address.toLowerCase(),
    p.amountRaw,
  ),
  user: p.user,
  calls: () => batch(p),
  fallback: isCashToken(p.token) ? SEND_COPY.fallback : SEND_COPY.stockFallback,
  activity: sendActivity(p.token, p.amountRaw, p.recipient),
});

/** What the Trade sheet signs, per route, with the quotes and the plan its screen shows. */
export type TradeSign =
  | { route: "buy"; user: Address; stock: ReserveAsset; quote: BuyQuote }
  | {
      route: "sell";
      user: Address;
      stock: ReserveAsset;
      quote: SellQuote;
      plan: SellPlan;
      oraclePriceUsd: number;
      debtRaw: bigint;
    }
  | {
      route: "swap";
      user: Address;
      from: ReserveAsset;
      to: ReserveAsset;
      sellQuote: SellQuote;
      /** planSell (free shares) for `sellQuote`. */
      plan: SellPlan;
      /** The buy's quote for the screen's buy-in (the sale's floor, less the fee buffer when the sale pays the fee). */
      buyQuote: BuyQuote;
      /** Aave's price for `from`, for the sale's floor. */
      oraclePriceUsd: number;
      /** The cash can't keep the fee buffer, so the sale pays the network fee (swapBuyInRaw). */
      feeFromSale: boolean;
    };

/** What the stock → stock batch reads again while it's prepared (useSigningQuote, useSigningCash). */
export type SwapReads = {
  quoteToSign: (stock: ReserveAsset, shown: BuyQuote, side?: Side) => Promise<BuyQuote>;
  cashToSign: (user: Address, amountRaw: bigint) => Promise<Cash>;
};

/**
 * stock → stock's batch, built from fresh reads before JAW's sheet. A sale the screen blocked stops here too. Both quotes are read
 * again on their pools (never under the screen's floors, else QUOTE_MOVED from the read itself), and the buy must still
 * spend no more than the fresh sale's floor (else QUOTE_MOVED). When the sale pays the network fee, the batch is the
 * sale and the buy alone; otherwise the cash is read again and pays it (payFromCash: a savings withdrawal goes first
 * when the wallet can't be counted on for the fee).
 */
export async function swapBatch(p: Extract<TradeSign, { route: "swap" }>, reads: SwapReads): Promise<Call[]> {
  if (p.plan.block) throw new TxStop(saleBlockText(p.plan.block, true, swapMinUsd(1 - p.plan.discount, p.feeFromSale)));
  const [sellQuote, buyQuote] = await Promise.all([
    reads.quoteToSign(p.from, p.sellQuote, "sell"),
    reads.quoteToSign(p.to, p.buyQuote, "buy"),
  ]);
  if (buyQuote.amountIn > sellMinOut(sellQuote, p.from, p.oraclePriceUsd)) throw new TxStop(QUOTE_MOVED);
  const calls = buildTradeCalls({
    user: p.user,
    from: p.from,
    to: p.to,
    sellQuote,
    buyQuote,
    oraclePriceUsd: p.oraclePriceUsd,
  });
  return p.feeFromSale ? calls : payFromCash(p.user, 0n, await reads.cashToSign(p.user, 0n), calls);
}

/** What stock → stock signs (useTx), keyed by both legs, both quotes, the sale's floor and stop, and who pays the fee. */
export const swapPlan = (p: Extract<TradeSign, { route: "swap" }>, reads: SwapReads): TxPlan => ({
  key: txKey(
    "swap",
    p.user,
    p.from.symbol,
    p.to.symbol,
    quoteKey(p.sellQuote),
    sellMinOut(p.sellQuote, p.from, p.oraclePriceUsd),
    quoteKey(p.buyQuote),
    p.plan.block ?? null,
    p.feeFromSale,
  ),
  user: p.user,
  calls: () => swapBatch(p, reads),
  fallback: TRADE_COPY.swapFallback,
  activity: tradeActivity({ from: p.from, to: p.to, plan: p.plan, buyQuote: p.buyQuote }),
});
