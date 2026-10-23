import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  isAddressEqual,
  toFunctionSelector,
  type Abi,
  type Hex,
} from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { GOOSE_GUARD } from "@/lib/agents/config";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { linesOk } from "@/lib/agents/lines";
import { isMix, unpackMix } from "@/lib/agents/mix";
import { agentJobOf } from "@/lib/agents/agentJob";
import { isLegacyGrant } from "@/lib/agents/legacy";
import { GRANT_SECONDS, JOBS, type JawPermission } from "@/lib/agents/permissions";
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
import { PROTOCOLS } from "@/lib/protocols/config";
import { aaveV3PoolAbi, justanAccountAbi, permissionManagerAbi, permissionTuple } from "@/lib/protocols/abis";
import { aeroRouterAbi, psm3Abi, swapRouter02Abi } from "@/lib/swap/abis";
import { AERODROME, AERODROME_V1, ROUTERS, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { CASH_COINS, type EntryVenue } from "@/lib/tokens/stables";

type Address = `0x${string}`;
/**
 * What a check may look at besides the call's own arguments: the user's own EFP list slots (the one it already has,
 * read from Base by the caller, and any minted in the same batch), the call's target and raw data, who a Send pays
 * (`sendTo`, declared by the Send builder alone; null in every other batch, so no other batch can carry a transfer),
 * and whether the batch saves for the user (`saveTo`, declared by the Earn with stocks and Start earning builders alone)
 * with the amount of its one savings supply (`saveRaw`, read from the batch; null when it has none).
 */
type BatchContext = {
  listSlots: readonly bigint[];
  to: Address;
  data: Hex;
  sendTo: Address | null;
  saveTo: Address | null;
  saveRaw: bigint | null;
};
/** True when a call's arguments keep the money with `user`. */
type ArgsCheck = (args: readonly unknown[], user: Address, ctx: BatchContext) => boolean;
type Rule = { targets: readonly Address[]; abi: Abi; functions: Record<string, ArgsCheck> };

const is = (a: unknown, b: Address) => typeof a === "string" && isAddressEqual(a as Address, b);
const oneOf = (a: unknown, list: readonly Address[]) => list.some((b) => is(a, b));

const TOKENS: readonly Address[] = [USDC.address, ...EQUITIES.map((e) => e.address)];
const SPENDERS: readonly Address[] = [AAVE.SPOKE, ...ROUTERS];

/** Where a coin of Turn into cash is converted (lib/tokens/stables.ts), and the pool its swap names there. */
const venueOf = (v: EntryVenue): Address => (v.kind === "psm3" ? v.psm : v.router);
const poolOf = (v: EntryVenue) => (v.kind === "aerodrome" ? v.tickSpacing : v.kind === "uniswap" ? v.fee : null);

/** Aave V4 spoke calls: the third argument (onBehalfOf) is the position, and it must be the user's. */
const forUser: ArgsCheck = (args, user) => is(args[2], user);
type SwapArgs = { tokenIn: unknown; tokenOut: unknown; recipient: unknown };
/** A swap between registry tokens that pays out to the user. */
const swapToUser: ArgsCheck = (args, user) => {
  const p = args[0] as SwapArgs;
  return is(p.recipient, user) && oneOf(p.tokenIn, TOKENS) && oneOf(p.tokenOut, TOKENS);
};
/**
 * A coin of Turn into cash into USDC for the user, on the one venue (`ctx.to`) and pool (`pool`: Aerodrome's tick
 * spacing, Uniswap's fee, none at PSM3) that converts it, and nothing else.
 */
const convertsForUser = (p: SwapArgs, pool: unknown, user: Address, ctx: BatchContext) => {
  const coin = CASH_COINS.find((c) => is(p.tokenIn, c.address));
  return (
    !!coin &&
    is(p.recipient, user) &&
    is(p.tokenOut, USDC.address) &&
    is(ctx.to, venueOf(coin.venue)) &&
    pool === poolOf(coin.venue)
  );
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
  if (!inner) return false;
  const p = inner[0] as SwapArgs & { fee: unknown };
  return swapToUser(inner, user, ctx) || convertsForUser(p, p.fee, user, ctx);
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
  return (
    ctx.listSlots.includes(slot) &&
    ops.length > 0 &&
    ops.length <= MAX_LIST_OPS &&
    ops.every((op) => decodeListOp(op) !== null)
  );
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
/**
 * Earn with stocks (Adrian, 2026-10-15: "the user should be able to put stocks get cash in saving"), Start earning
 * (the wallet's idle cash into savings, the same day) and a sale into cash (what it brings, Adrian 2026-10-18), the one
 * user-signed savings supply: Aave V3's
 * supply(asset, amount, onBehalfOf, referralCode) of USDC, for the user, referral code 0, more than 0, only in a batch
 * that declares it saves for the user (`saveTo`), once per batch.
 */
const saveForUser: ArgsCheck = (args, user, ctx) => {
  const [asset, amount, onBehalfOf, referralCode] = args;
  return (
    !!ctx.saveTo &&
    is(ctx.saveTo, user) &&
    is(asset, USDC.address) &&
    is(onBehalfOf, user) &&
    referralCode === 0 &&
    typeof amount === "bigint" &&
    amount > 0n
  );
};
/** The USDC approve for that supply: to Aave V3's pool, for exactly what the batch's one savings supply puts in. */
const savingsApprove: ArgsCheck = (args, user, ctx) =>
  !!ctx.saveTo &&
  is(ctx.saveTo, user) &&
  ctx.saveRaw !== null &&
  is(ctx.to, USDC.address) &&
  is(args[0], PROTOCOLS.AAVE_V3_POOL) &&
  args[1] === ctx.saveRaw;

/** The job a permission is a grant of: `user`'s own, to GooseGuard, exactly one job's template; null for anything else. */
const ownAgentJob = (p: unknown, user: Address) =>
  GOOSE_GUARD && !!p && typeof p === "object" ? agentJobOf(p as JawPermission, user, GOOSE_GUARD) : null;
const isOwnAgentGrant = (p: unknown, user: Address): boolean => ownAgentJob(p, user) !== null;

/**
 * GooseGuard's register(job, permission): the permission (abi.encode(permission), as the manager logs it) is the user's
 * own, granted to the Guard, exactly one job's template, and that job is the one it is registered as. The Guard runs
 * only its own fixed calls for the job it is told, so this check is what binds a grant to its agent (spec-final-v2.md
 * §5, a release blocker). It moves no money; the manager still checks the grant before every agent batch.
 */
const registersOwnGrant: ArgsCheck = (args, user, ctx) => {
  try {
    const [job, permission] = args as [number, Hex];
    const [p] = decodeAbiParameters([permissionTuple], permission);
    const own = ownAgentJob(p, user);
    return is(ctx.to, GOOSE_GUARD ?? "0x") && own !== null && JOBS[job] === own;
  } catch {
    return false;
  }
};

/**
 * How far ahead of the device's clock a new grant may start: not at all. GooseGuard refuses a grant that starts after
 * the block it lands in (FutureStart), so the app picks a start behind the device's clock and Base's (lib/agents/picks.ts).
 */
const START_AHEAD_SEC = 0;

/**
 * JAW's permission manager: approve(permission) only for the user's own grant to GooseGuard, exactly one job's
 * template, for a year from a start no later than now (D14 dropped, Adrian 2026-10-20: the permission, the cash move
 * and the registration in one signature). JAW's batch sheet shows no window, so the allowlist holds it. It moves no
 * money itself; every agent move is still held to the template and the Guard's own checks.
 */
const approvesOwnAgent: ArgsCheck = (args, user) => {
  const p = args[0] as JawPermission | undefined;
  return (
    isOwnAgentGrant(p, user) &&
    p!.end - p!.start === GRANT_SECONDS &&
    p!.start <= Math.floor(Date.now() / 1000) + START_AHEAD_SEC
  );
};

/**
 * revoke(permission): only a grant of the user's own to GooseGuard (a job turned off, or one a new grant replaces), or
 * to main's GooseExecutor (GG-05: an old grant left approved after the move, taken back in the same batch).
 */
const revokesOwnAgent: ArgsCheck = (args, user) => isOwnAgentGrant(args[0], user) || isLegacyGrant(args[0], user);

/** GooseBoard.join(): exactly its selector, nothing after it. */
const JOIN = toFunctionSelector("join()");
const bareJoin: ArgsCheck = (args, _user, ctx) => args.length === 0 && ctx.data.toLowerCase() === JOIN;

/**
 * GooseGuard.endRescue(): exactly its selector, nothing after it. The account ends its own rescue when it takes more
 * credit or repays by hand (decision 5); it moves no money and does nothing when no rescue is on.
 */
const END_RESCUE = toFunctionSelector("endRescue()");
const bareEndRescue: ArgsCheck = (args, _user, ctx) => args.length === 0 && ctx.data.toLowerCase() === END_RESCUE;

/**
 * The one allowlist for user-signed batches (CLAUDE.md › Transaction safety): each target, the only
 * functions it may be called with, and what their arguments must say. Money only moves between the
 * user's own pockets: an approve names only the spoke or a router, every position, withdrawal and
 * swap pays the user, and savings come out only as USDC. The one exception is a Send's single transfer,
 * to the recipient its batch declares (`transferOut`). Savings go in only in Earn with stocks', Start earning's and a
 * sale into cash's batches, which declare it (`saveTo`): one USDC supply for the user, approved to Aave V3's pool for exactly that amount
 * (`saveForUser`, `savingsApprove`). Buys, repays and savings-first batches mix
 * targets, so each target is held to its own functions. A coin of Turn into cash is approved only to the venue that
 * converts it, and converted only there, at its own pool, into USDC (D20). GooseGuard's settings move no money and apply to the signer alone
 * (`msg.sender`): a mix must add up to 100% (or clear it), Protect's line and target must be ones it takes. Its registrations move none either, and name only the user's
 * own grants to it, each for its own job (`registersOwnGrant`); `unregister` names a job, and `endRescue` nothing.
 */
const RULES: readonly Rule[] = [
  {
    targets: TOKENS,
    abi: erc20Abi,
    functions: {
      approve: (args, user, ctx) => oneOf(args[0], SPENDERS) || savingsApprove(args, user, ctx),
      transfer: transferOut,
    },
  },
  ...CASH_COINS.map((c) => ({
    targets: [c.address],
    abi: erc20Abi,
    functions: { approve: (args: readonly unknown[]) => is(args[0], venueOf(c.venue)) },
  })),
  {
    targets: [AAVE.SPOKE],
    abi: spokeAbi,
    functions: { supply: forUser, setUsingAsCollateral: forUser, withdraw: forUser, borrow: forUser, repay: forUser },
  },
  {
    targets: [PROTOCOLS.AAVE_V3_POOL],
    abi: aaveV3PoolAbi,
    functions: { withdraw: (args, user) => is(args[0], USDC.address) && is(args[2], user), supply: saveForUser },
  },
  { targets: [AERODROME.ROUTER], abi: aeroRouterAbi, functions: { exactInputSingle: swapToUser } },
  {
    targets: [AERODROME_V1.ROUTER],
    abi: aeroRouterAbi,
    functions: {
      exactInputSingle: (args, user, ctx) => {
        const p = args[0] as SwapArgs & { tickSpacing: unknown };
        return convertsForUser(p, p.tickSpacing, user, ctx);
      },
    },
  },
  { targets: [UNISWAP.SWAP_ROUTER_02], abi: swapRouter02Abi, functions: { multicall: swapWithDeadline } },
  {
    targets: [SPARK_PSM3.PSM3],
    abi: psm3Abi,
    functions: {
      // swapExactIn(assetIn, assetOut, amountIn, minAmountOut, receiver, referralCode)
      swapExactIn: (args, user, ctx) =>
        convertsForUser({ tokenIn: args[0], tokenOut: args[1], recipient: args[4] }, null, user, ctx),
    },
  },
  { targets: [EFP_LIST_MINTER], abi: efpListMinterAbi, functions: { easyMint: mintsBaseList } },
  { targets: [EFP_LIST_RECORDS], abi: efpListRecordsAbi, functions: { applyListOps: ownListOps } },
  ...(GOOSE_BOARD ? [{ targets: [GOOSE_BOARD], abi: gooseBoardAbi, functions: { join: bareJoin } }] : []),
  ...(GOOSE_GUARD
    ? [
        {
          targets: [PROTOCOLS.PERMISSION_MANAGER],
          abi: permissionManagerAbi,
          functions: { approve: approvesOwnAgent, revoke: revokesOwnAgent },
        },
        {
          targets: [GOOSE_GUARD],
          abi: guardAbi,
          functions: {
            // The mix packed as GooseGuard keeps it: 16 bits a stock, adding up to 100% (or all 0, which clears it).
            setMix: (args: readonly unknown[]) =>
              typeof args[0] === "bigint" && args[0] < 1n << 112n && isMix(unpackMix(args[0])),
            setKeepMix: () => true,
            // Protect's line and target, as the Guard takes them (lib/agents/lines.ts), or (0, 0) for its defaults.
            setProtect: (args: readonly unknown[]) =>
              typeof args[0] === "number" &&
              typeof args[1] === "number" &&
              ((args[0] === 0 && args[1] === 0) || linesOk(args[0], args[1])),
            // Top-ups go into my mix: a switch, and Keep as cash in whole USDC units up to $1,000,000 (KEEP_MAX_USD).
            setTopUps: (args: readonly unknown[]) =>
              typeof args[0] === "boolean" && typeof args[1] === "number" && args[1] >= 0 && args[1] <= 10 ** 12,
            register: registersOwnGrant,
            unregister: (args: readonly unknown[]) =>
              typeof args[0] === "number" && args[0] >= 0 && args[0] < JOBS.length,
            endRescue: bareEndRescue,
          },
        },
      ]
    : []),
];

/**
 * What a batch's builder tells the allowlist: the user's EFP list slot as read from Base (`listSlot`), for a Send only,
 * who it pays (`sendTo`), and for Earn with stocks and Start earning only, that it saves for the user (`saveTo`, which
 * must be the user).
 */
export type AllowContext = { listSlot?: bigint | null; sendTo?: Address; saveTo?: Address };

const isSavingsSupply = (to: Address, functionName: string) =>
  isAddressEqual(to, PROTOCOLS.AAVE_V3_POOL) && functionName === "supply";

/** The amount of the batch's one savings supply (null when it has none); more than one is refused. */
function savingsSupplyRaw(calls: readonly { to: Address; data: Hex }[]): bigint | null {
  let raw: bigint | null = null;
  for (const c of calls) {
    if (!isAddressEqual(c.to, PROTOCOLS.AAVE_V3_POOL)) continue;
    let call: { functionName: string; args?: readonly unknown[] };
    try {
      call = decodeFunctionData({ abi: aaveV3PoolAbi, data: c.data });
    } catch {
      continue; // blocked below
    }
    if (call.functionName !== "supply") continue;
    if (raw !== null) throw new Error("Blocked: more than one savings supply");
    raw = typeof call.args?.[1] === "bigint" ? call.args[1] : null;
  }
  return raw;
}

/**
 * Throws unless every call is allowed. `own.listSlot` is the user's EFP list slot as read from Base
 * (lib/efp/read.ts checks the list is the user's own); a batch that mints a list may also write to the slot it mints.
 * `own.sendTo` lets the batch carry one transfer, to that address (`transferOut`). `own.saveTo` (the user, no one else)
 * lets it carry one USDC savings supply for the user and its exact approve (`saveForUser`, `savingsApprove`).
 */
export function assertAllowed<C extends { to: Address; data: Hex; value: bigint }>(
  user: Address,
  calls: C[],
  own?: AllowContext,
): C[] {
  const sendTo = own?.sendTo ?? null;
  const saveTo = own?.saveTo ?? null;
  if (saveTo && !isAddressEqual(saveTo, user)) throw new Error("Blocked: savings are only for the user");
  const saveRaw = saveTo ? savingsSupplyRaw(calls) : null;
  const batch = { listSlots: listSlotsOf(calls, own), sendTo, saveTo, saveRaw };
  const count = { transfers: 0, savingsApproves: 0 };
  for (const c of calls) assertCall(c, user, batch, count);
  assertGrantsPaired(user, calls);
  return calls;
}

/**
 * A batch's agent grants, as a whole: each approve in the manager is registered later in the same batch, exactly as
 * approved and as its own job (a grant approved and left unregistered stays approved for the account to register
 * later, and one registered as another job would run that job's moves), at most one approve a job, and the owner call
 * (addOwnerAddress(manager)) only once, before the first approve of a batch that has one.
 */
function assertGrantsPaired(user: Address, calls: readonly { to: Address; data: Hex }[]) {
  if (!GOOSE_GUARD) return;
  const guard = GOOSE_GUARD;
  const approves: { index: number; encoded: Hex; job: string }[] = [];
  const registers: { index: number; encoded: Hex; job: string }[] = [];
  const owners: number[] = [];
  calls.forEach((c, index) => {
    if (isAddressEqual(c.to, user)) owners.push(index);
    else if (isAddressEqual(c.to, PROTOCOLS.PERMISSION_MANAGER)) {
      const { functionName, args } = decodeFunctionData({ abi: permissionManagerAbi, data: c.data });
      if (functionName !== "approve") return;
      const p = args[0] as JawPermission;
      const encoded = encodeAbiParameters([permissionTuple], [p]).toLowerCase() as Hex;
      approves.push({ index, encoded, job: agentJobOf(p, user, guard) ?? "" });
    } else if (isAddressEqual(c.to, guard)) {
      const call = decodeFunctionData({ abi: guardAbi, data: c.data });
      if (call.functionName === "register") {
        const [job, permission] = call.args;
        registers.push({ index, encoded: permission.toLowerCase() as Hex, job: JOBS[job] ?? "" });
      }
    }
  });
  if (new Set(approves.map((a) => a.job)).size !== approves.length)
    throw new Error("Blocked: two grants for one agent");
  for (const a of approves) {
    if (!registers.some((r) => r.index > a.index && r.encoded === a.encoded && r.job === a.job))
      throw new Error("Blocked: a grant that isn’t switched on in the same batch");
  }
  if (owners.length > 1 || (owners.length === 1 && (approves.length === 0 || owners[0] > approves[0].index)))
    throw new Error("Blocked: unexpected owner change");
}

/** The list slots a batch may write to: the user's own, as read from Base, and any slot a call in the batch mints. */
function listSlotsOf(calls: readonly { to: Address; data: Hex }[], own?: AllowContext): bigint[] {
  const listSlots: bigint[] = own?.listSlot != null ? [own.listSlot] : [];
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
  return listSlots;
}

/**
 * One call's checks, in order: a known target, no value, a known function of it (transfer only in a Send, a savings
 * supply only with `saveTo`), no unlimited approve, at most one transfer and one savings approval in the batch
 * (`count`), then its arguments.
 */
function assertCall(
  c: { to: Address; data: Hex; value: bigint },
  user: Address,
  batch: Omit<BatchContext, "to" | "data">,
  count: { transfers: number; savingsApproves: number },
) {
  if (isAddressEqual(c.to, user)) return assertOwnerCall(c);
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
  // Outside a Send (no recipient declared), transfer is no function of any target at all; outside Earn with stocks and
  // Start earning (no saveTo declared), neither is a savings supply.
  if (
    !check ||
    (call.functionName === "transfer" && !batch.sendTo) ||
    (isSavingsSupply(c.to, call.functionName) && !batch.saveTo)
  ) {
    throw new Error(`Blocked: unexpected call to ${c.to}`);
  }
  // A token's approve (the manager's approve takes a permission, not an amount).
  const tokenApprove = call.functionName === "approve" && rule.abi === erc20Abi;
  if (tokenApprove && !limitedApprove(call.args?.[1])) {
    throw new Error(`Blocked: unexpected unlimited approve to ${call.args?.[0]}`);
  }
  if (call.functionName === "transfer" && ++count.transfers > 1) throw new Error("Blocked: more than one transfer");
  if (tokenApprove && is(call.args?.[0], PROTOCOLS.AAVE_V3_POOL) && ++count.savingsApproves > 1) {
    throw new Error("Blocked: more than one savings approval");
  }
  if (!check(call.args ?? [], user, { ...batch, to: c.to, data: c.data })) {
    throw new Error(blockedArgs(call.functionName, call.args?.[0], c.to));
  }
}

/**
 * A call to the user's own account: only addOwnerAddress(the permission manager), the call JAW's SDK puts first when
 * the manager doesn't own the account yet, so agent runs can go through it (lib/agents/oneTapGrant.ts
 * `managerOwnerCalls`). No other owner, and nothing else on the account.
 */
function assertOwnerCall(c: { to: Address; data: Hex; value: bigint }) {
  if (c.value !== 0n) throw new Error("Blocked: unexpected value");
  let call: { functionName: string; args?: readonly unknown[] };
  try {
    call = decodeFunctionData({ abi: justanAccountAbi, data: c.data });
  } catch {
    throw new Error("Blocked: unexpected call to your account");
  }
  if (call.functionName !== "addOwnerAddress" || !is(call.args?.[0], PROTOCOLS.PERMISSION_MANAGER)) {
    throw new Error("Blocked: unexpected owner change");
  }
}

/**
 * Every approve, on every target (USDC, the stocks, Turn into cash's coins, the savings approve), is for an exact amount:
 * max uint, or anything from 2^128 up, counts as unlimited and is refused. No balance comes near it.
 */
const UNLIMITED_FROM = 2n ** 128n;
const limitedApprove = (amount: unknown) => typeof amount === "bigint" && amount < UNLIMITED_FROM;

/** Why a call's arguments were refused: an approve's spender, a transfer's recipient, or any other call's arguments. */
const blockedArgs = (functionName: string, first: unknown, to: Address) =>
  functionName === "approve"
    ? `Blocked: unexpected spender ${first}`
    : functionName === "transfer"
      ? `Blocked: unexpected recipient ${first}`
      : `Blocked: unexpected arguments to ${functionName} on ${to}`;

type SwapParams = {
  tokenIn: Address;
  tokenOut: Address;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
};

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
