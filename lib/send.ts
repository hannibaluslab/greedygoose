import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, isAddressEqual, parseUnits, type Address, type Client } from "viem";
import { getBalance, getCode, getTransactionCount, readContract } from "viem/actions";
import { CASH } from "@/config/risk";
import type { ActivityItem } from "@/lib/activity/decode";
import type { LocalActivity } from "@/lib/activity/local";
import type { Call } from "@/lib/aave/tx";
import { cashRaw, feeBufferRaw, maxSpendRaw, payFromCash, toUsd, type Cash } from "@/lib/cash";
import { recipientBlock, type RecipientBlock } from "@/lib/contracts";
import { formatShares, formatUsd, shortAddress } from "@/lib/formatting";
import { fullName } from "@/lib/jaw/name";
import { rawToShares } from "@/lib/tokens/b20";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";
import { clampAmount, maxUsdOf, sharesForUsdRaw, stockOf, type TradeData } from "@/lib/trade";

/**
 * Send (Adrian, 2026-10-15): "replace pay by send, and let user send their assets out". NYM's SendSheet, Base only, in
 * the GreedyGoose kit: what (Cash, the one pot, or a stock's free shares), to whom (a name or a 0x address, resolved and
 * shown before anything is sent), how much in dollars with MAX, then one JAW sheet. Everything the screen shows comes
 * from here; the screen holds no money maths and no rules.
 */

/** "cash", or one of the seven stocks' registry symbols (resolved through the registry only, `stockOf`). */
export type SendAsset = "cash" | (string & {});
/** The position's fields Send reads (usePosition's data has them all). */
export type SendData = Pick<TradeData, "holdings" | "cash" | "cashUsd">;

const tickerOf = (symbol: string) => symbol.replace(/c$/, "");
const held = (h: SendData["holdings"][number]) => h.freeRaw + h.lockedRaw > 0n;

/** Every main-screen string of Send. None names a protocol or a token standard. */
export const SEND_COPY = {
  title: "Send",
  receive: "Receive",
  youSend: "You send",
  menu: "Send from",
  pill: (name: string) => `Send from: ${name}`,
  cashName: "Cash",
  cashHint: (usd: number) => `Cash available: ${formatUsd(usd)}`,
  freeHint: (usd: number) => `Free to send: ${formatUsd(usd)}`,
  backsHint: (usd: number) => `${formatUsd(usd)} of it backs your credit.`,
  sharesHint: (shares: string, ticker: string) => `That’s ${shares} ${ticker}.`,
  subBacks: (usd: number) => `${formatUsd(usd)} of it backs your credit`,
  subShares: (shares: number) => `${formatShares(shares)} shares`,
  subAllBacks: "All of it backs your credit",
  subNoCash: "Not enough to send",
  toSend: "to send",
  free: "free",
  to: "To",
  toLabel: "Name or address",
  toPlaceholder: "sam.justan.id or 0x…",
  find: "Find",
  looking: "Looking…",
  change: "Send to someone else",
  checking: "Checking the address on Base…",
  recent: "Recent",
  contacts: "Contacts",
  theyGet: "They get",
  about: (usd: number) => `about ${formatUsd(usd)}`,
  // Who: refused, then warned.
  self: "That’s your own account. Send to someone else.",
  zero: "That address can’t hold money. Check it and try again.",
  contract: "That address is one of the contracts the app uses, not someone’s account. Money sent there would be lost.",
  unused: "This address hasn’t been used on Base yet. Check it’s right.",
  typo: "This address has a typo in it. Copy it again from where you found it.",
  shape: "An address starts with 0x and has 40 more letters and numbers.",
  badName: "Type a name, like sam.justan.id or a .eth name, or a 0x address.",
  noName: (name: string) => `No account goes by ${name}.`,
  lookupFailed: "We couldn’t look that up right now. Try again.",
  ethOnly: "This name only gives an Ethereum address. Send only if it’s the same account on Base.",
  ethOnlyContract: (name: string) => `${name} is a wallet on Ethereum that isn’t on Base. Ask them for their Base address.`,
  // How much.
  overCash: (usd: number) => `That’s more than your cash (${formatUsd(usd)}).`,
  feeBuffer: `Leave ${formatUsd(CASH.feeBufferUsd)} for the network fee.`,
  noFee: `Add ${formatUsd(CASH.feeBufferUsd)} to your cash for the network fee first.`,
  notFree: "That’s more than your free shares.",
  allBacks: (name: string) => `All of your ${name} backs your credit.`,
  tooSmall: "That’s less than the smallest part of a share.",
  // The button and what comes back.
  button: "Send",
  sendUsd: (usd: number) => `Send ${formatUsd(usd)}`,
  sendStock: (name: string) => `Send ${name}`,
  feeUnsupported: "Your account can’t pay network fees in USDC on Base right now, so this can’t be sent.",
  fallback: "This send would fail right now. Check the amount and try again in a moment.",
  failedOnChain: "The send didn’t go through on Base. Nothing moved except any network fee.",
  sent: (what: string, who: string) => `Sent ${what} to ${who}`,
  sentBody: "It’s in their account on Base.",
  done: "Done",
  emptyTitle: "Nothing to send yet",
  emptyLine: "Top up your cash or buy a stock, and you can send it from here.",
  topUp: "Top up",
} as const;

