import { decodeFunctionData, erc20Abi, isAddressEqual, type Abi, type Hex } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { isMix } from "@/lib/agents/mix";
import { GUARDIAN } from "@/lib/guardian/config";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { aeroRouterAbi, psm3Abi, swapRouter02Abi } from "@/lib/swap/abis";
import { AERODROME, AERODROME_V1, ROUTERS, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS, type EntryVenue } from "@/lib/tokens/stables";

type Address = `0x${string}`;
/** True when a call's arguments keep the money with `user`. */
type ArgsCheck = (args: readonly unknown[], user: Address) => boolean;
type Rule = { targets: readonly Address[]; abi: Abi; functions: Record<string, ArgsCheck> };

const is = (a: unknown, b: Address) => typeof a === "string" && isAddressEqual(a as Address, b);
const oneOf = (a: unknown, list: readonly Address[]) => list.some((b) => is(a, b));

const TOKENS: readonly Address[] = [USDC.address, ...EQUITIES.map((e) => e.address)];
const SPENDERS: readonly Address[] = [AAVE.SPOKE, ...ROUTERS];

/** Where each Entry coin is converted (lib/tokens/stables.ts), and the coins converted at a kind of venue. */
const venueOf = (v: EntryVenue): Address => (v.kind === "psm3" ? v.psm : v.router);
const ENTRY_AT = (kind: EntryVenue["kind"]): readonly Address[] => ENTRY_COINS.filter((c) => c.venue.kind === kind).map((c) => c.address);

/** Aave V4 spoke calls: the third argument (onBehalfOf) is the position, and it must be the user's. */
const forUser: ArgsCheck = (args, user) => is(args[2], user);
/**
 * A swap that pays out to the user: between registry tokens, or (`entry`) one of the Entry coins converted on this
 * router into USDC.
 */
const swapToUser =
  (entry: readonly Address[] = []): ArgsCheck =>
  (args, user) => {
    const p = args[0] as { tokenIn: unknown; tokenOut: unknown; recipient: unknown };
    if (!is(p.recipient, user)) return false;
    return (oneOf(p.tokenIn, TOKENS) && oneOf(p.tokenOut, TOKENS)) || (oneOf(p.tokenIn, entry) && is(p.tokenOut, USDC.address));
  };
/** An Entry coin into USDC for the user, and nothing else (Aerodrome's first deployment, PSM3). */
const convertToUser =
  (entry: readonly Address[]): ArgsCheck =>
  (args, user) => {
    const p = args[0] as { tokenIn: unknown; tokenOut: unknown; recipient: unknown };
    return is(p.recipient, user) && oneOf(p.tokenIn, entry) && is(p.tokenOut, USDC.address);
  };
/** The swap inside Uniswap's multicall(deadline, data): exactly one call, and it must be exactInputSingle. */
function innerSwap(data: readonly Hex[]): readonly unknown[] | null {
  if (data.length !== 1) return null;
  try {
    const inner = decodeFunctionData({ abi: swapRouter02Abi, data: data[0] });
    return inner.functionName === "exactInputSingle" ? inner.args : null;
  } catch {
    return null;
  }
}
/** Uniswap's router takes the deadline through multicall: one swap inside, to the user. */
const swapWithDeadline: ArgsCheck = (args, user) => {
  const inner = innerSwap(args[1] as readonly Hex[]);
  return !!inner && swapToUser(ENTRY_AT("uniswap"))(inner, user);
};

/**
 * The one allowlist for user-signed batches (CLAUDE.md › Transaction safety): each target, the only
 * functions it may be called with, and what their arguments must say. Money only moves between the
 * user's own pockets: an approve names only the spoke or a router, every position, withdrawal and
 * swap pays the user, and savings come out only as USDC. Buys, repays and savings-first batches mix
 * targets, so each target is held to its own functions. An Entry coin is approved only to the venue that converts
 * it, and converted only into USDC (D20). GooseExecutor's settings move no money and apply to the signer alone
 * (`msg.sender`): a mix must add up to 100% (or clear it).
 */
const RULES: readonly Rule[] = [
  { targets: TOKENS, abi: erc20Abi, functions: { approve: (args) => oneOf(args[0], SPENDERS) } },
  ...ENTRY_COINS.map((c) => ({ targets: [c.address], abi: erc20Abi, functions: { approve: (args: readonly unknown[]) => is(args[0], venueOf(c.venue)) } })),
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
  { targets: [AERODROME.ROUTER], abi: aeroRouterAbi, functions: { exactInputSingle: swapToUser() } },
  { targets: [AERODROME_V1.ROUTER], abi: aeroRouterAbi, functions: { exactInputSingle: convertToUser(ENTRY_AT("aerodrome")) } },
  { targets: [UNISWAP.SWAP_ROUTER_02], abi: swapRouter02Abi, functions: { multicall: swapWithDeadline } },
  {
    targets: [SPARK_PSM3.PSM3],
    abi: psm3Abi,
    functions: {
      // swapExactIn(assetIn, assetOut, amountIn, minAmountOut, receiver, referralCode)
      swapExactIn: (args, user) => convertToUser(ENTRY_AT("psm3"))([{ tokenIn: args[0], tokenOut: args[1], recipient: args[4] }], user),
    },
  },
  ...(GOOSE_EXECUTOR
    ? [
        {
          targets: [GOOSE_EXECUTOR],
          abi: gooseExecutorAbi,
          functions: { setMix: (args: readonly unknown[]) => isMix(args[0] as readonly number[]), setKeepMix: () => true },
        },
      ]
    : []),
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

export type SwapParams = { tokenIn: Address; tokenOut: Address; recipient: Address; amountIn: bigint };

/** The swap a router call makes (Uniswap's inside its multicall), or null when the call isn't a swap. */
export function swapOf(c: { to: Address; data: Hex }): { router: Address; params: SwapParams } | null {
  try {
    if (isAddressEqual(c.to, AERODROME.ROUTER)) {
      return { router: AERODROME.ROUTER, params: decodeFunctionData({ abi: aeroRouterAbi, data: c.data }).args[0] };
    }
    if (isAddressEqual(c.to, UNISWAP.SWAP_ROUTER_02)) {
      const call = decodeFunctionData({ abi: swapRouter02Abi, data: c.data });
      const inner = call.functionName === "multicall" ? innerSwap(call.args[1]) : null;
      return inner ? { router: UNISWAP.SWAP_ROUTER_02, params: inner[0] as SwapParams } : null;
    }
  } catch {
    /* not a swap */
  }
  return null;
}
