/**
 * Re-verifies every hard-coded address against Base mainnet.
 * Run: npm run verify:registry  (uses NEXT_PUBLIC_BASE_RPC_URL or the public Base RPC)
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, erc20Abi, http } from "viem";
import { CHAIN } from "@/lib/chain";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { ALL_RESERVES } from "@/lib/tokens/registry";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });

describe("Aave V4 Equities Hub registry", () => {
  it("is on Base", async () => expect(await client.getChainId()).toBe(8453));

  it("has code at hub, spoke, oracle", async () => {
    for (const a of [AAVE.HUB, AAVE.SPOKE, AAVE.SPOKE_ORACLE]) {
      expect((await client.getCode({ address: a }))?.length ?? 0).toBeGreaterThan(2);
    }
  });

  it("spoke oracle matches", async () => {
    const oracle = await client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "ORACLE" });
    expect(oracle.toLowerCase()).toBe(AAVE.SPOKE_ORACLE.toLowerCase());
  });

  it.each(ALL_RESERVES.map((r) => [r.symbol, r] as const))("%s: reserve, symbol, decimals", async (_, r) => {
    const reserve = await client.readContract({
      address: AAVE.SPOKE,
      abi: spokeAbi,
      functionName: "getReserve",
      args: [BigInt(r.reserveId)],
    });
    expect(reserve.underlying.toLowerCase()).toBe(r.address.toLowerCase());
    expect(reserve.hub.toLowerCase()).toBe(AAVE.HUB.toLowerCase());
    expect(reserve.decimals).toBe(r.decimals);
    expect(await client.readContract({ address: r.address, abi: erc20Abi, functionName: "symbol" })).toBe(r.symbol);
    expect(await client.readContract({ address: r.address, abi: erc20Abi, functionName: "decimals" })).toBe(r.decimals);
  });
});
