"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { usePublicClient } from "wagmi";
import { TxStop, txKey, useTx, type TxPlan } from "./useTx";
import { CHAIN_ID } from "@/lib/chain";
import { addContactsCalls, ContactsStop, removeContactCalls } from "@/lib/efp/contacts";
import { fetchFollowing } from "@/lib/efp/read";
import { accountName } from "@/lib/jaw/name";

/** The people `address` added as contacts: its EFP list on Base, read from the chain (no server, D12). */
export function useFollowing(address: Address) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["contacts", address.toLowerCase()],
    queryFn: () => fetchFollowing(client!, address),
    enabled: !!client,
    staleTime: 30_000,
    retry: 1,
  });
}

/** A change to the contacts: add one or several (one JAW sheet), or remove one. */
export type ContactsChange = { verb: "add" | "remove"; user: Address; targets: Address[] };

/**
 * What a contacts change signs (useTx): the list is read again while it's prepared, so a change made elsewhere since
 * the screen loaded isn't undone. Keyed by the change and its people, in any order.
 */
export function contactsPlan(c: ContactsChange, client: ReturnType<typeof usePublicClient>): TxPlan {
  const fresh = async <T,>(build: () => Promise<T>) => {
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
        return c.verb === "add" ? addContactsCalls(c.user, c.targets, following) : removeContactCalls(c.user, c.targets[0], following);
      }),
    fallback: c.verb === "add" ? "Adding didn’t go through right now. Try again in a moment." : "Removing didn’t go through right now. Try again in a moment.",
  };
}

/**
 * Add contacts (one or several, one JAW sheet) and remove one, through the one write path (useTx). `change` is the
 * one on screen (null while there's none): its batch is prepared while the screen is idle, with the list read again,
 * so `sign()` opens JAW's sheet straight from the tap; `sign(contactsPlan(other, client))` signs another one. The
 * network fee is paid in USDC like every batch (D4). After the batch lands useTx re-reads everything, the list and the
 * board included.
 */
export function useContactsTx(change: ContactsChange | null) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const tx = useTx(
    "This didn’t go through on Base. Your contacts are as they were, apart from any network fee.",
    change ? contactsPlan(change, client) : null,
  );
  return { ...tx, planOf: (c: ContactsChange) => contactsPlan(c, client) };
}

/** JAW names for `addresses` ("sam.justan.id"), read once per 5 minutes each; null for an account without one. */
export function useNames(addresses: readonly Address[]) {
  const results = useQueries({
    queries: addresses.map((a) => ({
      queryKey: ["name", a.toLowerCase()],
      queryFn: () => accountName(a),
      staleTime: 5 * 60_000,
      retry: 1,
    })),
  });
  const names = new Map<string, string | null>();
  addresses.forEach((a, i) => {
    if (results[i]?.data !== undefined) names.set(a.toLowerCase(), results[i].data ?? null);
  });
  return names;
}
