"use client";

import { useSyncExternalStore } from "react";

/** Current time in seconds, refreshed every minute (render-safe; no Date.now() during render). */
const subscribeMinute = (cb: () => void) => {
  const id = setInterval(cb, 60_000);
  return () => clearInterval(id);
};
const minuteNow = () => Math.floor(Date.now() / 60_000) * 60;

export function useNowSec() {
  return useSyncExternalStore(subscribeMinute, minuteNow, () => 0);
}
