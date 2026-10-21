"use client";

import { useMemo } from "react";
import { erc20Abi, zeroAddress } from "viem";
import { useReadContracts } from "wagmi";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { hubAbi } from "@/lib/aave/abis/IHub";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { creditApr, monthlyCost, priceToUsd, summarize, type AccountData } from "@/lib/aave/math";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { statusFor } from "@/lib/risk/status";
import { PROTOCOLS } from "@/lib/protocols/config";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { executorAccountsAbi } from "@/lib/agents/abis/accounts";
import { cashRaw, protectRuns, saveRuns, toUsd, type Cash } from "@/lib/cash";
import { creditLineFor } from "@/config/risk";
import { WALL_OPEN } from "@/lib/board/config";
import { creditWith } from "@/lib/creditBuy";

/** Aave V3 getReserveData — only `currentLiquidityRate` (index 2, RAY) is used. */
export const v3ReserveAbi = [
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "configuration", type: "uint256" },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" },
        ],
      },
    ],
  },
] as const;

const uiMultiplierAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export type Holding = {
  symbol: string;
  name: string;
  reserveId: number;
  priceUsd: number;
  /** Aave's oracle price, 8 decimals (what the agents' rules take). */
  priceRaw: bigint;
  /** Shares shown to the user (raw × uiMultiplier). */
  freeShares: number;
  backingShares: number;
  freeUsd: number;
  backingUsd: number;
  paused: boolean;
  frozen: boolean;
  freeRaw: bigint;
  backingRaw: bigint;
  /** B20 uiMultiplier (1e18 = 1 share per token). */
  multiplier: bigint;
  backingEnabled: boolean;
  dynamicConfigKey: number;
};

const PER = 7;

