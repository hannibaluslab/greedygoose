/**
 * The leaderboard's reads against Base mainnet: the pools it treats as inside an account, the paymaster whose fee
 * records it reads, and an EFP list read for an account without one. Nothing is signed or sent.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, http, isAddressEqual } from "viem";
import { CHAIN } from "@/lib/chain";
import { fixedInside, readInside } from "@/lib/board/inside";
import { JAW_PAYMASTER } from "@/lib/board/logs";
import { fetchFollowing } from "@/lib/efp/read";
import { EFP_ACCOUNT_METADATA, EFP_LIST_MINTER, EFP_LIST_RECORDS, EFP_LIST_REGISTRY } from "@/lib/efp/efp";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });

describe("the board's reads on Base", () => {
  it("finds the stock and dollar-coin pools the app swaps through", async () => {
    const inside = await readInside(client);
    const pools = inside.slice(fixedInside().length);
    // Measured 2026-10-15: NVDAc/USDC on Aerodrome (tick spacing 10) and on Uniswap (0.3%), USDT/USDC on Aerodrome's first deployment.
    for (const p of ["0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9", "0x60661b315553EB81872deEA9a66d567Cf0CCd33B", "0xa41Bc0AFfbA7Fd420d186b84899d7ab2aC57fcD1"] as const) {
      expect(pools.some((x) => isAddressEqual(x, p))).toBe(true);
    }
  }, 60_000);

  it("JAW's paymaster and EFP's four contracts have code", async () => {
    for (const a of [JAW_PAYMASTER, EFP_ACCOUNT_METADATA, EFP_LIST_REGISTRY, EFP_LIST_RECORDS, EFP_LIST_MINTER]) {
      expect((await client.getCode({ address: a }))?.length ?? 0).toBeGreaterThan(2);
    }
  }, 60_000);

  it("an account without an EFP list has no contacts and no slot", async () => {
    expect(await fetchFollowing(client, "0x000000000000000000000000000000000000dEaD")).toEqual({ addresses: [], hasList: false, slot: null });
  }, 60_000);
});
