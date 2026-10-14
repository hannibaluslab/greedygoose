import { encodeFunctionData, erc20Abi, maxUint256, type Hex } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { USDC } from "@/lib/tokens/registry";
import { GUARDIAN, GUARDIAN_SALT, SEL } from "./config";
import { aaveV3PoolAbi, permissionManagerAbi } from "./abis";

/** PeriodUnit enum in JustaPermissionManager (JustaPermissionManager.sol:206-213). There is no Year. */
export const PERIOD = { Minute: 0, Hour: 1, Day: 2, Week: 3, Month: 4, Forever: 5 } as const;

export type GuardianPermission = {
  account: `0x${string}`;
  spender: `0x${string}`;
  start: number;
  end: number;
  salt: bigint;
  calls: { target: `0x${string}`; selector: Hex; checker: `0x${string}` }[];
  spends: { token: `0x${string}`; allowance: bigint; unit: number; multiplier: number }[];
};

/**
 * The Guardian permission: three whitelisted calls, each argument-checked by GuardianChecker,
 * plus a daily USDC spend cap as a second layer. Deterministic given its inputs, so the app can
 * rebuild it for status checks and revocation.
 */
export function buildGuardianPermission(p: {
  account: `0x${string}`;
  spender: `0x${string}`;
  checker: `0x${string}`;
  dailyCapRaw: bigint;
  start: number;
  end: number;
}): GuardianPermission {
  if (p.dailyCapRaw <= 0n) throw new Error("Daily cap must be positive");
  if (p.end <= p.start) throw new Error("End must be after start");
  return {
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: GUARDIAN_SALT,
    calls: [
      { target: GUARDIAN.AAVE_V3_POOL, selector: SEL.withdraw, checker: p.checker },
      { target: USDC.address, selector: SEL.approve, checker: p.checker },
      { target: AAVE.SPOKE, selector: SEL.repay, checker: p.checker },
    ],
    spends: [{ token: USDC.address, allowance: p.dailyCapRaw, unit: PERIOD.Day, multiplier: 1 }],
  };
}

export const toTuple = (p: GuardianPermission) => ({
  ...p,
  calls: p.calls.map((c) => ({ ...c, selector: c.selector as `0x${string}` })),
});

export type Call = { to: `0x${string}`; data: Hex; value: bigint };

/** User-signed: approve the permission on the manager (the manager must already own the account). */
export const approveGuardianCall = (p: GuardianPermission): Call => ({
  to: GUARDIAN.PERMISSION_MANAGER,
  data: encodeFunctionData({ abi: permissionManagerAbi, functionName: "approve", args: [toTuple(p)] }),
  value: 0n,
});

/** User-signed: revoke. A revoked permission can never be approved again (new salt/end needed). */
export const revokeGuardianCall = (p: GuardianPermission): Call => ({
  to: GUARDIAN.PERMISSION_MANAGER,
  data: encodeFunctionData({ abi: permissionManagerAbi, functionName: "revoke", args: [toTuple(p)] }),
  value: 0n,
});

/** User-signed: move USDC into the savings buffer (Aave V3), exact approval. */
export function buildAddSavingsCalls(user: `0x${string}`, amountRaw: bigint): Call[] {
  if (amountRaw <= 0n) throw new Error("Amount must be positive");
  return [
    { to: USDC.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GUARDIAN.AAVE_V3_POOL, amountRaw] }), value: 0n },
    { to: GUARDIAN.AAVE_V3_POOL, data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "supply", args: [USDC.address, amountRaw, user, 0] }), value: 0n },
  ];
}

/** User-signed: take savings back to cash. `all` withdraws everything (Aave treats max uint as "all"). */
export function buildWithdrawSavingsCalls(user: `0x${string}`, amountRaw: bigint, all: boolean): Call[] {
  return [
    {
      to: GUARDIAN.AAVE_V3_POOL,
      data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "withdraw", args: [USDC.address, all ? maxUint256 : amountRaw, user] }),
      value: 0n,
    },
  ];
}

/**
 * Keeper-executed (through the manager): withdraw from savings → approve spoke → repay the user's own loan.
 * Every call is one the GuardianChecker allows; anything else would be rejected on-chain.
 */
export function buildRescueCalls(user: `0x${string}`, amountRaw: bigint) {
  if (amountRaw <= 0n) throw new Error("Amount must be positive");
  return [
    { target: GUARDIAN.AAVE_V3_POOL, value: 0n, data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "withdraw", args: [USDC.address, amountRaw, user] }) },
    { target: USDC.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AAVE.SPOKE, amountRaw] }) },
    { target: AAVE.SPOKE, value: 0n, data: encodeFunctionData({ abi: spokeAbi, functionName: "repay", args: [BigInt(USDC.reserveId), amountRaw, user] }) },
  ];
}