/** One multicall for everything Home and Credit need. Chain state is authoritative. */
export function usePosition(user: `0x${string}` | undefined) {
  const contracts = useMemo(() => {
    const who = user ?? zeroAddress; // query is disabled until a user exists
    const perEquity = EQUITIES.flatMap((e) => [
      { address: e.address, abi: erc20Abi, functionName: "balanceOf", args: [who] },
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(e.reserveId), who] },
      { address: AAVE.SPOKE_ORACLE, abi: aaveOracleAbi, functionName: "getReservePrice", args: [BigInt(e.reserveId)] },
      { address: e.address, abi: uiMultiplierAbi, functionName: "uiMultiplier" },
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserveConfig", args: [BigInt(e.reserveId)] },
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserReserveStatus", args: [BigInt(e.reserveId), who] },
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserve", args: [BigInt(e.reserveId)] },
    ]);
    return [
      ...perEquity,
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [who] },
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), who] },
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserLastRiskPremium", args: [who] },
      { address: AAVE.HUB, abi: hubAbi, functionName: "getAssetDrawnRate", args: [BigInt(USDC.reserveId)] },
      { address: AAVE.HUB, abi: hubAbi, functionName: "getAssetLiquidity", args: [BigInt(USDC.reserveId)] },
      { address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [who] },
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getReserveConfig", args: [BigInt(USDC.reserveId)] },
      { address: PROTOCOLS.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [who] },
      { address: PROTOCOLS.AAVE_V3_POOL, abi: v3ReserveAbi, functionName: "getReserveData", args: [USDC.address] },
      // The Cash Agent's switches, once the executor is deployed: whether Save runs decides the keep-back.
      ...(GOOSE_EXECUTOR
        ? [{ address: GOOSE_EXECUTOR, abi: executorAccountsAbi, functionName: "accounts", args: [who] } as const]
        : []),
    ] as const;
  }, [user]);

  const query = useReadContracts({
    contracts,
    allowFailure: false,
    query: { enabled: !!user, refetchInterval: 15_000 },
  });

  const data = useMemo(() => {
    const r = query.data as readonly unknown[] | undefined;
    if (!r) return undefined;
    const holdings: Holding[] = EQUITIES.map((e, i) => {
      const [bal, supplied, price, mult, cfg, userStatus, reserve] = r.slice(i * PER, i * PER + PER) as [
        bigint,
        bigint,
        bigint,
        bigint,
        { paused: boolean; frozen: boolean },
        readonly [boolean, boolean],
        { dynamicConfigKey: number },
      ];
      const toShares = (raw: bigint) => Number((raw * mult) / 10n ** 18n) / 10 ** e.decimals;
      const priceUsd = priceToUsd(price);
      const raw = (x: bigint) => Number(x) / 10 ** e.decimals;
      return {
        symbol: e.symbol,
        name: e.name,
        reserveId: e.reserveId,
        priceUsd,
        priceRaw: price,
        freeShares: toShares(bal),
        backingShares: toShares(supplied),
        // Oracle price already reflects the multiplier, so value raw units × price.
        freeUsd: raw(bal) * priceUsd,
        backingUsd: raw(supplied) * priceUsd,
        paused: cfg.paused,
        frozen: cfg.frozen,
        freeRaw: bal,
        backingRaw: supplied,
        multiplier: mult,
        backingEnabled: userStatus[0],
        dynamicConfigKey: reserve.dynamicConfigKey,
      };
    });
    const o = EQUITIES.length * PER;
    const [account, debtRaw, riskPremium, drawnRate, liquidity, usdcBal, usdcCfg, savingsRaw, v3Reserve, agents] =
      r.slice(o) as [
        AccountData,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        { paused: boolean; frozen: boolean; borrowable: boolean },
        bigint,
        { currentLiquidityRate: bigint },
        readonly [jobs: number, ...rest: unknown[]] | undefined,
      ];
    const s = summarize(account);
    const apr = creditApr(drawnRate, riskPremium);
    const debtUsd = Number(debtRaw) / 10 ** USDC.decimals;
    const cash: Cash = { walletRaw: usdcBal, savingsRaw, saveOn: saveRuns(agents?.[0] ?? 0) };
    const usdcLiquidity = Number(liquidity) / 10 ** USDC.decimals;
    const creditPaused = usdcCfg.paused || usdcCfg.frozen || !usdcCfg.borrowable;
    // How low credit may go: 1.12 until Greedy Fatalities is open, then Protector's line or Aave's (config/risk.ts).
    const line = creditLineFor({ wallOpen: WALL_OPEN, protectOn: protectRuns(agents?.[0] ?? 0) });
    return {
      holdings,
      stocksUsd: holdings.reduce((a, h) => a + h.freeUsd + h.backingUsd, 0),
      totalBackingUsd: s.totalBackingUsd,
      debtUsd,
      // The credit left on what already backs it, at the one cap (the line's): never more than any flow lets you take.
      availableUsd: creditWith({
        totalBackingUsd: s.totalBackingUsd,
        avgCf: s.avgCf,
        debtUsd,
        healthFactor: s.healthFactor,
        usdcLiquidity,
        creditPaused,
        line,
      }),
      line,
      healthFactor: s.healthFactor,
      avgCf: s.avgCf,
      status: statusFor(s.healthFactor),
      apr,
      monthlyCostUsd: monthlyCost(debtUsd, apr),
      usdcBalance: Number(usdcBal) / 10 ** USDC.decimals,
      usdcBalanceRaw: usdcBal,
      /** Savings: USDC supplied to Aave V3 (aBasUSDC). */
      savingsUsd: Number(savingsRaw) / 10 ** USDC.decimals,
      savingsRaw,
      /** Aave V3 USDC supply APR (variable). */
      savingsApr: Number(v3Reserve.currentLiquidityRate) / 1e27,
      /** Cash (D15): wallet USDC plus savings. Every screen shows this as the user's cash. */
      cash,
      cashUsd: toUsd(cashRaw(cash)),
      debtRaw,
      usdcLiquidity,
      creditPaused,
    };
  }, [query.data]);

  return { ...query, data };
}

export type PositionData = NonNullable<ReturnType<typeof usePosition>["data"]>;

/** Collateral factor (0–1) per equity reserve, read live from the spoke's dynamic config. */
export function useBackingFactors(holdings: Holding[] | undefined) {
  return useBackingFactorsRead(holdings).cfs;
}

/** useBackingFactors, with whether the read failed and a retry, for a screen that says so instead of pulsing on. */
export function useBackingFactorsRead(holdings: Holding[] | undefined) {
  const contracts = useMemo(
    () =>
      (holdings ?? []).map((h) => ({
        address: AAVE.SPOKE,
        abi: spokeAbi,
        functionName: "getDynamicReserveConfig" as const,
        args: [BigInt(h.reserveId), h.dynamicConfigKey] as const,
      })),
    [holdings],
  );
  const q = useReadContracts({ contracts, allowFailure: false, query: { enabled: contracts.length > 0 } });
  const cfs = useMemo(() => {
    if (!q.data || !holdings) return undefined;
    return Object.fromEntries(
      holdings.map((h, i) => [h.symbol, (q.data[i] as { collateralFactor: number }).collateralFactor / 10_000]),
    ) as Record<string, number>;
  }, [q.data, holdings]);
  return { cfs, failed: !cfs && q.isError && !q.isFetching, retry: () => void q.refetch() };
}
