"use client";

import { useEffect, useState } from "react";
import { liveDecimals, liveEarnedUsd, liveText } from "@/lib/liveEarning";

/** How often the counter redraws. */
const TICK_MS = 250;

/** Holding still: cents, or enough digits that a sliver earned isn't shown as $0.00. */
const stillDecimals = (usd: number) => (usd === 0 || usd >= 0.01 ? 2 : Math.min(8, Math.ceil(-Math.log10(usd)) + 1));

/**
 * Total earned, counting up between reads: "$0.00015823". `readAt` is when Base was last read (useTotalEarned), so
 * every read restarts the count from the chain and it never drifts. With no savings it holds still.
 */
export function LiveEarning({
  earnedUsd,
  savingsUsd,
  apr,
  readAt,
  className,
}: {
  earnedUsd: number;
  savingsUsd: number;
  apr: number;
  readAt: number;
  className?: string;
}) {
  const counts = savingsUsd > 0;
  // The highest count shown so far. Base counts in whole micro-dollars, so a fresh read can land a hair under the
  // count: it never steps back.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!counts) return;
    const id = window.setInterval(
      () => setShown((prev) => Math.max(prev, liveEarnedUsd(earnedUsd, savingsUsd, apr, (Date.now() - readAt) / 1000))),
      TICK_MS,
    );
    return () => window.clearInterval(id);
  }, [counts, earnedUsd, savingsUsd, apr, readAt]);
  const value = Math.max(shown, liveEarnedUsd(earnedUsd, savingsUsd, apr, 0));
  const text = liveText(value, counts ? liveDecimals(savingsUsd, apr) : stillDecimals(value));
  // Long counters ("$0.00015823") step down a size so they fit the half-width card.
  return (
    <span className={`num tabular-nums ${text.length > 8 ? "text-[20px]" : "text-[26px]"} ${className ?? ""}`}>
      {text}
    </span>
  );
}
