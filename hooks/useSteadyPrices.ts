"use client";

import { useState } from "react";

/** How far an Aave price may move before an agent grant's stock limits are worked out again: inside its 1% headroom. */
const STEADY_MOVE = 0.005;

/**
 * Aave's prices as an agent grant's stock limits use them (Protect · sell, the Rebalancer): the ones read when the
 * sheet opened, until any moves more than half a percent. The limits leave 1% under the executor's bound at
 * registration (permissions `stockLimitsRaw`), so a smaller move can't refuse them, and the save's batch, keyed by its
 * terms, stays prepared instead of being rebuilt on every read (useTx).
 */
export function useSteadyPrices(pricesRaw: readonly bigint[]): readonly bigint[] {
  const [held, setHeld] = useState(pricesRaw);
  const moved =
    pricesRaw.length !== held.length ||
    pricesRaw.some((p, i) => {
      const h = held[i];
      if (h === 0n) return p !== 0n;
      const diff = p > h ? p - h : h - p;
      return Number(diff) / Number(h) > STEADY_MOVE;
    });
  if (moved) setHeld(pricesRaw);
  return moved ? pricesRaw : held;
}
