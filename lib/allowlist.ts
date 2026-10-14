import { decodeFunctionData, erc20Abi, isAddressEqual, type Abi, type Hex } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { GUARDIAN } from "@/lib/guardian/config";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { aeroRouterAbi, swapRouter02Abi } from "@/lib/swap/abis";
import { AERODROME, ROUTERS, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

type Address = `0x${string}`;
/** True when a call's arguments keep the money with `user`. */
type ArgsCheck = (args: readonly unknown[], user: Address) => boolean;
type Rule = { targets: readonly Address[]; abi: Abi; functions: Record<string, ArgsCheck> };

const is = (a: unknown, b: Address) => typeof a === "string" && isAddressEqual(a as Address, b);
const oneOf = (a: unknown, list: readonly Address[]) => list.some((b) => is(a, b));

const TOKENS: readonly Address[] = [USDC.address, ...EQUITIES.map((e) => e.address)];
const SPENDERS: readonly Address[] = [AAVE.SPOKE, ...ROUTERS];

/** Aave V4 spoke calls: the third argument (onBehalfOf) is the position, and it must be the user's. */
const forUser: ArgsCheck = (args, user) => is(args[2], user);
/** A swap between registry tokens that pays out to the user. */
const swapToUser: ArgsCheck = (args, user) => {
  const p = args[0] as { tokenIn: unknown; tokenOut: unknown; recipient: unknown };
  return is(p.recipient, user) && oneOf(p.tokenIn, TOKENS) && oneOf(p.tokenOut, TOKENS);
};

/**
 * The one allowlist for user-signed batches (CLAUDE.md › Transaction safety): each target, the only
 * functions it may be called with, and what their arguments must say. Money only moves between the
 * user's own pockets: an approve names only the spoke or a router, every position, withdrawal and
 * swap pays the user, and savings come out only as USDC. Buys, repays and savings-first batches mix
 * targets, so each target is held to its own functions.
 */
const RULES: readonly Rule[] = [
  { targets: TOKENS, abi: erc20Abi, functions: { approve: (args) => oneOf(args[0], SPENDERS) } },
  {
    targets: [AAVE.SPOKE],
    abi: spokeAbi,
    functions: { supply: forUser, setUsingAsCollateral: forUser, withdraw: forUser, borrow: forUser, repay: forUser },
  },
  {
    targets: [GUARDIAN.AAVE_V3_POOL],
    abi: aaveV3PoolAbi,
    functions: { withdraw: (args, user) => is(args[0], USDC.address) && is(args[2], user) },
  },
  { targets: [AERODROME.ROUTER], abi: aeroRouterAbi, functions: { exactInputSingle: swapToUser } },
  { targets: [UNISWAP.SWAP_ROUTER_02], abi: swapRouter02Abi, functions: { exactInputSingle: swapToUser } },
];

export function assertAllowed<C extends { to: Address; data: Hex; value: bigint }>(user: Address, calls: C[]): C[] {
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
    const check = Object.hasOwn(rule.functions, call.functionName) ? rule.functions[call.functionName] : undefined;
    if (!check) throw new Error(`Blocked: unexpected call to ${c.to}`);
    if (!check(call.args ?? [], user)) {
      throw new Error(
        call.functionName === "approve"
          ? `Blocked: unexpected spender ${call.args?.[0]}`
          : `Blocked: unexpected arguments to ${call.functionName} on ${c.to}`,
      );
    }
  }
  return calls;
}