// ─── What ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A row in "Send from": the asset, its name, the line under it and the right column, and why it can't be picked. */
export type SendOption = {
  asset: SendAsset;
  name: string;
  sub?: string;
  right?: string;
  rightSub?: string;
  disabled: boolean;
  freeUsd: number;
};

/**
 * "Send from": Cash (what MAX takes: the cash less the network fee's $0.50), then each stock held. A stock sends only
 * its free shares; one whose shares all back credit is listed, says so and can't be picked. Stocks not held aren't
 * listed. Cash first, then what can be picked by free value, then the rest.
 */
export function sendOptions(data: SendData): SendOption[] {
  const cashOk = maxSpendRaw(data.cash) > 0n;
  const cash: SendOption = {
    asset: "cash",
    name: SEND_COPY.cashName,
    sub: cashOk ? undefined : SEND_COPY.subNoCash,
    right: formatUsd(maxUsdOf("cash", data)),
    rightSub: cashOk ? SEND_COPY.toSend : undefined,
    disabled: !cashOk,
    freeUsd: data.cashUsd,
  };
  const stocks = data.holdings.filter(held).map(
    (h): SendOption => ({
      asset: h.symbol,
      name: h.name,
      sub: h.freeRaw === 0n ? SEND_COPY.subAllBacks : h.lockedRaw > 0n ? SEND_COPY.subBacks(h.lockedUsd) : SEND_COPY.subShares(h.freeShares),
      right: formatUsd(maxUsdOf(h.symbol, data)),
      rightSub: SEND_COPY.free,
      disabled: h.freeRaw === 0n,
      freeUsd: h.freeUsd,
    }),
  );
  const pickable = stocks.filter((s) => !s.disabled).sort((a, b) => b.freeUsd - a.freeUsd);
  const rest = stocks.filter((s) => s.disabled);
  return [cash, ...pickable, ...rest];
}

/** What Send opens on: the seed when it can be sent, else Cash when it can, else the stock with the most free value; null when nothing can be sent. */
export function defaultAsset(data: SendData, seed?: SendAsset): SendAsset | null {
  const pickable = sendOptions(data).filter((o) => !o.disabled);
  if (!pickable.length) return null;
  return seed && pickable.some((o) => o.asset === seed) ? seed : pickable[0].asset;
}

/** Send's own state: what is sent (null with nothing to send), the dollars typed, and whether a stock sends every free share. */
export type SendForm = { asset: SendAsset | null; amount: string; all: boolean };
export type SendAction = { type: "pick"; asset: SendAsset } | { type: "amount"; value: string } | { type: "max" };

/**
 * One step of Send's amount (the screen holds no rules of its own), as Trade's: typed dollars are clamped to the most
 * the asset takes; MAX takes that most, and on a stock sends every free share; a new asset keeps the dollars, clamped.
 */
export function sendForm(state: SendForm, action: SendAction, data: SendData): SendForm {
  if (action.type === "pick") {
    if (!sendOptions(data).some((o) => o.asset === action.asset && !o.disabled)) return state;
    return { asset: action.asset, ...clampAmount(action.asset, data, state.amount) };
  }
  if (!state.asset) return action.type === "amount" ? { ...state, amount: action.value, all: false } : state;
  if (action.type === "amount") return { asset: state.asset, ...clampAmount(state.asset, data, action.value) };
  return { asset: state.asset, amount: String(maxUsdOf(state.asset, data)), all: state.asset !== "cash" };
}

