"use client";

import { useQuery } from "@tanstack/react-query";
import { accountName } from "@/lib/jaw/name";

/** The account's JAW name (Header: "Hi, Sam / sam.justan.id"). Names rarely change, so it's read once per 5 minutes. */
export function useAccountName(address: `0x${string}`) {
  return useQuery({
    queryKey: ["name", address.toLowerCase()],
    queryFn: () => accountName(address),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
