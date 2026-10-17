import { encodeFunctionData, erc20Abi, maxUint256, type Hex } from "viem";
import { USDC } from "@/lib/tokens/registry";
import { PROTOCOLS } from "@/lib/protocols/config";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";

type Call = { to: `0x${string}`; data: Hex; value: bigint };

/** User-signed: move USDC into the savings buffer (Aave V3), exact approval. */
export function buildAddSavingsCalls(user: `0x${string}`, amountRaw: bigint): Call[] {
  if (amountRaw <= 0n) throw new Error("Amount must be positive");
  return [
    {
      to: USDC.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PROTOCOLS.AAVE_V3_POOL, amountRaw] }),
      value: 0n,
    },
    {
      to: PROTOCOLS.AAVE_V3_POOL,
      data: encodeFunctionData({
        abi: aaveV3PoolAbi,
        functionName: "supply",
        args: [USDC.address, amountRaw, user, 0],
      }),
      value: 0n,
    },
  ];
}

/** User-signed: take savings back to cash. `all` withdraws everything (Aave treats max uint as "all"). */
export function buildWithdrawSavingsCalls(user: `0x${string}`, amountRaw: bigint, all: boolean): Call[] {
  return [
    {
      to: PROTOCOLS.AAVE_V3_POOL,
      data: encodeFunctionData({
        abi: aaveV3PoolAbi,
        functionName: "withdraw",
        args: [USDC.address, all ? maxUint256 : amountRaw, user],
      }),
      value: 0n,
    },
  ];
}