const usdRawOf = (amount: string): bigint => {
  const clean = amount.trim();
  if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") return 0n;
  const [int, frac = ""] = clean.split(".");
  return parseUnits(`${int || "0"}.${frac.slice(0, USDC.decimals) || "0"}`, USDC.decimals);
};

// ─── To ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What was typed in To: nothing, an address (checksum-valid or all lowercase), a name to look up, or why it's neither. */
export type ToInput =
  | { kind: "empty" }
  | { kind: "address"; address: Address }
  | { kind: "name"; name: string }
  | { kind: "invalid"; text: string };

/**
 * Reads what was typed in To. Anything starting with 0x is an address: 0x and 40 hex characters, either all lowercase
 * or in its checksum's exact capitals (viem's strict `isAddress`); a mixed-case address whose capitals don't match its
 * checksum has a typo. Anything else is a name: "sam" means sam.justan.id (the app's name parent), a dotted one is
 * taken as typed (ENS's normalization).
 */
export function parseTo(text: string): ToInput {
  const t = text.trim();
  if (!t) return { kind: "empty" };
  if (/^0x/i.test(t)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return { kind: "invalid", text: SEND_COPY.shape };
    if (!isAddress(t, { strict: true })) return { kind: "invalid", text: SEND_COPY.typo };
    return { kind: "address", address: getAddress(t) };
  }
  const name = fullName(t);
  return name ? { kind: "name", name } : { kind: "invalid", text: SEND_COPY.badName };
}

/** Who Send pays: the address, the name it came from (or the address's own name), and whether that's its Base address. */
export type Recipient = { address: Address; name: string | null; onBase: boolean };

/**
 * What Base says about the recipient (readRecipient): whether it has code, and whether it was ever used (code, a sent
 * transaction, ETH or USDC). `ethCode`: for a name that only gives an Ethereum address, whether that address has code on
 * Ethereum (a contract wallet there may not be the same account on Base). Undefined while reading, null if the read
 * failed (the screen then says nothing of it).
 */
export type RecipientChecks = {
  base?: { code: boolean; used: boolean } | null;
  ethCode?: boolean | null;
};

