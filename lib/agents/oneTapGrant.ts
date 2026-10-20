import {
  bytesToHex,
  decodeEventLog,
  encodeFunctionData,
  isAddressEqual,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  JAW_BASE_URL,
  type Permission,
  type PermissionsDetail,
  type SpendPeriod,
  type StorePermissionApiResponse,
} from "@jaw.id/core";
import type { Call } from "@/lib/aave/tx";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { PERIOD, readAgentGrant, type JawPermission } from "@/lib/agents/permissions";
import { buildRegisterCalls, encodePermission } from "@/lib/agents/register";
import { justanAccountAbi, permissionManagerAbi } from "@/lib/protocols/abis";
import { PROTOCOLS } from "@/lib/protocols/config";

/*
 * One Face ID for an agent grant: the app's own batch approves the permission in JAW's manager and registers it with
 * GooseExecutor, in place of JAW's permission screen followed by a registration batch (D14 dropped, see
 * docs/JUSTALAB-DECISIONS.md). After the receipt the app records the grant in JAW's relay the way JAW's grant does, so
 * JAW still lists it (`usePermissions`) and can revoke it (`useRevokePermissions`).
 *
 * Everything here mirrors JAW's SDK, @jaw.id/core 1.6.3 `dist/rpc/permissions.js` `grantPermissions`: the same struct,
 * the same approve call, the same event read and the same relay POST (tests/unit/one-tap-grant.test.ts runs the SDK's
 * own grant next to these and compares them). Only the start and salt are picked by the app, before the batch, so the
 * registration in the same batch can carry them.
 */

const MANAGER = PROTOCOLS.PERMISSION_MANAGER as Address;
/** ERC-7528's native token: what JAW's grant puts in a spend that names no token (core `NATIVE_TOKEN`). */
const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** Where JAW's grant stores a permission: `JAW_PROXY_URL` + `PERMISSIONS_ROUTE` (core constants.js, api/routes). */
export const RELAY_PERMISSIONS_URL = `${JAW_BASE_URL}/proxy/v1/permissions`;

/** JustaPermissionManager's PeriodUnit for each word JAW's relay stores (core `periodToEnum`). A year is 12 months. */
const UNIT: Record<Exclude<SpendPeriod, "year">, number> = {
  minute: PERIOD.Minute,
  hour: PERIOD.Hour,
  day: PERIOD.Day,
  week: PERIOD.Week,
  month: PERIOD.Month,
  forever: PERIOD.Forever,
};

/**
 * A grant's start and salt, picked by the app as JAW's grant picks them (the browser's clock, 256 random bits), from a
 * secure source. A clock running ahead only delays the first run: the executor skips a grant before its start.
 */
export function grantPick(nowMs = Date.now()): { start: number; salt: bigint } {
  return { start: Math.floor(nowMs / 1000), salt: BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))) };
}

/**
 * The permission JAW's grant builds for a request (core `apiPermissionsToPermission`), with the app's start and salt in
 * place of its clock and `Math.random`: checker 0 on every call, a selector from the signature when none is given, the
 * native token when a spend names none, and × 1 unless the request says otherwise.
 */
export function jawPermission(
  account: Address,
  spender: Address,
  expiry: number,
  detail: PermissionsDetail,
  pick: { start: number; salt: bigint },
): Permission {
  return {
    account,
    spender,
    start: pick.start,
    end: expiry,
    salt: pick.salt,
    calls: (detail.calls ?? []).map((c) => {
      const selector = c.selector || (c.functionSignature ? toFunctionSelector(c.functionSignature) : undefined);
      if (!selector) throw new Error("Either selector or functionSignature must be provided for call permission");
      return { target: c.target, selector, checker: zeroAddress };
    }),
    spends: (detail.spends ?? []).map((s) => ({
      token: s.token && s.token.trim() !== "" ? s.token : NATIVE_TOKEN,
      allowance: BigInt(s.allowance),
      unit: s.unit,
      multiplier: s.multiplier ?? 1,
    })),
  };
}

/** The struct as the manager takes it (core `permissionToContractFormat`): each period as its PeriodUnit. */
export function contractPermission(p: Permission): JawPermission {
  return {
    ...p,
    calls: p.calls.map((c) => ({ ...c })),
    spends: p.spends.map(({ token, allowance, unit, multiplier }) => {
      const onChain = unit === "year" ? PERIOD.Month : UNIT[unit];
      if (onChain === undefined) throw new Error(`Unknown spend period ${unit}`);
      return { token, allowance, unit: onChain, multiplier: unit === "year" ? multiplier * 12 : multiplier };
    }),
  };
}

/** manager.approve(permission): byte for byte the call JAW's grant ends its user operation with. */
export const approveCall = (p: Permission): Call => ({
  to: MANAGER,
  data: encodeFunctionData({ abi: permissionManagerAbi, functionName: "approve", args: [contractPermission(p)] }),
  value: 0n,
});

/**
 * addOwnerAddress(manager) on the account itself, the call JAW's SDK puts first when the manager doesn't own the account
 * yet (core account/smartAccount.js `prepareEip7702Calls`). The manager runs agent batches through the account, so it
 * must own it, and GooseExecutor refuses a registration until it does (`ManagerNotOwner`).
 */
export const addManagerOwnerCall = (account: Address): Call => ({
  to: account,
  data: encodeFunctionData({ abi: justanAccountAbi, functionName: "addOwnerAddress", args: [MANAGER] }),
  value: 0n,
});

