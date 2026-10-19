import { addContactsCalls, ContactsStop, removeContactCalls } from "@/lib/efp/contacts";
import { fetchFollowing } from "@/lib/efp/read";
import { TxStop, txKey, type TxPlan } from "../prepared";
import type { Address } from "./types";

/** A change to the contacts: add one or several (one JAW sheet), or remove one. */
export type ContactsChange = { verb: "add" | "remove"; user: Address; targets: Address[] };

/**
 * What a contacts change signs (useTx): the list is read again while it's prepared, so a change made elsewhere since
 * the screen loaded isn't undone. Keyed by the change and its people, in any order.
 */
export function contactsPlan(c: ContactsChange, client: Parameters<typeof fetchFollowing>[0] | undefined): TxPlan {
  const fresh = async <T>(build: () => Promise<T>) => {
    try {
      return await build();
    } catch (e) {
      throw e instanceof ContactsStop ? new TxStop(e.message) : e;
    }
  };
  return {
    key: txKey("contacts", c.verb, c.user, [...new Set(c.targets.map((t) => t.toLowerCase()))].sort()),
    user: c.user,
    calls: () =>
      fresh(async () => {
        const following = await fetchFollowing(client!, c.user);
        return c.verb === "add"
          ? addContactsCalls(c.user, c.targets, following)
          : removeContactCalls(c.user, c.targets[0], following);
      }),
    fallback:
      c.verb === "add"
        ? "Adding didn’t go through right now. Try again in a moment."
        : "Removing didn’t go through right now. Try again in a moment.",
  };
}