/** One read of the recipient on Base, in parallel: its code, its nonce, its ETH and its USDC. */
export async function readRecipient(client: Client, address: Address): Promise<{ code: boolean; used: boolean }> {
  const [code, nonce, eth, usdc] = await Promise.all([
    getCode(client, { address }),
    getTransactionCount(client, { address }),
    getBalance(client, { address }),
    readContract(client, { address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  const hasCode = !!code && code !== "0x";
  return { code: hasCode, used: hasCode || nonce > 0 || eth > 0n || usdc > 0n };
}

const BLOCK_TEXT: Record<RecipientBlock, string> = { self: SEND_COPY.self, zero: SEND_COPY.zero, contract: SEND_COPY.contract };

/**
 * The recipient's guards, refused before warned: the account itself, the zero address and the app's or its protocols'
 * contracts are refused (lib/contracts.ts); a name whose only address is a contract on Ethereum with nothing on Base is
 * refused; a name with only an Ethereum address that is a contract on both is a warning; an address Base has never seen
 * used is a warning. `waiting` until Base has answered, so a warning never lands after the tap.
 */
export function recipientNote(r: Recipient, user: Address, checks: RecipientChecks): { block: string | null; warn: string | null; waiting: boolean } {
  const blocked = recipientBlock(r.address, user);
  if (blocked) return { block: BLOCK_TEXT[blocked], warn: null, waiting: false };
  if (checks.base === undefined || (!r.onBase && checks.ethCode === undefined)) return { block: null, warn: null, waiting: true };
  if (!r.onBase && checks.ethCode && checks.base && !checks.base.code) {
    return { block: SEND_COPY.ethOnlyContract(r.name ?? shortAddress(r.address)), warn: null, waiting: false };
  }
  const warn = !r.onBase && checks.ethCode ? SEND_COPY.ethOnly : checks.base && !checks.base.used ? SEND_COPY.unused : null;
  return { block: null, warn, waiting: false };
}

/** The people sent to from this device, newest first, once each, for the quick picks: from Activity's own records. */
export function recentRecipients(local: readonly LocalActivity[], limit = 4): { address: Address; name: string | null }[] {
  const out: { address: Address; name: string | null }[] = [];
  for (const entry of [...local].sort((a, b) => b.time - a.time)) {
    if (entry.status === "failed") continue;
    for (const item of entry.items) {
      if (item.kind !== "send" || !item.to || !isAddress(item.to, { strict: false })) continue;
      if (out.some((o) => isAddressEqual(o.address, item.to!))) continue;
      out.push({ address: getAddress(item.to), name: item.toName ?? null });
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** Why a Send's batch can't be built, in the screen's words (the screen already stops these; this is the last check). */
export class SendStop extends Error {}

// ─── The batch ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The asset a Send moves: USDC for Cash, or a registry stock; never from a string alone. */
export const sendTokenOf = (asset: SendAsset): ReserveAsset | undefined => (asset === "cash" ? USDC : stockOf(asset));

const isRegistryToken = (t: ReserveAsset) => isAddressEqual(t.address, USDC.address) || EQUITIES.some((e) => isAddressEqual(e.address, t.address));

/**
 * A Send in one batch: transfer(to, amount) of USDC or the stock, and nothing else of the user's leaves. Cash is the one
 * pot (D20): when the wallet can't be counted on for the amount and the network fee, the savings withdrawal goes first
 * (payFromCash); a stock send takes only the fee from the cash. Refuses the user, the zero address and the app's or its
 * protocols' contracts, and any amount of 0. Every call passes the allowlist with the recipient declared (`sendTo`), so
 * the transfer can go to that address only.
 */
export function buildSendCalls(p: { user: Address; token: ReserveAsset; to: Address; amountRaw: bigint; cash: Cash }): Call[] {
  if (!isRegistryToken(p.token)) throw new SendStop(SEND_COPY.fallback);
  if (p.amountRaw <= 0n) throw new SendStop(SEND_COPY.fallback);
  const blocked = recipientBlock(p.to, p.user);
  if (blocked) throw new SendStop(BLOCK_TEXT[blocked]);
  const transfer: Call = {
    to: p.token.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [p.to, p.amountRaw] }),
    value: 0n,
  };
  const isCash = isAddressEqual(p.token.address, USDC.address);
  return payFromCash(p.user, isCash ? p.amountRaw : 0n, p.cash, [transfer], { sendTo: p.to });
}

/** What Activity shows while a Send confirms: the move, and who it went to (the name too, for this device's quick picks). */
export function sendActivity(token: ReserveAsset, amountRaw: bigint, to: Recipient): ActivityItem[] {
  return [{ kind: "send", symbol: token.symbol, amount: Number(amountRaw) / 10 ** token.decimals, to: to.address, ...(to.name ? { toName: to.name } : {}) }];
}

// ─── The screen ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type SendView = ReturnType<typeof planSend>;

/**
 * Everything the Send screen shows, from what is sent, the dollars, the account and the recipient: the amount card's
 * hint, MAX, what it moves (USDC raw units, or the stock's raw shares: every free share on MAX), the line that says why
 * the amount can't go, the recipient's guard, the summary rows, the small print, the button and whether it's ready.
 */
export function planSend(p: {
  asset: SendAsset | null;
  amount: string;
  all: boolean;
  data: SendData;
  user: Address;
  recipient: Recipient | null;
  checks: RecipientChecks;
}) {
  const { data } = p;
  const token = p.asset ? sendTokenOf(p.asset) : undefined;
  const stock = p.asset && p.asset !== "cash" ? stockOf(p.asset) : undefined;
  const holding = stock ? data.holdings.find((h) => h.symbol === stock.symbol) : undefined;
  const usdRaw = usdRawOf(p.amount);
  const amountUsd = toUsd(usdRaw);
  const maxUsd = p.asset ? maxUsdOf(p.asset, data) : 0;
  // MAX sends every free share, to the last unit, while the dollars still say all of it; typed dollars become shares at
  // Aave's price, rounded down.
  const sellAll = p.all && maxUsd > 0 && amountUsd >= maxUsd;
  const sharesRaw = stock && holding ? (sellAll ? holding.freeRaw : sharesForUsdRaw(usdRaw, holding.priceRaw, stock.decimals)) : 0n;
  const amountRaw = p.asset === "cash" ? usdRaw : sharesRaw;
  const shares = stock && holding ? rawToShares(sharesRaw, holding.multiplier, stock.decimals) : 0;
  const ticker = stock ? tickerOf(stock.symbol) : "";
  const noFee = cashRaw(data.cash) < feeBufferRaw;

  // Why the amount can't go: first what the asset allows at any amount, then the amount.
  let amountBlock: string | null = null;
  if (p.asset === "cash" && amountUsd > maxUsd) amountBlock = amountUsd > data.cashUsd ? SEND_COPY.overCash(data.cashUsd) : SEND_COPY.feeBuffer;
  else if (stock && noFee) amountBlock = SEND_COPY.noFee;
  else if (stock && holding && holding.freeRaw === 0n) amountBlock = SEND_COPY.allBacks(holding.name);
  else if (stock && holding && sharesRaw > holding.freeRaw) amountBlock = SEND_COPY.notFree;
  else if (stock && amountUsd > 0 && sharesRaw === 0n) amountBlock = SEND_COPY.tooSmall;

  const to = p.recipient ? recipientNote(p.recipient, p.user, p.checks) : null;
  const who = p.recipient ? (p.recipient.name ?? shortAddress(p.recipient.address)) : null;

  const hint = !p.asset
    ? []
    : p.asset === "cash"
      ? [SEND_COPY.cashHint(data.cashUsd)]
      : [
          SEND_COPY.freeHint(maxUsd),
          ...(holding && holding.lockedRaw > 0n ? [SEND_COPY.backsHint(holding.lockedUsd)] : []),
          ...(sharesRaw > 0n && !amountBlock ? [SEND_COPY.sharesHint(formatShares(shares), ticker)] : []),
        ];

  const shown = amountRaw > 0n && !amountBlock;
  const theyGet = !shown ? "—" : p.asset === "cash" ? formatUsd(amountUsd) : `${formatShares(shares)} ${ticker} · ${SEND_COPY.about(toUsd(usdRaw))}`;
  const rows = [
    { label: SEND_COPY.to, value: who ?? "—" },
    { label: SEND_COPY.theyGet, value: theyGet },
  ];

  const ready = !!token && amountRaw > 0n && !amountBlock && !!p.recipient && !!to && !to.block && !to.waiting;
  const button = p.asset === "cash" ? (amountUsd > 0 && !amountBlock ? SEND_COPY.sendUsd(amountUsd) : SEND_COPY.button) : holding ? SEND_COPY.sendStock(holding.name) : SEND_COPY.button;
  const what = p.asset === "cash" ? formatUsd(amountUsd) : `${formatShares(shares)} ${ticker}`;

  return {
    token,
    stock,
    holding,
    maxUsd,
    amountUsd,
    amountRaw,
    sharesRaw,
    hint,
    amountNote: amountBlock,
    toNote: to?.block ? { text: to.block, tone: "act" as const } : to?.warn ? { text: to.warn, tone: "watch" as const } : null,
    waiting: !!to?.waiting,
    rows,
    smallPrint:
      ready && token && p.recipient ? sendSmallPrint({ token, amountRaw, multiplier: holding?.multiplier, to: p.recipient.address, name: holding?.name }) : null,
    button,
    ready,
    /** "$20.00" or "0.0430 NVDA", and to whom, for the done state. */
    sentTitle: who ? SEND_COPY.sent(what, who) : null,
  };
}

/** Every decimal of a raw amount, at least to the cent: "25.00", "0.00723456". */
const exact = (raw: bigint, decimals: number) => {
  const [int, frac = ""] = formatUnits(raw, decimals).split(".");
  return `${int}.${frac.padEnd(2, "0")}`;
};

/**
 * A Send's small print (D7): the one move, to the last decimal, with the full address, and what a stock is. It may name
 * the token, as the Buy and Sell steps' small print does. A stock's amount is in shares (raw × uiMultiplier).
 */
export function sendSmallPrint(p: { token: ReserveAsset; amountRaw: bigint; multiplier?: bigint; to: Address; name?: string }): string {
  const isCash = isAddressEqual(p.token.address, USDC.address);
  const what = isCash
    ? `exactly ${exact(p.amountRaw, USDC.decimals)} USDC`
    : `exactly ${exact((p.amountRaw * (p.multiplier ?? 10n ** 18n)) / 10n ** 18n, p.token.decimals)} ${tickerOf(p.token.symbol)}`;
  const stockLine = isCash
    ? ""
    : ` Only free shares are sent; what backs your credit stays. ${p.name ?? p.token.name} here is a tokenized stock: it tracks the share price; it is not a company share and carries no vote.`;
  return `In one go: ${what} goes to ${getAddress(p.to)} on Base.${stockLine} A send can’t be undone.`;
}
