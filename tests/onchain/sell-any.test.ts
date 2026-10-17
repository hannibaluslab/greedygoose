/**
 * Sell on a stock that backs credit, "Up to $X" (planSell "any"), on Base with eth_simulateV1: nothing is sent. The
 * position is set up in the same simulation, from an account that backs no credit ($20 of its NVIDIA in use and credit
 * to a health of 1.75), so it doesn't hang on any real account.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, erc20Abi, http, parseUnits } from "viem";
import { CREDIT_CAP } from "@/config/risk";
import { AAVE } from "@/lib/aave/addresses";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { priceToUsd, summarize, type AccountData } from "@/lib/aave/math";
import { buildBackAndCreditCalls, type Call } from "@/lib/aave/tx";
import { CHAIN } from "@/lib/chain";
import { buildSaleCalls, planSell, type SellHolding, type SellPosition } from "@/lib/sell";
import { quotePool, quoteSwap, signingQuote } from "@/lib/swap/buy";
import type { SellQuote } from "@/lib/swap/sell";
import { EQUITIES } from "@/lib/tokens/registry";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });
const newcomer = "0xb5ef91ce939f2c390cff462bb231e74bb228deb4" as const;
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const plain = (calls: Call[]) => calls.map(({ to, data }) => ({ to, data }));
const accountRead = {
  to: AAVE.SPOKE,
  data: encodeFunctionData({ abi: spokeAbi, functionName: "getUserAccountData", args: [newcomer] }),
};
const account = (data: `0x${string}`) =>
  summarize(decodeFunctionResult({ abi: spokeAbi, functionName: "getUserAccountData", data }) as AccountData);

async function quoteToSign(sharesRaw: bigint): Promise<SellQuote> {
  const shown = await quoteSwap(client, nvda, sharesRaw, "sell");
  expect(shown).not.toBeNull();
  const signed = signingQuote(shown!, await quotePool(client, nvda, shown!.venue, shown!.pool, sharesRaw, "sell"));
  expect(signed).not.toBeNull();
  return signed!;
}

describe("Sell a stock that backs credit, Up to $X, on Base", () => {
  it("sells the free shares and part of the backing in one batch, and lands over the line; past Up to is blocked", async () => {
    const id = BigInt(nvda.reserveId);
    const [price, reserve, wallet] = await Promise.all([
      client.readContract({
        address: AAVE.SPOKE_ORACLE,
        abi: aaveOracleAbi,
        functionName: "getReservePrice",
        args: [id],
      }),
      client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserve", args: [id] }),
      client.readContract({ address: nvda.address, abi: erc20Abi, functionName: "balanceOf", args: [newcomer] }),
    ]);
    const dyn = await client.readContract({
      address: AAVE.SPOKE,
      abi: spokeAbi,
      functionName: "getDynamicReserveConfig",
      args: [id, reserve.dynamicConfigKey],
    });
    const cf = dyn.collateralFactor / 10_000;
    const priceUsd = priceToUsd(price);
    const usdPerRaw = priceUsd / 10 ** nvda.decimals;
    const backingRaw = BigInt(Math.floor(20 / usdPerRaw));
    expect(wallet).toBeGreaterThanOrEqual(backingRaw);
    const backingUsd = Number(backingRaw) * usdPerRaw;
    const debtUsd = Math.floor(((backingUsd * cf) / 1.75) * 1e6) / 1e6;
    const debtRaw = parseUnits(debtUsd.toFixed(6), 6);
    const setup = buildBackAndCreditCalls({
      user: newcomer,
      backing: [{ stock: nvda, raw: backingRaw }],
      creditRaw: debtRaw,
    });

    const r0 = await client.simulateCalls({ account: newcomer, calls: [...plain(setup), accountRead] });
    const s0 = account(r0.results.at(-1)!.data);
    const position: SellPosition = { ...s0, debtRaw };
    const holding: SellHolding = { priceUsd, freeRaw: wallet - backingRaw, backingRaw, backingUsd, paused: false };
    const plan = (sharesRaw: bigint, quote: SellQuote) =>
      planSell({ from: "any", stock: nvda, holding, cf, position, quote: { ...quote, amountIn: sharesRaw } });

    // Up to: the free shares plus what the line lets out. Sell the free shares and half of that backing.
    const probe = plan(holding.freeRaw + 1n, await quoteToSign(holding.freeRaw + 1n));
    const lineRaw = probe.maxRaw - holding.freeRaw;
    expect(lineRaw).toBeGreaterThan(0n);
    const sharesRaw = holding.freeRaw + lineRaw / 2n;
    const quote = await quoteToSign(sharesRaw);
    const p = plan(sharesRaw, quote);
    expect(p.block).toBeUndefined();
    expect(p.takeOutRaw).toBe(lineRaw / 2n);

    const calls = buildSaleCalls({
      from: "any",
      user: newcomer,
      stock: nvda,
      quote,
      oraclePriceUsd: priceUsd,
      debtRaw,
      takeOutRaw: p.takeOutRaw,
    });
    const r = await client.simulateCalls({ account: newcomer, calls: [...plain(setup), ...plain(calls), accountRead] });
    const failed = r.results.slice(0, -1).findIndex((x) => x.status !== "success");
    expect(failed, `call ${failed} reverted`).toBe(-1);
    const after = account(r.results.at(-1)!.data).healthFactor!;
    console.log(
      `Sell ${sharesRaw} raw NVDA (${p.takeOutRaw} out of backing) from 1.75: health ${after.toFixed(4)} (planned ${p.hfAfter!.toFixed(4)})`,
    );
    expect(after).toBeGreaterThanOrEqual(CREDIT_CAP.minHf);
    expect(after).toBeCloseTo(p.hfAfter!, 2);

    // Past Up to: blocked, repay first.
    const past = holding.freeRaw + (lineRaw * 13n) / 10n;
    expect(plan(past, await quoteToSign(past)).block).toBe("past-line");
  });
});
