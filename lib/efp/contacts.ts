import { isAddressEqual, type Address } from "viem";
import type { Call } from "@/lib/aave/tx";
import { assertAllowed } from "@/lib/allowlist";
import { buildFollowCalls, buildUnfollowCalls, MAX_LIST_OPS, randomListSlot } from "./efp";
import type { Following } from "./read";

/** Why a contacts change can't be built, in the user's words. */
export const CONTACTS_STOP = {
  elsewhere: "Your contacts list is kept somewhere this app can’t add to yet. Nothing was sent.",
  already: "Already in your contacts.",
  gone: "Not in your contacts any more.",
  tooMany: `Add up to ${MAX_LIST_OPS} people at a time.`,
} as const;

export class ContactsStop extends Error {}

const has = (list: readonly Address[], a: Address) => list.some((b) => isAddressEqual(a, b));

/**
 * Add `targets` to the user's contacts, as the list on Base says it is now (`f`, read right before JAW's sheet): one
 * applyListOps for all of them, after easyMint when the user has no list yet. People already in the list and the user
 * are left out. A list that lives elsewhere (another chain or records contract) is never replaced by a new one: that
 * would change which list is the account's primary.
 */
export function addContactsCalls(user: Address, targets: readonly Address[], f: Following, newSlot: () => bigint = randomListSlot): Call[] {
  if (f.hasList && f.slot === null) throw new ContactsStop(CONTACTS_STOP.elsewhere);
  const fresh = targets.filter((t, i) => !isAddressEqual(t, user) && !has(f.addresses, t) && targets.findIndex((u) => isAddressEqual(u, t)) === i);
  if (!fresh.length) throw new ContactsStop(CONTACTS_STOP.already);
  if (fresh.length > MAX_LIST_OPS) throw new ContactsStop(CONTACTS_STOP.tooMany);
  const slot = f.slot ?? newSlot();
  return assertAllowed(user, buildFollowCalls([...fresh], f.slot !== null, slot), { listSlot: f.slot });
}

/** Remove `target` from the user's contacts: EFP's remove op on the user's own list. */
export function removeContactCalls(user: Address, target: Address, f: Following): Call[] {
  if (f.slot === null || !has(f.addresses, target)) throw new ContactsStop(CONTACTS_STOP.gone);
  return assertAllowed(user, buildUnfollowCalls([target], f.slot), { listSlot: f.slot });
}
