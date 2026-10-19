import { erc20Abi, isAddressEqual } from "viem";
import type { AgentStatus } from "@/lib/agents/status";
import { CHAIN_ID } from "@/lib/chain";
import { formatCoin, formatUsdTrim } from "@/lib/formatting";
import { startEarningMinRaw } from "@/lib/startEarning";
import { faceRaw, MIN_CONVERT_RAW } from "@/lib/swap/entry";
import { USDC } from "@/lib/tokens/registry";
import { CASH_COINS, ENTRY_COINS, type EntryCoinAsset } from "@/lib/tokens/stables";

/*
 * Earning and other dollars turning into cash run under the hood (D20). The user meets them only where they matter:
 * "Your $100 arrived · Start earning" once money is in, for earning (the Save grant), and "120 USDT arrived · Turn into
 * cash" when other dollars sit in the account with nothing to convert them (then "Do this automatically next time?",
 * the Entry grant). Pure, so the dev gallery draws every state with the app's own words.
 */

/** The cash rate as the screens say it: "3.9%". */
export const rateText = (apy: number) => `${(apy * 100).toFixed(1)}%`;

export { MIN_START_USD, startEarningMinRaw } from "@/lib/startEarning";

/**
 * Whether Home asks to start earning, and fades its Cash and Yield cards (board 2g). Start earning moves the wallet's
 * idle USDC into savings in the user's own batch (Adrian, 2026-10-15), so it's offered on wallet USDC alone (what's in
 * savings already earns): at least $1 to put in plus the fee buffer that stays (startEarningMinRaw). With an executor
 * (`save` isn't "unconfigured") only while the account has no Save grant, neither running nor starting: Save sweeps
 * the wallet on its own once it runs. Without one (the public link) whenever that much sits idle. Never while the grant
 * loads, so an earning account never sees it flash. At $0 there's nothing to earn on and nothing to pay JAW's fee with.
 */
export function startEarningShown(save: AgentStatus, walletRaw: bigint): boolean {
  if (walletRaw < startEarningMinRaw) return false;
  return save === "unconfigured" || save === "off";
}

/**
 * Whether Start earning's batch is followed by the Save grant on JAW's own screen: only once the agents are live
 * (`live`: AGENTS_LIVE, Chainlink approved the automation; until then SPEC has "Coming soon" where Save is), with an
 * executor and no Save grant yet. Otherwise the user would sign a grant to an executor that doesn't run.
 */
export const saveGrantFollows = (save: AgentStatus, live: boolean) => live && save === "off";

/**
 * JAW sheets one Start earning tap opens: the batch, then, when the Save grant follows (saveGrantFollows), JAW's own
 * screen for it (D14: a grant can't ride in a batch). The button's "2 steps".
 */
export const startEarningSteps = (save: AgentStatus, live: boolean) => (saveGrantFollows(save, live) ? 2 : 1);

/**
 * The card's words (board 2g): money that just arrived, "Your $100 arrived · Start earning 4.6% on it."; with savings
 * already earning and new idle cash beside them, "$40 isn't earning". `walletUsd` is the wallet's USDC, cents kept.
 */
export function startEarningText(p: { walletUsd: number; savingsUsd: number; rate: string | null }): {
  title: string;
  line: string;
} {
  const amount = formatUsdTrim(Math.floor(p.walletUsd * 100) / 100);
  const line = `Start earning${p.rate ? ` ${p.rate}` : ""} on it.`;
  return { title: p.savingsUsd >= 0.01 ? `${amount} isn’t earning` : `Your ${amount} arrived`, line };
}

/** The toast once the batch lands: "Your cash is earning 3.9%". */
export const startedEarningText = (rate: string | null) =>
  rate ? `Your cash is earning ${rate}` : "Your cash is earning";

/** A coin sitting in the wallet: how much, in its own units. */
export type Arrived = { coin: EntryCoinAsset; raw: bigint };

/** The balance reads of Turn into cash's coins in `account`'s wallet, in CASH_COINS order (arrivedCoins reads them). */
export const cashBalanceReads = (account: `0x${string}`) =>
  CASH_COINS.map(
    (c) =>
      ({ address: c.address, abi: erc20Abi, functionName: "balanceOf", args: [account], chainId: CHAIN_ID }) as const,
  );

/**
 * The other dollars in the wallet worth turning into cash (face value of $1 or more; 1 EURC for the euro), from
 * cashBalanceReads' results in CASH_COINS order.
 */
export function arrivedCoins(balances: readonly bigint[] | undefined): Arrived[] {
  if (!balances) return [];
  return CASH_COINS.flatMap((coin, k) => {
    const raw = balances[k] ?? 0n;
    return faceRaw(coin, raw) >= MIN_CONVERT_RAW ? [{ coin, raw }] : [];
  });
}

const amountOf = (a: Arrived) => `${formatCoin(Number(a.raw) / 10 ** a.coin.decimals)} ${a.coin.symbol}`;

/**
 * "120 USDT", "120 USDT and 50 USDe", or past two coins their face value: "$170 in other dollars". A euro isn't a
 * dollar, so with EURC among them each amount is named: "120 USDT, 50 USDe and 30 EURC".
 */
export function arrivedText(list: readonly Arrived[]): string {
  if (list.length <= 2) return list.map(amountOf).join(" and ");
  if (list.some((a) => a.coin.peg))
    return `${list.slice(0, -1).map(amountOf).join(", ")} and ${amountOf(list.at(-1)!)}`;
  const usd = Number(list.reduce((t, a) => t + faceRaw(a.coin, a.raw), 0n)) / 10 ** USDC.decimals;
  return `${formatUsdTrim(Math.floor(usd))} in other dollars`;
}

/**
 * What Home and Pay show for other dollars in the wallet:
 * - "ask": nothing converts them on its own (no Entry grant, no executor at all, or a coin the Entry agent doesn't take,
 *   DAI and EURC until EntryJob has them), so a card offers "Turn into cash" for those;
 * - "arriving": an Entry grant converts them all, so the Cash card only says "120 USDT arriving" until they're cash;
 * - "none": no coins, or the grant's state is still loading.
 */
export type ArrivedView = { kind: "none" } | { kind: "ask" | "arriving"; text: string; coins: Arrived[] };

const agentTakes = (a: Arrived) => ENTRY_COINS.some((c) => isAddressEqual(c.address, a.coin.address));

export function arrivedView(list: readonly Arrived[], entry: AgentStatus): ArrivedView {
  if (list.length === 0 || entry === "loading") return { kind: "none" };
  const granted = entry === "on" || entry === "starting";
  const ask = granted ? list.filter((a) => !agentTakes(a)) : [...list];
  if (ask.length > 0) return { kind: "ask", text: arrivedText(ask), coins: ask };
  return { kind: "arriving", text: arrivedText(list), coins: [...list] };
}

/**
 * After a conversion, whether to ask "Do this automatically next time?" (the Entry grant): only once the agents are
 * live (`live`: AGENTS_LIVE), with an executor, and no Entry grant yet.
 */
export const askAutomatic = (entry: AgentStatus, live: boolean) => live && entry === "off";

/**
 * The Cash card's line: "Always earning" with the Save agent on; otherwise what's in savings does earn (Earn with
 * stocks puts credit there in its own batch), so "$25 earning" rather than "Not earning yet", which only stays when
 * nothing is in savings.
 */
export function earningLine(saveOn: boolean, savingsUsd: number): string {
  if (saveOn) return "Always earning";
  return savingsUsd >= 0.01 ? `${formatUsdTrim(Math.floor(savingsUsd * 100) / 100)} earning` : "Not earning yet";
}
