import { CREDIT_CAP, RISK } from "@/config/risk";
import { healthAfterWithdraw, maxWithdrawUsd } from "@/lib/aave/math";
import { formatUsd } from "@/lib/formatting";
import { endsInAct, needsExtraConfirm, statusFor, type Status } from "@/lib/risk/status";
import { rawToShares } from "@/lib/tokens/b20";
import type { HealthFloor } from "@/lib/tx/prepared";

/*
 * Free up shares (UnlockSheet): how much of a stock can come out of backing, and whether the amount on screen can.
 * Act is the line (Adrian, 2026-10-15): the most it frees up keeps the health factor at or above CREDIT_CAP.minHf, the
 * same line as taking credit, and an amount that would end in Act is blocked with one plain line, never a tick. Pure,
 * so it's unit-tested (tests/unit/free-up.test.ts); the batch is checked again on Aave's own health (FREE_UP_FLOOR).
 */

export const FREE_UP_BLOCKED = {
  /** Something is owed and the health is already at or under the cap's line: nothing can come out. */
  "needs-all": "Your credit needs all of these shares. Repay some first to free them up.",
  act: "That would put your credit in Act. Free up less, or repay some first.",
} as const;

/** Free up's batch is stopped if the health on Aave after it, read in its simulation, is in Act (lib/tx/prepared.ts). */
export const FREE_UP_FLOOR: HealthFloor = { minHf: RISK.watchMin, stop: FREE_UP_BLOCKED.act };

export type FreeUpCheck = {
  /** The most that comes out, in dollars at Aave's price: all of it with nothing owed, else down to the cap's line. */
  maxUsd: number;
  /** All of it can come out (the button says ALL, not MAX). */
  canAll: boolean;
  /** maxUsd in shares as shown (uiMultiplier applied). */
  maxShares: number;
  /** The amount on screen in dollars at Aave's price. */
  usd: number;
  hfAfter: number | null;
  after: Status;
  /** It would end in Act: blocked, no tick. */
  endsInAct: boolean;
  /** More than maxShares. */
  tooMuch: boolean;
  /** It ends in Watch: D2's tick. */
  risky: boolean;
  /** The one red line, or null: the credit needs all of it; ending in Act; more than can come out. */
  line: string | null;
  /** The amount can be signed (the tick aside). */
  ok: boolean;
};

export function freeUpCheck(p: {
  position: { collateralUsd: number; avgCf: number; debtUsd: number };
  holding: { lockedRaw: bigint; lockedUsd: number; priceUsd: number; multiplier: bigint };
  decimals: number;
  /** The stock's collateral factor (0–1). */
  cf: number;
  amountRaw: bigint;
  /** All of it (the ALL button): only when canAll. */
  all: boolean;
}): FreeUpCheck {
  const { position: pos, holding: h } = p;
  const maxUsd = maxWithdrawUsd({ ...pos, cf: p.cf, lockedUsd: h.lockedUsd, targetHf: CREDIT_CAP.minHf });
  const canAll = pos.debtUsd === 0 || maxUsd >= h.lockedUsd;
  const lockedShares = rawToShares(h.lockedRaw, h.multiplier, p.decimals);
  const maxShares = canAll ? lockedShares : lockedShares * (maxUsd / Math.max(h.lockedUsd, 1e-9));

  const shares = rawToShares(p.amountRaw, h.multiplier, p.decimals);
  const usd = (Number(p.amountRaw) / 10 ** p.decimals) * h.priceUsd;
  const tooMuch = p.all ? !canAll : shares > maxShares + 1e-12;
  const hfAfter = healthAfterWithdraw({ ...pos, cf: p.cf, usd });
  const after = statusFor(hfAfter);
  const some = p.amountRaw > 0n;
  const inAct = some && endsInAct(after);
  const needsAll = pos.debtUsd > 0 && maxUsd <= 0;
  // One line at a time: when nothing can come out, that says it all ("Free up less" would be wrong then).
  const line = needsAll
    ? FREE_UP_BLOCKED["needs-all"]
    : inAct
      ? FREE_UP_BLOCKED.act
      : some && tooMuch
        ? `That’s more than you can free up while you owe ${formatUsd(pos.debtUsd)}.`
        : null;
  const ok = some && !tooMuch && !inAct;
  return { maxUsd, canAll, maxShares, usd, hfAfter, after, endsInAct: inAct, tooMuch, risky: ok && needsExtraConfirm(after), line, ok };
}
