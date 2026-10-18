"use client";

import { useEffect, useState } from "react";
import { liveDecimals, liveSavingsUsd, liveText } from "@/lib/liveEarning";

/** How often the counter redraws. */
const TICK_MS = 250;

/**
 * The savings balance, counting up between reads: "$0.99041237 earning". `readAt` is when Base was last read (the
 * position query's time), so every read restarts the count from the balance on chain and it never drifts.
 */
export function LiveEarning({ usd, apr, readAt }: { usd: number; apr: number; readAt: number }) {
  const [now, setNow] = useState(readAt);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  const value = liveSavingsUsd(usd, apr, (Math.max(now, readAt) - readAt) / 1000);
  return <span className="num tabular-nums">{liveText(value, liveDecimals(usd, apr))} earning</span>;
}