/**
 * The owner call a grant's batch needs, read on Base just before the batch is built:
 * - none for an account with no code yet: JAW's factory deploys it in the same user operation with the manager as its
 *   second owner (core account/accountRecord.js `ACCOUNT_RECIPE_V1`, owners [passkey, manager]);
 * - none when `isOwnerAddress(manager)` says the manager already owns it (every JAW passkey account);
 * - addOwnerAddress(manager) otherwise.
 * A read that fails throws: nothing is built on a guess (JAW's SDK treats a failed read as "not an owner"). An
 * EIP-7702 account is read like any other, though JAW's SDK adds the owner itself when it sends for one, so such a
 * batch would carry the call twice and revert; the app's passkey accounts are never one.
 */
export async function managerOwnerCalls(
  client: Pick<PublicClient, "getCode" | "readContract">,
  account: Address,
): Promise<Call[]> {
  const code = await client.getCode({ address: account });
  if (!code || code === "0x") return [];
  const owns = await client.readContract({
    address: account,
    abi: justanAccountAbi,
    functionName: "isOwnerAddress",
    args: [MANAGER],
  });
  return owns ? [] : [addManagerOwnerCall(account)];
}

/**
 * One batch, one Face ID: the owner call when `managerOwnerCalls` says so, each grant's approve, then the executor's
 * settings and one `registerApproved` per grant (lib/agents/register.ts). Atomic: each registration finds the approval
 * made earlier in the same batch. Every grant must be the user's own, to GooseExecutor, and exactly one job's template.
 * Start earning's savings supply goes in front, from its own builder.
 */
export function oneTapGrantCalls(
  user: Address,
  grants: readonly Permission[],
  owner: readonly Call[] = [],
  settings: readonly Call[] = [],
): Call[] {
  if (!GOOSE_EXECUTOR) throw new Error("Agents aren't available yet");
  const executor = GOOSE_EXECUTOR;
  if (grants.length === 0) throw new Error("Nothing to grant");
  for (const p of grants) {
    const own = isAddressEqual(p.account, user) && isAddressEqual(p.spender, executor);
    if (!own || !readAgentGrant(relayRecord("0x", p, PROTOCOLS.chainId), executor)) {
      throw new Error("Blocked: a grant that isn't one of the user's agents");
    }
  }
  const ownerCall = addManagerOwnerCall(user);
  const ownerOk = (c: Call) => isAddressEqual(c.to, ownerCall.to) && c.data === ownerCall.data && c.value === 0n;
  if (owner.length > 1 || !owner.every(ownerOk)) throw new Error("Blocked: unexpected owner change");
  return [...owner, ...grants.map(approveCall), ...buildRegisterCalls(user, grants.map(contractPermission), settings)];
}

/** A log as wallet_getCallsStatus returns it in a receipt (EIP-5792), or as viem reads it. */
type ReceiptLog = { address: string; data: Hex; topics: readonly Hex[] };

/**
 * The permission id in a grant's receipt, read as JAW's SDK reads it (core `extractPermissionHashFromTransaction`): the
 * hash in the first PermissionApproved the manager logged. A receipt holds the whole bundle's logs, other user
 * operations' included, so pass `permission` to take the one that logged exactly it.
 */
export function permissionIdFromReceipt(logs: readonly ReceiptLog[], permission?: Permission): Hex {
  const logged = permission && encodePermission(contractPermission(permission)).toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== MANAGER.toLowerCase()) continue;
    try {
      const topics = log.topics as [Hex, ...Hex[]];
      const e = decodeEventLog({ abi: permissionManagerAbi, data: log.data, topics });
      if (e.eventName === "PermissionApproved" && (!logged || log.data.toLowerCase() === logged)) {
        return e.args.permissionHash;
      }
    } catch {
      continue; // not one of the manager's events this ABI names
    }
  }
  throw new Error("PermissionApproved event not found in transaction receipt");
}

/** What JAW's grant sends its relay (core `storePermissionInRelay`, a StorePermissionApiRequest), field for field. */
export function relayRecord(permissionId: Hex, p: Permission, chainId: number): StorePermissionApiResponse {
  return {
    permissionId,
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: `0x${p.salt.toString(16)}`,
    calls: p.calls.map(({ target, selector, checker }) => ({ target, selector, checker })),
    spends: p.spends.map(({ token, allowance, unit, multiplier }) => ({
      token,
      allowance: `0x${allowance.toString(16)}`,
      unit,
      multiplier,
    })),
    chainId: `0x${chainId.toString(16)}`,
  };
}

/**
 * Records a grant in JAW's relay as JAW's grant does when it runs on the app's own page: the same POST, URL and body,
 * and the headers its axios call sends (Accept and the JSON Content-Type, `x-api-key` only with a key). The browser
 * adds the app's Origin. Resolves to the relay's record; throws with the relay's own error, as the SDK does (core
 * api/axiosController.js `controlledAxiosPromise`).
 */
export async function storePermissionInRelay(
  permissionId: Hex,
  p: Permission,
  chainId: number,
  apiKey: string | undefined,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<StorePermissionApiResponse> {
  const res = await fetchFn(RELAY_PERMISSIONS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify(relayRecord(permissionId, p, chainId)),
  });
  const body = (await res.json().catch(() => null)) as { result?: { data?: unknown; error?: string | null } } | null;
  const result = body?.result;
  if (!res.ok || !result || result.data === null || result.data === undefined) {
    const error = result?.error ?? `JAW's relay didn't record the permission (HTTP ${res.status})`;
    throw Object.assign(new Error(error), { status: res.status });
  }
  return result.data as StorePermissionApiResponse;
}
