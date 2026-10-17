/**
 * The leaderboard's reads against Base mainnet: the swap venues it reads, Aave V3's USDC debt token, the paymaster
 * whose fee records it reads, and an EFP list read for an account without one. Nothing is signed or sent.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, erc20Abi, http, isAddressEqual, parseAbi } from "viem";
import { CHAIN } from "@/lib/chain";
import { readVenues } from "@/lib/board/inside";
import { JAW_PAYMASTER } from "@/lib/board/logs";
import { AAVE_V3_USDC_DEBT } from "@/lib/board/tokens";
import { fetchFollowing } from "@/lib/efp/read";
import { EFP_ACCOUNT_METADATA, EFP_LIST_MINTER, EFP_LIST_RECORDS, EFP_LIST_REGISTRY } from "@/lib/efp/efp";
import { PROTOCOLS } from "@/lib/protocols/config";
import { ROUTERS, SPARK_PSM3 } from "@/lib/swap/venues";
import { USDC } from "@/lib/tokens/registry";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });

describe("the board's reads on Base", () => {
  it("finds the stock and dollar-coin pools the app swaps through, PSM3 with its pocket, and no router", async () => {
    const venues = await readVenues(client);
    // Measured 2026-10-15: NVDAc/USDC on Aerodrome (tick spacing 10) and on Uniswap (0.3%), USDT/USDC on Aerodrome's first deployment.
    for (const p of [
      "0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9",
      "0x60661b315553EB81872deEA9a66d567Cf0CCd33B",
      "0xa41Bc0AFfbA7Fd420d186b84899d7ab2aC57fcD1",
    ] as const) {
      expect(venues.get(p.toLowerCase())).toBe(p.toLowerCase());
    }
    expect(venues.get(SPARK_PSM3.PSM3.toLowerCase())).toBe("psm3");
    for (const r of ROUTERS) expect(venues.has(r.toLowerCase())).toBe(false);
  }, 60_000);

  it("Aave V3's variable debt token for USDC is the pool's own", async () => {
    const pool = parseAbi([
      "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
    ]);
    const data = await client.readContract({
      address: PROTOCOLS.AAVE_V3_POOL,
      abi: pool,
      functionName: "getReserveData",
      args: [USDC.address],
    });
    expect(isAddressEqual(data.aTokenAddress, PROTOCOLS.AUSDC)).toBe(true);
    expect(isAddressEqual(data.variableDebtTokenAddress, AAVE_V3_USDC_DEBT)).toBe(true);
    expect(await client.readContract({ address: AAVE_V3_USDC_DEBT, abi: erc20Abi, functionName: "decimals" })).toBe(
      USDC.decimals,
    );
  }, 60_000);

  it("JAW's paymaster and EFP's four contracts have code", async () => {
    for (const a of [JAW_PAYMASTER, EFP_ACCOUNT_METADATA, EFP_LIST_REGISTRY, EFP_LIST_RECORDS, EFP_LIST_MINTER]) {
      expect((await client.getCode({ address: a }))?.length ?? 0).toBeGreaterThan(2);
    }
  }, 60_000);

  it("an account without an EFP list has no contacts and no slot", async () => {
    expect(await fetchFollowing(client, "0x000000000000000000000000000000000000dEaD")).toEqual({
      addresses: [],
      hasList: false,
      slot: null,
    });
  }, 60_000);
});
