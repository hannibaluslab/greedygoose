"use client";

import { useEffect, useState } from "react";
import { liveDecimals, liveEarnedUsd, liveText } from "@/lib/liveEarning";

/** How often the counter redraws. */
const TICK_MS = 250;

/** Holding still: cents, or enough digits that a sliver earned isn't shown as $0.00. */
const stillDecimals = (usd: number) => (usd === 0 || usd >= 0.01 ? 2 : Math.min(8, Math.ceil(-Math.log10(usd)) + 1));

/**
 * Earned all time, counting up between reads: "$0.00" then "0158231" smaller. `readAt` is when Base was last read (useTotalEarned), so
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
  const [head, tail] = splitCents(text);
  return (
    <span className={`num flex items-center gap-1.5 tabular-nums ${className ?? ""}`}>
      <span>
        {/* Dollars and cents at the card's size, the digits past the cents behind them, smaller. */}
        <span className={head.length > 7 ? "text-[20px]" : "text-[26px]"}>{head}</span>
        {tail && <span className="text-[14px] font-medium tracking-normal text-ink-mid">{tail}</span>}
      </span>
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

/** "$0.09980412" → ["$0.09", "980412"]: the cents end the head. */
function splitCents(text: string): [string, string] {
  const dot = text.indexOf(".");
  return dot < 0 ? [text, ""] : [text.slice(0, dot + 3), text.slice(dot + 3)];
}
