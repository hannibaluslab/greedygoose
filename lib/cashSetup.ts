import type { AgentStatus } from "@/lib/agents/status";
import { formatCoin, formatUsdTrim } from "@/lib/formatting";
import { faceRaw, MIN_CONVERT_RAW } from "@/lib/swap/entry";
import { USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS, type EntryCoinAsset } from "@/lib/tokens/stables";

/*
 * Earning and other dollars turning into cash run under the hood (D20). The user meets them only where they matter:
 * "Your $100 arrived · Start earning" once money is in, for earning (the Save grant), and "120 USDT arrived · Turn into
 * cash" when other dollars sit in the account with nothing to convert them (then "Do this automatically next time?",
 * the Entry grant). Pure, so the dev gallery draws every state with the app's own words.
 */

/** The cash rate as the screens say it: "3.9%". */
export const rateText = (apy: number) => `${(apy * 100).toFixed(1)}%`;

/** Cash it takes before Home asks to start earning: below it there's nothing to earn on, and JAW's fee is paid in it. */
export const MIN_START_USD = 1;

/**
 * Whether Home asks to start earning (Adrian, 2026-10-14: when money comes in, not at $0): an executor is configured
 * (`save` isn't "unconfigured"), the account has no Save grant, neither running nor starting, and at least $1 of cash
 * is in. Not while it loads, so an earning account never sees it flash. Sign-up goes straight Home: at $0 there's
 * nothing to earn on and nothing to pay JAW's fee with.
 */
export const startEarningShown = (save: AgentStatus, cashUsd: number) => save === "off" && cashUsd >= MIN_START_USD;

/** A coin sitting in the wallet: how much, in its own units. */
export type Arrived = { coin: EntryCoinAsset; raw: bigint };

/** The other dollars in the wallet worth turning into cash (face value of $1 or more), in ENTRY_COINS order. */
export function arrivedCoins(balances: readonly bigint[] | undefined): Arrived[] {
  if (!balances) return [];
  return ENTRY_COINS.flatMap((coin, k) => {
    const raw = balances[k] ?? 0n;
    return faceRaw(coin, raw) >= MIN_CONVERT_RAW ? [{ coin, raw }] : [];
  });
}

const amountOf = (a: Arrived) => `${formatCoin(Number(a.raw) / 10 ** a.coin.decimals)} ${a.coin.symbol}`;

/** "120 USDT", "120 USDT and 50 USDe", or past two coins their face value: "$170 in other dollars". */
export function arrivedText(list: readonly Arrived[]): string {
  if (list.length <= 2) return list.map(amountOf).join(" and ");
  const usd = Number(list.reduce((t, a) => t + faceRaw(a.coin, a.raw), 0n)) / 10 ** USDC.decimals;
  return `${formatUsdTrim(Math.floor(usd))} in other dollars`;
}

/**
 * What Home and Pay show for other dollars in the wallet:
 * - "ask": nothing converts them on its own (no Entry grant, or no executor at all), so a card offers "Turn into cash";
 * - "arriving": an Entry grant converts them, so the Cash card only says "120 USDT arriving" until they're cash;
 * - "none": no coins, or the grant's state is still loading.
 */
export type ArrivedView = { kind: "none" } | { kind: "ask" | "arriving"; text: string; coins: Arrived[] };

export function arrivedView(list: readonly Arrived[], entry: AgentStatus): ArrivedView {
  if (list.length === 0 || entry === "loading") return { kind: "none" };
  const coins = [...list];
  return entry === "on" || entry === "starting" ? { kind: "arriving", text: arrivedText(coins), coins } : { kind: "ask", text: arrivedText(coins), coins };
}

/** After a conversion, whether to ask "Do this automatically next time?": only with an executor, and no Entry grant yet. */
export const askAutomatic = (entry: AgentStatus) => entry === "off";

/**
 * The Cash card's line: "Always earning" with the Save agent on; otherwise what's in savings does earn (Earn with
 * stocks puts credit there in its own batch), so "$25 earning" rather than "Not earning yet", which only stays when
 * nothing is in savings.
 */
export function earningLine(saveOn: boolean, savingsUsd: number): string {
  if (saveOn) return "Always earning";
  return savingsUsd >= 0.01 ? `${formatUsdTrim(Math.floor(savingsUsd * 100) / 100)} earning` : "Not earning yet";
}
