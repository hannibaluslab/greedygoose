import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseUnits, toFunctionSelector, type Hex } from "viem";

// GooseGuard configured: every batch where the user takes credit or repays by hand ends a rescue (decision 5).
const GUARD = vi.hoisted(() => {
  const guard = "0x00000000000000000000000000000000000e5ec0" as const;
  process.env.NEXT_PUBLIC_GOOSE_GUARD = guard;
  return guard;
});

import type { Call } from "@/lib/aave/tx";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { endRescueCalls } from "@/lib/agents/settings";
import { assertAllowed } from "@/lib/allowlist";
import { buildCreditBuyCalls, type CreditLimit } from "@/lib/creditBuy";
import { buildEarnCalls } from "@/lib/earnWithStocks";
import { EQUITIES } from "@/lib/tokens/registry";
import { repayPlan, takeOutPlan, withEndRescue, withTakeOuts } from "@/lib/tx/plans";

const user: `0x${string}` = "0x000000000000000000000000000000000000dEaD";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const END_RESCUE = toFunctionSelector("endRescue()");
const isEnd = (c: { to: string; data: Hex }) => c.to === GUARD && c.data === END_RESCUE;
const aapl = EQUITIES.find((e) => e.symbol === "AAPLc")!;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const tsla = EQUITIES.find((e) => e.symbol === "TSLAc")!;
const roomy: CreditLimit = { maxCreditRaw: usd(1_000_000), freeRaw: { NVDAc: 10n ** 12n, TSLAc: 10n ** 12n } };
const cash = { walletRaw: usd(40), savingsRaw: 0n, saveOn: false, rescuing: true };
const repay: Call = { to: user, data: "0x", value: 0n };

describe("endRescue() in a batch where the user takes credit or repays by hand, while a rescue is on (decision 5)", () => {
  it("is GooseGuard's endRescue() alone, sent by the account and allowlisted with no arguments", () => {
    const [c] = endRescueCalls(user, true);
    expect(c).toEqual({ to: GUARD, data: END_RESCUE, value: 0n });
    expect(decodeFunctionData({ abi: guardAbi, data: c.data }).functionName).toBe("endRescue");
    expect(assertAllowed(user, [c])).toHaveLength(1);
  });

  it("goes first in a Credit Buy, which still swaps last", () => {
    const quote = { venue: "aerodrome" as const, pool: 10, amountIn: usd(300), amountOut: 135_000_000n };
    const calls = buildCreditBuyCalls({
      limit: roomy,
      user,
      stock: aapl,
      quote,
      oraclePriceUsd: 222,
      creditRaw: quote.amountIn,
      backing: [{ stock: nvda, raw: 336_000_000n }],
      cash,
      nowSec: 1_000,
    });
    expect(isEnd(calls[0])).toBe(true);
    expect(calls.filter(isEnd)).toHaveLength(1);
  });

  it("goes first in Earn with stocks, before the credit and the savings supply", () => {
    const calls = buildEarnCalls({
      user,
      backing: [{ stock: tsla, raw: 50_000_000n }],
      creditRaw: usd(500),
      limit: roomy,
      cash,
    });
    expect(isEnd(calls[0])).toBe(true);
    expect(calls.filter(isEnd)).toHaveLength(1);
  });

  it("goes first in a repay (cash, free shares and a sale that repays all use withEndRescue); a take-out alone repays nothing", async () => {
    const input = { user, all: false, coversAll: false, amount: 5, amountRaw: usd(5), rescuing: true };
    const plan = repayPlan(input, () => Promise.resolve([repay]));
    const calls = await (plan.calls as () => Promise<Call[]>)();
    expect(calls.map(isEnd)).toEqual([true, false]);
    // Repay and free up in one signature: the repay's batch, rescue's end included, then the take-outs.
    const outs = [{ stock: nvda, amountRaw: 1_000n, all: false }];
    const both = await (withTakeOuts(plan, outs).calls as () => Promise<Call[]>)();
    expect(both.filter(isEnd)).toHaveLength(1);
    const alone = await (takeOutPlan(user, outs).calls as () => Promise<Call[]>)();
    expect(alone.some(isEnd)).toBe(false);
    const batch = await withEndRescue(() => Promise.resolve([repay]))({ user, rescuing: true });
    expect(batch.map(isEnd)).toEqual([true, false]);
  });

  it("adds nothing when no rescue is on, so JAW's sheet shows no Guard call", async () => {
    expect(endRescueCalls(user, false)).toEqual([]);
    const calm = { ...cash, rescuing: false };
    const quote = { venue: "aerodrome" as const, pool: 10, amountIn: usd(300), amountOut: 135_000_000n };
    const buy = buildCreditBuyCalls({
      limit: roomy,
      user,
      stock: aapl,
      quote,
      oraclePriceUsd: 222,
      creditRaw: quote.amountIn,
      backing: [{ stock: nvda, raw: 336_000_000n }],
      cash: calm,
      nowSec: 1_000,
    });
    expect(buy.some(isEnd)).toBe(false);
    const earn = buildEarnCalls({
      user,
      backing: [{ stock: tsla, raw: 50_000_000n }],
      creditRaw: usd(500),
      limit: roomy,
      cash: calm,
    });
    expect(earn.some(isEnd)).toBe(false);
    const repaid = await withEndRescue(() => Promise.resolve([repay]))({ user });
    expect(repaid.some(isEnd)).toBe(false);
  });
});
