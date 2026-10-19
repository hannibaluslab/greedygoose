"use client";

import { useEffect, useState } from "react";
import { liveDecimals, liveEarnedUsd, liveText } from "@/lib/liveEarning";

/** How often the counter redraws. */
const TICK_MS = 250;

/** Holding still: cents, or enough digits that a sliver earned isn't shown as $0.00. */
const stillDecimals = (usd: number) => (usd === 0 || usd >= 0.01 ? 2 : Math.min(8, Math.ceil(-Math.log10(usd)) + 1));

/**
 * Earned all time, counting up between reads: "$0.000166448". `readAt` is when Base was last read (useTotalEarned), so
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
  // One digit past the one that moves each second (Adrian, 2026-10-18), so the count is seen running.
  const text = liveText(value, counts ? liveDecimals(savingsUsd, apr) + 1 : stillDecimals(value));
  return (
    <span className={`num flex items-center gap-1.5 tabular-nums ${className ?? ""}`}>
      {/*
        One size for the whole number (Adrian, 2026-10-18), 26px at most, down to what fits its container beside the dot
        (a digit is about 0.6em; the Yield card is the container, the sheet has none and keeps 26px).
      */}
      <span style={{ fontSize: `min(26px, calc((100cqw - 14px) / ${(text.length * 0.6).toFixed(1)}))` }}>{text}</span>
      {/* Live, as Aave marks its own counters: a green dot that breathes while the cash earns. */}
      {counts && (
        <span aria-hidden className="relative flex size-[7px]">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#2ebd59] opacity-60" />
          <span className="relative inline-flex size-[7px] rounded-full bg-[#2ebd59]" />
        </span>
      )}
    </span>
  );
}
