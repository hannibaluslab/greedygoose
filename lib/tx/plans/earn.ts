import { buildEarnCalls, earnFloor, earnActivity, earnStop, type EarnOpen, type EarnQuote } from "@/lib/earnWithStocks";
import { toCashStop, type ToCashQuote } from "@/lib/creditBuy/toCash";
import { TxStop, txKey, type TxPlan } from "../prepared";
import type { CashToSign } from "./types";

const EARN_REVERT =
  "This would fail right now. Stock prices may be paused or have moved. Try a smaller amount in a moment.";

/** What the earn step would sign: the quote and offer on screen, and the risk tick. */
export type EarnInput = { user: `0x${string}`; quote: EarnQuote; offer: EarnOpen; confirmedRisk: boolean };

/**
 * What Earn with stocks signs (useTx): the screen's stops are checked again (earnStop), the cash is read again for the
 * network fee (from savings first when the wallet can't pay it), then the batch is built and checked (assertEarn): the
 * backing, the credit, and exactly that credit put where the cash earns. Keyed by the credit, what goes in use, the
 * status it ends in, the risk tick and the stop, so another amount or plan is another batch.
 */
export const earnPlan = (p: EarnInput, cashToSign: CashToSign): TxPlan => ({
  key: txKey(
    "earn",
    p.user,
    p.quote.plan.creditRaw,
    p.quote.plan.backing.map((b) => [b.stock.symbol, b.raw]),
    p.quote.plan.after,
    p.quote.plan.extraConfirm,
    p.confirmedRisk,
    earnStop(p.quote, p.offer, p.confirmedRisk),
  ),
  user: p.user,
  calls: async () => {
    const stop = earnStop(p.quote, p.offer, p.confirmedRisk);
    if (stop) throw new TxStop(stop);
    const cash = await cashToSign(p.user, 0n);
    const { backing, creditRaw, limit } = p.quote.plan;
    return buildEarnCalls({ user: p.user, backing, creditRaw, limit, cash });
  },
  fallback: EARN_REVERT,
  // The health on Aave after it, read in its simulation: in Act, it stops (Act is the line).
  healthFloor: earnFloor(p.quote.plan),
  activity: earnActivity(p.quote.plan),
});

/** What Credit Buy's Cash row would sign: the quote on screen, and the risk tick. */
type ToCashInput = { user: `0x${string}`; quote: ToCashQuote; confirmedRisk: boolean };

/**
 * What Credit Buy's Cash row signs (useTx): Earn with stocks' batch (assertEarn: the backing picked on step 1, the
 * credit, and exactly that credit put where the cash earns), with Credit Buy's stops checked again (toCashStop). It is
 * not stopped while credit costs more than the cash earns: the screen shows the gap first. Keyed by the credit, what
 * goes in use, the status it ends in, the risk tick and the stop, so another amount or plan is another batch.
 */
export const toCashPlan = (p: ToCashInput, cashToSign: CashToSign): TxPlan => ({
  key: txKey(
    "toCash",
    p.user,
    p.quote.plan.creditRaw,
    p.quote.plan.backing.map((b) => [b.stock.symbol, b.raw]),
    p.quote.plan.after,
    p.quote.plan.extraConfirm,
    p.confirmedRisk,
    toCashStop(p.quote, p.confirmedRisk),
  ),
  user: p.user,
  calls: async () => {
    const stop = toCashStop(p.quote, p.confirmedRisk);
    if (stop) throw new TxStop(stop);
    const cash = await cashToSign(p.user, 0n);
    const { backing, creditRaw, limit } = p.quote.plan;
    return buildEarnCalls({ user: p.user, backing, creditRaw, limit, cash });
  },
  fallback: EARN_REVERT,
  healthFloor: p.quote.plan.floor,
  activity: earnActivity(p.quote.plan),
});
