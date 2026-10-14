"use client";

import { useSyncExternalStore } from "react";

const key = (account: string) => `gg.creditForBuying.v1.${account.toLowerCase()}`;
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function read(account: string): boolean {
  try {
    return localStorage.getItem(key(account)) !== "off";
  } catch {
    return true;
  }
}

/**
 * "Use credit for buying" (ManageCredit's switch, now on the Credit sheet): whether a buy bigger than your cash offers credit for the rest (decision 1).
 * On unless switched off. It only changes what this device's Buy sheet offers and moves nothing, so it lives in this
 * browser rather than on-chain, and needs no Face ID. Browser storage may be unavailable: then it stays on.
 */
export function useCreditForBuying(account: `0x${string}`) {
  const on = useSyncExternalStore(subscribe, () => read(account), () => true);
  const set = (next: boolean) => {
    try {
      localStorage.setItem(key(account), next ? "on" : "off");
    } catch {
      /* storage unavailable */
    }
    listeners.forEach((l) => l());
  };
  return [on, set] as const;
}
