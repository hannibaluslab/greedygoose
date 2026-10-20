import { CASH } from "@/config/risk";
import { assertAllowed } from "@/lib/allowlist";
import { feeBufferRaw, toUsd, type Cash } from "@/lib/cash";
import { floorCents } from "@/lib/formatting";
import { buildWithdrawSavingsCalls } from "@/lib/savings";
import { TxStop, txKey, type TxPlan } from "@/lib/tx/prepared";

/*
 * The fuel tank (Adrian, 2026-10-20: "a user needs to be able to fill up the fuel tank from cash when he needs to, and
 * the tank should be 0.5"): the wallet USDC JAW takes its network fee from, up to CASH.feeBufferUsd. Every spend from
 * cash leaves it full, and each fee takes a little out; a batch that moves no cash (an agent's settings, a turn-off)
 * can only pay from it. "Fill up" brings it back from savings, in one batch of its own. Pure, so the amounts are tested.
 */

/** A fill-up brings the tank this much over full, so its own batch's fee leaves it full ($0.0095 measured, the most). */
const FILL_MARGIN_RAW = 20_000n;

/** What's in the tank: wallet USDC up to the tank's size, in whole cents rounded down (never reads full a cent short). */
export const tankLevelUsd = (walletRaw: bigint) => Math.min(floorCents(toUsd(walletRaw)), CASH.feeBufferUsd);

/**
 * Cash as Home's Cash card and the Cash sheet show it: everything but the fuel tank, which has its own line (Adrian,
 * 2026-10-21: "cash is only what earns"). What a top-up leaves in the wallet past the tank counts as cash. In whole
 * cents rounded down, as the "$X earning" line under it is, so the two agree.
 */
export const cashWithoutTankUsd = (p: { cashUsd: number; cash: Pick<Cash, "walletRaw"> }) =>
  Math.max(0, floorCents(p.cashUsd - tankLevelUsd(p.cash.walletRaw)));

/** Under half full with cash in savings to fill it: Home's menu asks for it, with a number over its button. */
export const tankLow = (c: Cash) => c.walletRaw * 2n < feeBufferRaw && c.savingsRaw > 0n;

/** What a fill-up takes out of savings: back to full plus its own fee, all of savings when that's less; null when full. */
export function fillRaw(c: Cash): { raw: bigint; all: boolean } | null {
  if (c.walletRaw >= feeBufferRaw || c.savingsRaw === 0n) return null;
  const want = feeBufferRaw + FILL_MARGIN_RAW - c.walletRaw;
  return want < c.savingsRaw ? { raw: want, all: false } : { raw: c.savingsRaw, all: true };
}

/** Said when the tank filled up since the screen read it (a top-up, a spend that left it full). */
const TANK_FULL = "Your fuel tank is already full.";

/**
 * What "Fill up" signs (useTx): savings back into the wallet, up to a full tank. Keyed by the wallet and whether savings
 * cover it, so interest ticking in savings doesn't make a new batch. Built from the cash read again while it's prepared.
 */
export function fillTankPlan(
  user: `0x${string}`,
  cash: Cash,
  read: (user: `0x${string}`) => Promise<Cash>,
): TxPlan | null {
  const f = fillRaw(cash);
  if (!f) return null;
  return {
    key: txKey("fillTank", user, cash.walletRaw, f.all ? cash.savingsRaw : null),
    user,
    calls: async () => {
      const fresh = fillRaw(await read(user));
      if (!fresh) throw new TxStop(TANK_FULL);
      return assertAllowed(user, buildWithdrawSavingsCalls(user, fresh.raw, fresh.all));
    },
  };
}
