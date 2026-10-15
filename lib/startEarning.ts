import { decodeFunctionData, erc20Abi, isAddressEqual, parseUnits } from "viem";
import type { Call } from "@/lib/aave/tx";
import type { ActivityItem } from "@/lib/activity/decode";
import { assertAllowed } from "@/lib/allowlist";
import { feeBufferRaw, toUsd } from "@/lib/cash";
import { GUARDIAN } from "@/lib/guardian/config";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { buildAddSavingsCalls } from "@/lib/guardian/permission";
import { txKey, type TxPlan } from "@/lib/tx/prepared";
import { USDC } from "@/lib/tokens/registry";

/*
 * Start earning (Adrian, 2026-10-15): "Start earning" moves the cash that sits in the wallet into savings in one
 * user-signed batch, so it earns from the moment the batch lands, with or without the Save agent (the public link has
 * none). The batch is an exact USDC approve to Aave V3's pool and its supply for the user, of the wallet's USDC less the
 * network fee's buffer (CASH.feeBufferUsd), which stays in the wallet for JAW's fee. Pure, so the amounts and the batch
 * are unit-tested and the dev gallery draws every state.
 */

type Address = `0x${string}`;

/** The least that goes in, in dollars: under it there's nothing worth earning on. */
export const MIN_START_USD = 1;
const minStartRaw = parseUnits(MIN_START_USD.toFixed(USDC.decimals), USDC.decimals);

/**
 * What a tap puts into savings: all the wallet's USDC but the fee buffer, which stays for JAW's network fee (charged
 * in USDC after the batch, D4). Null under the $1 minimum.
 */
export function startEarningRaw(walletRaw: bigint): bigint | null {
  const raw = walletRaw - feeBufferRaw;
  return raw >= minStartRaw ? raw : null;
}

/** The wallet USDC it takes before Home offers Start earning: $1 to put in, and the fee buffer that stays. */
export const startEarningMinRaw = minStartRaw + feeBufferRaw;

const decode = (c: Call | undefined) => {
  if (!c) return null;
  try {
    if (isAddressEqual(c.to, USDC.address)) return { on: "usdc" as const, ...decodeFunctionData({ abi: erc20Abi, data: c.data }) };
    if (isAddressEqual(c.to, GUARDIAN.AAVE_V3_POOL)) return { on: "pool" as const, ...decodeFunctionData({ abi: aaveV3PoolAbi, data: c.data }) };
  } catch {
    /* blocked below */
  }
  return null;
};

/**
 * Start earning's batch, checked against the screen: exactly two calls, no value. First USDC's approve of exactly the
 * amount to Aave V3's pool, then the pool's supply of that amount of USDC for the user, referral code 0. Nothing else:
 * no withdrawal, no swap, no transfer, no other savings call.
 */
export function assertStartEarning(user: Address, calls: Call[], amountRaw: bigint): Call[] {
  if (amountRaw <= 0n) throw new Error("Blocked: nothing to put in");
  if (calls.length !== 2 || calls.some((c) => c.value !== 0n)) throw new Error("Blocked: the batch differs from the screen");
  const [approve, supply] = calls.map(decode);
  if (approve?.on !== "usdc" || approve.functionName !== "approve") throw new Error("Blocked: the approval differs from the screen");
  const [spender, allowance] = approve.args as readonly [Address, bigint];
  if (!isAddressEqual(spender, GUARDIAN.AAVE_V3_POOL) || allowance !== amountRaw) throw new Error("Blocked: the approval differs from the screen");
  if (supply?.on !== "pool" || supply.functionName !== "supply") throw new Error("Blocked: what earns differs from the screen");
  const [asset, raw, onBehalfOf, referral] = supply.args as readonly [Address, bigint, Address, number];
  if (!isAddressEqual(asset, USDC.address) || raw !== amountRaw || !isAddressEqual(onBehalfOf, user) || referral !== 0) {
    throw new Error("Blocked: what earns differs from the screen");
  }
  return calls;
}

/**
 * The batch for the wallet's USDC as the screen read it: an exact approve and a supply into savings for the user
 * (buildAddSavingsCalls), through the allowlist with the savings declared (`saveTo`, the user), then checked against the
 * screen (assertStartEarning). Throws under the $1 minimum.
 */
export function buildStartEarningCalls(p: { user: Address; walletRaw: bigint }): Call[] {
  const amountRaw = startEarningRaw(p.walletRaw);
  if (amountRaw === null) throw new Error("Blocked: under the smallest amount");
  const calls = assertAllowed(p.user, buildAddSavingsCalls(p.user, amountRaw), { saveTo: p.user });
  return assertStartEarning(p.user, calls, amountRaw);
}

/** What Activity shows while it confirms, as the receipt will read (lib/activity/decode.ts): one move, into savings. */
export const startEarningActivity = (amountRaw: bigint): ActivityItem[] => [{ kind: "save", symbol: USDC.symbol, amount: toUsd(amountRaw) }];

/**
 * What the tap signs (useTx): keyed by the account and the wallet USDC on screen, so a new balance is a new batch.
 * Null when there's under the minimum to put in.
 */
export function startEarningPlan(user: Address, walletRaw: bigint): TxPlan | null {
  const amountRaw = startEarningRaw(walletRaw);
  if (amountRaw === null) return null;
  return {
    key: txKey("startEarning", user, walletRaw),
    user,
    calls: () => Promise.resolve(buildStartEarningCalls({ user, walletRaw })),
    activity: startEarningActivity(amountRaw),
  };
}
