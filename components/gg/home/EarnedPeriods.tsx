"use client";

import { useState } from "react";
import { LiveEarning } from "./LiveEarning";
import { SegmentedControl } from "../SegmentedControl";
import type { TotalEarned } from "@/hooks/useTotalEarned";
import { earnedPeriod } from "@/lib/earned";
import { formatUsd } from "@/lib/formatting";

type Period = "week" | "month" | "year" | "all";

const PERIODS: { value: Period; label: string; days: number | null }[] = [
  { value: "week", label: "Week", days: 7 },
  { value: "month", label: "Month", days: 30 },
  { value: "year", label: "Year", days: 365 },
  { value: "all", label: "All", days: null },
];

const DAY = 86_400;

/** "21 days", "1 day", "Under a day". */
const daysText = (days: number) =>
  days < 1 ? "Under a day" : `${Math.floor(days)} ${Math.floor(days) === 1 ? "day" : "days"}`;

const dateText = (sec: number) => new Date(sec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * The Yield sheet's earnings by period (Adrian, 2026-10-18): Week, Month, Year or All, what the savings earned in it
 * (counting on live, as the card does), what they held on average, and over how long. A period longer than the account's
 * savings starts at the first money in, and says since when.
 */
export function EarnedPeriods({ earned, savingsUsd, apr }: { earned: TotalEarned; savingsUsd: number; apr: number }) {
  const [period, setPeriod] = useState<Period>("all");
  const readSec = earned.readAt / 1000;
  const days = PERIODS.find((p) => p.value === period)!.days;
  const since = days === null ? null : readSec - days * DAY;
  const p = earnedPeriod(earned.moves, earned.openUsd, readSec, since);
  const cut = p.fromSec !== null && since !== null && p.fromSec > since;
  return (
    <div className="flex flex-col gap-3 rounded-[22px] bg-card p-4 shadow-card-elev">
      <SegmentedControl label="Earned over" options={PERIODS} value={period} onChange={setPeriod} />
      {p.fromSec === null ? (
        <p className="m-0 py-2 text-center text-[14px] text-ink-mid">Nothing in savings yet, so nothing earned.</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-medium text-ink-mid">Earned</span>
            {/* Remounted per period: the counter never steps back, so it can't carry All's count into a Week. */}
            <LiveEarning
              key={period}
              earnedUsd={p.earnedUsd}
              savingsUsd={savingsUsd}
              apr={apr}
              readAt={earned.readAt}
              className="font-semibold tracking-[-0.03em]"
            />
          </div>
          <dl className="m-0 flex flex-col gap-2 border-t border-line-field pt-2.5 text-[14px]">
            <div className="flex items-baseline justify-between">
              <dt className="text-ink-2">Held on average</dt>
              <dd className="m-0 font-semibold text-ink">{formatUsd(p.heldUsd)}</dd>
            </div>
            <div className="flex items-baseline justify-between">
              <dt className="text-ink-2">Over</dt>
              <dd className="m-0 font-semibold text-ink">
                {daysText(p.days)}
                {(cut || period === "all") && (
                  <span className="font-normal text-ink-mid"> · since {dateText(p.fromSec)}</span>
                )}
              </dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}
