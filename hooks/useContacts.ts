"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { usePublicClient } from "wagmi";
import { TxStop, useTx } from "./useTx";
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

/**
 * Add contacts (one or several, one JAW sheet) and remove one, through the one write path (useTx): the list is read
 * again right before JAW's sheet, so a change made elsewhere since the screen loaded isn't undone. The network fee is
 * paid in USDC like every batch (D4). After the batch lands useTx re-reads everything, the list and the board included.
 */
export function useContactsTx() {
  const tx = useTx("This didn’t go through on Base. Your contacts are as they were, apart from any network fee.");
  const client = usePublicClient({ chainId: CHAIN_ID });
  const fresh = async <T,>(build: () => Promise<T>) => {
    try {
      return await build();
    } catch (e) {
      throw e instanceof ContactsStop ? new TxStop(e.message) : e;
    }
  };
  const add = (user: Address, targets: Address[]) =>
    tx.run(user, () => fresh(async () => addContactsCalls(user, targets, await fetchFollowing(client!, user))), "Adding didn’t go through right now. Try again in a moment.");
  const remove = (user: Address, target: Address) =>
    tx.run(user, () => fresh(async () => removeContactCalls(user, target, await fetchFollowing(client!, user))), "Removing didn’t go through right now. Try again in a moment.");
  return { ...tx, add, remove };
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
