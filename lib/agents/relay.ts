import { isAddressEqual, type Hex } from "viem";
import type { Permission, SpendPeriod, StorePermissionApiResponse } from "@jaw.id/core";
import { PERIOD_WORD } from "@/lib/agents/agentJob";
import type { JawPermission } from "@/lib/agents/permissions";
import { RELAY_PERMISSIONS_URL, relayRecord } from "@/lib/agents/oneTapGrant";

/*
 * JAW's list of the account's grants is its relay (`usePermissions`). JAW's own grant writes to it after its user
 * operation; a one-signature grant (lib/agents/oneTapGrant.ts) is the app's own batch, so the app writes the same record
 * once the batch lands, and again from any screen until the relay has it (catch-up). A record that didn't save is never
 * fixed by sending the batch again: on Start earning that would move the money twice. Status never waits on the relay
 * either: whether a job runs is read on Base (the executor's registry and the manager's isRevoked).
 */

/** What the app needs from JAW's relay: read one record by id, and write one (lib/agents/oneTapGrant.ts). */
export type RelayDeps = {
  /** The record stored under `id`; throws when there is none or the relay doesn't answer. */
  get: (id: Hex) => Promise<StorePermissionApiResponse>;
  /** Stores the record JAW's grant would; throws with the relay's words when it refuses. */
  store: (id: Hex, p: Permission) => Promise<unknown>;
};

/** A permission as the manager holds it (`permissionOf`, a batch's approve) in JAW's words; null for a period JAW has no word for. */
export function relayPermission(p: JawPermission): Permission | null {
  const spends: Permission["spends"] = [];
  for (const s of p.spends) {
    const unit = PERIOD_WORD[s.unit];
    if (!unit) return null;
    spends.push({ token: s.token, allowance: s.allowance, unit: unit as SpendPeriod, multiplier: s.multiplier });
  }
  return {
    account: p.account,
    spender: p.spender,
    start: p.start,
    end: p.end,
    salt: p.salt,
    calls: p.calls.map((c) => ({ target: c.target, selector: c.selector, checker: c.checker })),
    spends,
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";
const sameHex = (a: string, b: string) => {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
};
const sameAddress = (a: string, b: string) => {
  try {
    return isAddressEqual(a as Hex, b as Hex);
  } catch {
    return false;
  }
};

/** Whether the relay's record is exactly what JAW's grant stores for `p` under `id`. */
export function sameRecord(r: StorePermissionApiResponse, id: Hex, p: Permission, chainId: number): boolean {
  const want = relayRecord(id, p, chainId);
  return (
    sameHex(r.permissionId, want.permissionId) &&
    sameAddress(r.account, want.account) &&
    sameAddress(r.spender, want.spender) &&
    r.start === want.start &&
    r.end === want.end &&
    sameHex(r.salt, want.salt) &&
    r.calls.length === want.calls.length &&
    r.calls.every(
      (c, i) =>
        sameAddress(c.target, want.calls[i].target) &&
        c.selector.toLowerCase() === want.calls[i].selector.toLowerCase() &&
        sameAddress(c.checker ?? ZERO, want.calls[i].checker ?? ZERO),
    ) &&
    r.spends.length === want.spends.length &&
    r.spends.every(
      (s, i) =>
        sameAddress(s.token, want.spends[i].token) &&
        sameHex(s.allowance, want.spends[i].allowance) &&
        s.unit === want.spends[i].unit &&
        s.multiplier === want.spends[i].multiplier,
    )
  );
}

/** The relay's answer when the record is there already: as good as storing it. */
const ALREADY = /already exists|already stored|duplicate/i;

/**
 * Puts one grant in JAW's relay: the same record there already, done; otherwise stored (a record that's there and
 * isn't ours is written over where the relay allows it; the app never trusts a listed record it can't match on Base).
 * "Already exists" counts as done. Resolves whether the relay has it; never throws, so a failure only waits for the
 * next catch-up.
 */
export async function recordInRelay(id: Hex, p: Permission, chainId: number, deps: RelayDeps): Promise<boolean> {
  try {
    if (sameRecord(await deps.get(id), id, p, chainId)) return true;
  } catch {
    // none yet, or the relay didn't answer: storing says which
  }
  try {
    await deps.store(id, p);
    return true;
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    return status === 409 || (e instanceof Error && ALREADY.test(e.message));
  }
}

/**
 * Takes a revoked grant's record out of JAW's relay, as JAW's own revoke does after its user operation (core
 * `deletePermissionFromRelay`: DELETE on the record's path, `x-api-key` with a key). Best effort: a record left behind
 * is never trusted, since the app reads every listed grant's status on Base.
 */
export async function deleteFromRelay(
  permissionId: Hex,
  apiKey: string | undefined,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  try {
    const res = await fetchFn(`${RELAY_PERMISSIONS_URL}/${permissionId}`, {
      method: "DELETE",
      headers: { Accept: "application/json, text/plain, */*", ...(apiKey ? { "x-api-key": apiKey } : {}) },
    });
    return res.ok;
  } catch {
    return false;
  }
}
