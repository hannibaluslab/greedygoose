import { decodeFunctionData, erc20Abi, isAddressEqual, toFunctionSelector, type Abi, type Hex } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { isMix } from "@/lib/agents/mix";
import { gooseBoardAbi } from "@/lib/board/abi";
import { GOOSE_BOARD } from "@/lib/board/config";
import { recipientBlock } from "@/lib/contracts";
import {
  decodeListOp,
  decodeListStorageLocation,
  efpListMinterAbi,
  efpListRecordsAbi,
  EFP_CHAIN_ID,
  EFP_LIST_MINTER,
  EFP_LIST_RECORDS,
  MAX_LIST_OPS,
} from "@/lib/efp/efp";
import { GUARDIAN } from "@/lib/guardian/config";
import { aaveV3PoolAbi } from "@/lib/guardian/abis";
import { aeroRouterAbi, psm3Abi, swapRouter02Abi } from "@/lib/swap/abis";
import { AERODROME, AERODROME_V1, ROUTERS, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS, type EntryVenue } from "@/lib/tokens/stables";

type Address = `0x${string}`;
/**
 * What a check may look at besides the call's own arguments: the user's own EFP list slots (the one it already has,
 * read from Base by the caller, and any minted in the same batch), the call's raw data, and who a Send pays (`sendTo`,
 * declared by the Send builder alone; null in every other batch, so no other batch can carry a transfer).
 */
type BatchContext = { listSlots: readonly bigint[]; data: Hex; sendTo: Address | null };
/** True when a call's arguments keep the money with `user`. */
type ArgsCheck = (args: readonly unknown[], user: Address, ctx: BatchContext) => boolean;
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
const swapWithDeadline: ArgsCheck = (args, user, ctx) => {
  const inner = innerSwap(args[1] as readonly Hex[]);
  return !!inner && swapToUser(ENTRY_AT("uniswap"))(inner, user, ctx);
};

/** An EFP list location on Base, in the records contract the app reads (lib/efp/read.ts): the slot it mints. */
function baseListSlot(location: unknown): bigint | null {
  const loc = typeof location === "string" ? decodeListStorageLocation(location as Hex) : null;
  return loc && loc.chainId === BigInt(EFP_CHAIN_ID) && isAddressEqual(loc.records, EFP_LIST_RECORDS) ? loc.slot : null;
}
/** EFP's easyMint(location): only a list on Base, in that records contract. It mints to the caller, the user. */
const mintsBaseList: ArgsCheck = (args) => baseListSlot(args[0]) !== null;
/**
 * EFP's applyListOps(slot, ops): only the user's own list (its slot read from Base, or minted in the same batch), and
 * only "add" or "remove" ops of one address each, at most MAX_LIST_OPS of them. No tags, no other record types.
 */
const ownListOps: ArgsCheck = (args, _user, ctx) => {
  const [slot, ops] = args as [bigint, readonly Hex[]];
  return ctx.listSlots.includes(slot) && ops.length > 0 && ops.length <= MAX_LIST_OPS && ops.every((op) => decodeListOp(op) !== null);
};
/**
 * Send (Adrian, 2026-10-15: "let user send their assets out"), the one way money leaves the user's pockets:
 * transfer(to, amount) of USDC or a registry stock, only in a batch that declares who it pays (`sendTo`), only to that
 * address, never to the user, the zero address or any of the app's or its protocols' contracts, and for more than 0.
 * It is user-signed only: no agent permission lists `transfer` (lib/agents/permissions.ts).
 */
const transferOut: ArgsCheck = (args, user, ctx) => {
  const [to, amount] = args as [unknown, unknown];
  return (
    !!ctx.sendTo &&
    is(to, ctx.sendTo) &&
    recipientBlock(to as Address, user) === null &&
    typeof amount === "bigint" &&
    amount > 0n
  );
};
/** GooseBoard.join(): exactly its selector, nothing after it. */
const JOIN = toFunctionSelector("join()");
const bareJoin: ArgsCheck = (args, _user, ctx) => args.length === 0 && ctx.data.toLowerCase() === JOIN;

/**
 * The one allowlist for user-signed batches (CLAUDE.md › Transaction safety): each target, the only
 * functions it may be called with, and what their arguments must say. Money only moves between the
 * user's own pockets: an approve names only the spoke or a router, every position, withdrawal and
 * swap pays the user, and savings come out only as USDC. The one exception is a Send's single transfer,
 * to the recipient its batch declares (`transferOut`). Buys, repays and savings-first batches mix
 * targets, so each target is held to its own functions. An Entry coin is approved only to the venue that converts
 * it, and converted only into USDC (D20). GooseExecutor's settings move no money and apply to the signer alone
 * (`msg.sender`): a mix must add up to 100% (or clear it).
 */
const RULES: readonly Rule[] = [
  { targets: TOKENS, abi: erc20Abi, functions: { approve: (args) => oneOf(args[0], SPENDERS), transfer: transferOut } },
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
      swapExactIn: (args, user, ctx) => convertToUser(ENTRY_AT("psm3"))([{ tokenIn: args[0], tokenOut: args[1], recipient: args[4] }], user, ctx),
    },
  },
  { targets: [EFP_LIST_MINTER], abi: efpListMinterAbi, functions: { easyMint: mintsBaseList } },
  { targets: [EFP_LIST_RECORDS], abi: efpListRecordsAbi, functions: { applyListOps: ownListOps } },
  ...(GOOSE_BOARD ? [{ targets: [GOOSE_BOARD], abi: gooseBoardAbi, functions: { join: bareJoin } }] : []),
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

/**
 * What a batch's builder tells the allowlist: the user's EFP list slot as read from Base (`listSlot`), and, for a Send
 * only, who it pays (`sendTo`).
 */
export type AllowContext = { listSlot?: bigint | null; sendTo?: Address };

/**
 * Throws unless every call is allowed. `own.listSlot` is the user's EFP list slot as read from Base
 * (lib/efp/read.ts checks the list is the user's own); a batch that mints a list may also write to the slot it mints.
 * `own.sendTo` lets the batch carry one transfer, to that address (`transferOut`).
 */
export function assertAllowed<C extends { to: Address; data: Hex; value: bigint }>(user: Address, calls: C[], own?: AllowContext): C[] {
  const listSlots: bigint[] = own?.listSlot != null ? [own.listSlot] : [];
  const sendTo = own?.sendTo ?? null;
  let transfers = 0;
  for (const c of calls) {
    if (!isAddressEqual(c.to, EFP_LIST_MINTER)) continue;
    try {
      const { args } = decodeFunctionData({ abi: efpListMinterAbi, data: c.data });
      const slot = baseListSlot(args[0]);
      if (slot !== null) listSlots.push(slot);
    } catch {
      /* blocked below */
    }
  }
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
    // Outside a Send (no recipient declared), transfer is no function of any target at all.
    if (!check || (call.functionName === "transfer" && !sendTo)) throw new Error(`Blocked: unexpected call to ${c.to}`);
    if (call.functionName === "transfer" && ++transfers > 1) throw new Error("Blocked: more than one transfer");
    if (!check(call.args ?? [], user, { listSlots, data: c.data, sendTo })) {
      throw new Error(
        call.functionName === "approve"
          ? `Blocked: unexpected spender ${call.args?.[0]}`
          : call.functionName === "transfer"
            ? `Blocked: unexpected recipient ${call.args?.[0]}`
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
