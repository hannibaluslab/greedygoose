import { decodeFunctionData, erc20Abi, isAddressEqual, type Abi, type Hex } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { GUARDIAN } from "@/lib/guardian/config";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { aeroRouterAbi, swapRouter02Abi } from "@/lib/swap/abis";
import { AERODROME, ROUTERS, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

type Rule = { targets: readonly `0x${string}`[]; abi: Abi; functions: readonly string[] };

/**
 * The one allowlist for user-signed batches (CLAUDE.md › Transaction safety): each target, the only
 * functions it may be called with, and the only spenders an approve may name. Buys, repays and
 * savings-first batches mix targets, so each target is held to its own functions.
 */
const RULES: readonly Rule[] = [
  { targets: [USDC.address, ...EQUITIES.map((e) => e.address)], abi: erc20Abi, functions: ["approve"] },
  { targets: [AAVE.SPOKE], abi: spokeAbi, functions: ["supply", "setUsingAsCollateral", "withdraw", "borrow", "repay"] },
  { targets: [GUARDIAN.AAVE_V3_POOL], abi: aaveV3PoolAbi, functions: ["withdraw"] },
  { targets: [AERODROME.ROUTER], abi: aeroRouterAbi, functions: ["exactInputSingle"] },
  { targets: [UNISWAP.SWAP_ROUTER_02], abi: swapRouter02Abi, functions: ["exactInputSingle"] },
];

const SPENDERS: readonly `0x${string}`[] = [AAVE.SPOKE, ...ROUTERS];

export function assertAllowed<C extends { to: `0x${string}`; data: Hex; value: bigint }>(calls: C[]): C[] {
  for (const c of calls) {
    const rule = RULES.find((r) => r.targets.some((t) => isAddressEqual(t, c.to)));
    if (!rule) throw new Error(`Blocked: unexpected target ${c.to}`);
    if (c.value !== 0n) throw new Error("Blocked: unexpected value");
    let call: { functionName: string; args?: readonly unknown[] };
    try {
      call = decodeFunctionData({ abi: rule.abi, data: c.data });
    } catch {
      throw new Error(`Blocked: unexpected call to ${c.to}`);
    }
    if (!rule.functions.includes(call.functionName)) throw new Error(`Blocked: unexpected call to ${c.to}`);
    if (call.functionName === "approve") {
      const spender = call.args?.[0] as `0x${string}`;
      if (!SPENDERS.some((s) => isAddressEqual(s, spender))) throw new Error(`Blocked: unexpected spender ${spender}`);
    }
  }
  return calls;
}
