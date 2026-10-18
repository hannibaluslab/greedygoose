"use client";

import { useEffect, useState } from "react";
import { marketState } from "@/lib/market-hours";

/** "Markets closed", on the Invest page only (Adrian, 2026-10-18): the trade steps carry their own price note. */
export function MarketBanner() {
  const [state, setState] = useState<ReturnType<typeof marketState> | null>(null);
  useEffect(() => {
    const tick = () => setState(marketState());
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);
  if (!state || state.open) return null;
  return (
    <p role="status" className="rounded-2xl bg-chip px-4 py-3 text-[13px] leading-snug text-ink-mid">
      Markets closed — stock prices update {state.reopensLabel}. Interest still accrues.
    </p>
  );
}
