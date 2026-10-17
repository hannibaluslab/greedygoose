import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  parseUnits,
  type Address,
  type Client,
} from "viem";
import { getBalance, getCode, getTransactionCount, readContract } from "viem/actions";
import { CASH } from "@/config/risk";
import { ORACLE_DECIMALS } from "@/lib/aave/addresses";
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
const held = (h: SendData["holdings"][number]) => h.freeRaw + h.backingRaw > 0n;

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
  notAccount:
    "That address is a contract that holds or trades money, not someone’s account. Money sent there would be lost.",
  unused: "This address hasn’t been used on Base yet. Check it’s right.",
  unchecked: "We couldn’t check this address on Base right now. Check it’s right.",
  typo: "This address has a typo in it. Copy it again from where you found it.",
  shape: "An address starts with 0x and has 40 more letters and numbers.",
  badName: "Type a name, like sam.justan.id or a .eth name, or a 0x address.",
  noName: (name: string) => `No account goes by ${name}.`,
  lookupFailed: "We couldn’t look that up right now. Try again.",
  ethOnly: "This name only gives an Ethereum address. Send only if it’s the same account on Base.",
  ethOnlyContract: (name: string) =>
    `${name} is a wallet on Ethereum that isn’t on Base. Ask them for their Base address.`,
  ethUnchecked: "We couldn’t check where this name’s address is right now. Try again in a moment.",
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
  stockFallback: "This stock can’t go to that address right now. Send to someone else, or try again later.",
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
type SendOption = {
  asset: SendAsset;
  name: string;
  sub?: string;
  right?: string;
  rightSub?: string;
  disabled: boolean;
  freeUsd: number;
};

/**
 * "Send from": Cash (what MAX takes: the cash less the network-fee buffer, CASH.feeBufferUsd), then each stock held.
 * A stock sends only its free shares; one whose shares all back credit is listed, says so and can't be picked. Stocks
 * not held aren't listed. Cash first, then what can be picked by free value, then the rest.
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
      sub:
        h.freeRaw === 0n
          ? SEND_COPY.subAllBacks
          : h.backingRaw > 0n
            ? SEND_COPY.subBacks(h.backingUsd)
            : SEND_COPY.subShares(h.freeShares),
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
type ToInput =
  | { kind: "empty" }
  | { kind: "address"; address: Address }
  | { kind: "name"; name: string }
  | { kind: "invalid"; text: string };

/**
 * Reads what was typed in To. Anything starting with 0x and without a dot is an address: 0x and 40 hex characters,
 * all lowercase, all capitals (EIP-55's two forms without a checksum; QR codes often use capitals) or in its
 * checksum's exact capitals (viem's strict `isAddress`); mixed capitals that don't match the checksum have a typo.
 * Anything else is a name, 0xfoo.eth included: "sam" means sam.justan.id (the app's name parent), a dotted one is
 * taken as typed (ENS's normalization).
 */
export function parseTo(text: string): ToInput {
  const t = text.trim();
  if (!t) return { kind: "empty" };
  if (/^0x/i.test(t) && !t.includes(".")) {
    if (!/^0x[0-9a-f]{40}$/i.test(t)) return { kind: "invalid", text: SEND_COPY.shape };
    const hex = t.slice(2);
    const noChecksum = hex === hex.toLowerCase() || hex === hex.toUpperCase();
    if (!noChecksum && !isAddress(`0x${hex}`, { strict: true })) return { kind: "invalid", text: SEND_COPY.typo };
    return { kind: "address", address: getAddress(`0x${hex.toLowerCase()}`) };
  }
  const name = fullName(t);
  return name ? { kind: "name", name } : { kind: "invalid", text: SEND_COPY.badName };
}

/** Who Send pays: the address, the name it came from (or the address's own name), and whether that's its Base address. */
export type Recipient = { address: Address; name: string | null; onBase: boolean };

/** What Base says about the recipient (readRecipient). */
type BaseCheck = { code: boolean; used: boolean; notAccount: boolean };

/**
 * What Base says about the recipient (readRecipient): whether it has code, whether it was ever used (code, a sent
 * transaction, ETH or USDC), and whether it's a token or a trading pool rather than an account. `ethCode`: for a name
 * that only gives an Ethereum address, whether that address has code on Ethereum (a contract wallet there may not be the
 * same account on Base). Undefined while reading, null if the read failed.
 */
export type RecipientChecks = {
  base?: BaseCheck | null;
  ethCode?: boolean | null;
};

/** A token's and a pool's own questions: every ERC-20 answers the first two, every Uniswap- or Aerodrome-style pool the last two. */
const tokenOrPoolAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

/** The contract didn't answer that question (it reverted, or answered nothing a value can be read from); any other error is thrown on. */
const noAnswer = (e: unknown) =>
  e instanceof BaseError &&
  !!e.walk(
    (x) =>
      x instanceof ContractFunctionRevertedError ||
      x instanceof ContractFunctionZeroDataError ||
      x instanceof AbiDecodingZeroDataError ||
      x instanceof AbiDecodingDataSizeTooSmallError,
  );
const answers = (p: Promise<unknown>) =>
  p.then(
    () => true,
    (e) => {
      if (noAnswer(e)) return false;
      throw e;
    },
  );

/**
 * Whether a contract is a token or a trading pool, not an account: a token (it answers decimals and totalSupply) or a
 * pool (token0 and token1). Money sent to one is stuck or taken by whoever trades next. Accounts (JAW's, a Safe) answer
 * none of these. This catches what APP_CONTRACTS can't list: other tokens (WETH) and the venues' pools, whose
 * addresses are worked out from the factories rather than kept.
 */
async function isTokenOrPool(client: Client, address: Address): Promise<boolean> {
  const ask = (functionName: "decimals" | "totalSupply" | "token0" | "token1") =>
    answers(readContract(client, { address, abi: tokenOrPoolAbi, functionName }));
  const [decimals, supply, token0, token1] = await Promise.all([
    ask("decimals"),
    ask("totalSupply"),
    ask("token0"),
    ask("token1"),
  ]);
  return (decimals && supply) || (token0 && token1);
}

/** One read of the recipient on Base, in parallel: its code, its nonce, its ETH and its USDC; then, for a contract, whether it's a token or a pool. */
export async function readRecipient(client: Client, address: Address): Promise<BaseCheck> {
  const [code, nonce, eth, usdc] = await Promise.all([
    getCode(client, { address }),
    getTransactionCount(client, { address }),
    getBalance(client, { address }),
    readContract(client, { address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  const hasCode = !!code && code !== "0x";
  return {
    code: hasCode,
    used: hasCode || nonce > 0 || eth > 0n || usdc > 0n,
    notAccount: hasCode && (await isTokenOrPool(client, address)),
  };
}

const BLOCK_TEXT: Record<RecipientBlock, string> = {
  self: SEND_COPY.self,
  zero: SEND_COPY.zero,
  contract: SEND_COPY.contract,
};

/**
 * The recipient's guards, refused before warned. Refused: the account itself, the zero address and the app's or its
 * protocols' contracts (lib/contracts.ts); any other token or trading pool (Base says so); a name whose only address
 * is a contract on Ethereum with nothing on Base; and such a name when Ethereum or Base couldn't be asked, since that
 * can't be told apart. Warned: a name that only gives an Ethereum address (it may be a different account on Base, an
 * exchange's deposit address is a plain key too); an address Base has never seen used; an address Base couldn't be
 * asked about. `waiting` until Base has answered, so a warning never lands after the tap.
 */
export function recipientNote(
  r: Recipient,
  user: Address,
  checks: RecipientChecks,
): { block: string | null; warn: string | null; waiting: boolean } {
  const note = (block: string | null, warn: string | null = null) => ({ block, warn, waiting: false });
  const blocked = recipientBlock(r.address, user);
  if (blocked) return note(BLOCK_TEXT[blocked]);
  if (checks.base === undefined || (!r.onBase && checks.ethCode === undefined))
    return { block: null, warn: null, waiting: true };
  if (checks.base?.notAccount) return note(SEND_COPY.notAccount);
  if (!r.onBase) {
    if (checks.ethCode === null || checks.base === null) return note(SEND_COPY.ethUnchecked);
    if (checks.ethCode && !checks.base.code) return note(SEND_COPY.ethOnlyContract(r.name ?? shortAddress(r.address)));
    return note(null, SEND_COPY.ethOnly);
  }
  if (checks.base === null) return note(null, SEND_COPY.unchecked);
  return note(null, checks.base.used ? null : SEND_COPY.unused);
}

/** Where To stands: nothing yet, looking a name up, who it is, or why there's no one. */
export type ToState =
  | { kind: "idle" }
  | { kind: "looking"; name: string }
  | { kind: "found"; recipient: Recipient }
  | { kind: "none"; text: string };

/** Looks a name up (lib/jaw/name.ts addressOfName): its address, the name it gives back, and whether that's its Base address. */
type NameLookup = (name: string) => Promise<{ name: string | null; address: Address; onBase: boolean } | null>;

/**
 * To's lookups, in order (useRecipient holds one). Each find, pick, edit or clear replaces whatever came before it: a
 * lookup that answers after the user moved on (typed something else, cleared the field, pasted an address, picked
 * someone) is dropped, so it never becomes the recipient. A pasted address is taken at once; a name is looked up. A
 * pick has no name of its own: the address's name is checked again where it's shown (it could point elsewhere now).
 */
export function toLookups(set: (s: ToState) => void, lookup: NameLookup) {
  let seq = 0;
  let now: ToState = { kind: "idle" };
  const put = (s: ToState) => {
    now = s;
    set(s);
  };
  return {
    async find(text: string) {
      const id = ++seq;
      const parsed = parseTo(text);
      if (parsed.kind === "empty") return put({ kind: "idle" });
      if (parsed.kind === "invalid") return put({ kind: "none", text: parsed.text });
      if (parsed.kind === "address")
        return put({ kind: "found", recipient: { address: parsed.address, name: null, onBase: true } });
      put({ kind: "looking", name: parsed.name });
      try {
        const r = await lookup(parsed.name);
        if (id !== seq) return;
        put(
          r
            ? { kind: "found", recipient: { address: r.address, name: r.name ?? parsed.name, onBase: r.onBase } }
            : { kind: "none", text: SEND_COPY.noName(parsed.name) },
        );
      } catch {
        if (id === seq) put({ kind: "none", text: SEND_COPY.lookupFailed });
      }
    },
    pick(address: Address) {
      seq += 1;
      put({ kind: "found", recipient: { address, name: null, onBase: true } });
    },
    /** The field changed: a lookup in flight is dropped, and what the last one said (looking, or why there was no one) goes. */
    edit() {
      seq += 1;
      if (now.kind === "looking" || now.kind === "none") put({ kind: "idle" });
    },
    clear() {
      seq += 1;
      put({ kind: "idle" });
    },
  };
}

/** The people sent to from this device, newest first, once each, for the quick picks: from Activity's own records. */
export function recentRecipients(
  local: readonly LocalActivity[],
  limit = 4,
): { address: Address; name: string | null }[] {
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
const sendTokenOf = (asset: SendAsset): ReserveAsset | undefined => (asset === "cash" ? USDC : stockOf(asset));

const isRegistryToken = (t: ReserveAsset) =>
  isAddressEqual(t.address, USDC.address) || EQUITIES.some((e) => isAddressEqual(e.address, t.address));

/**
 * A Send in one batch: transfer(to, amount) of USDC or the stock, and nothing else of the user's leaves. Cash is the one
 * pot (D20): when the wallet can't be counted on for the amount and the network fee, the savings withdrawal goes first
 * (payFromCash); a stock send takes only the fee from the cash. Refuses the user, the zero address and the app's or its
 * protocols' contracts, and any amount of 0. Every call passes the allowlist with the recipient declared (`sendTo`), so
 * the transfer can go to that address only.
 */
export function buildSendCalls(p: {
  user: Address;
  token: ReserveAsset;
  to: Address;
  amountRaw: bigint;
  cash: Cash;
}): Call[] {
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
  return [
    {
      kind: "send",
      symbol: token.symbol,
      amount: Number(amountRaw) / 10 ** token.decimals,
      to: to.address,
      ...(to.name ? { toName: to.name } : {}),
    },
  ];
}

// ─── The screen ─────────────────────────────────────────────────────────────────────────────────────────────────────

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
  const sharesRaw =
    stock && holding ? (sellAll ? holding.freeRaw : sharesForUsdRaw(usdRaw, holding.priceRaw, stock.decimals)) : 0n;
  const amountRaw = p.asset === "cash" ? usdRaw : sharesRaw;
  const shares = stock && holding ? rawToShares(sharesRaw, holding.multiplier, stock.decimals) : 0;
  const ticker = stock ? tickerOf(stock.symbol) : "";
  const noFee = cashRaw(data.cash) < feeBufferRaw;

  // Why the amount can't go: first what the asset allows at any amount, then the amount.
  let amountBlock: string | null = null;
  if (p.asset === "cash" && amountUsd > maxUsd)
    amountBlock = amountUsd > data.cashUsd ? SEND_COPY.overCash(data.cashUsd) : SEND_COPY.feeBuffer;
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
          ...(holding && holding.backingRaw > 0n ? [SEND_COPY.backsHint(holding.backingUsd)] : []),
          ...(sharesRaw > 0n && !amountBlock ? [SEND_COPY.sharesHint(formatShares(shares), ticker)] : []),
        ];

  const shown = amountRaw > 0n && !amountBlock;
  // A stock's dollars are what the shares sent are worth at Aave's price, not the dollars typed: on MAX, a refresh
  // that leaves fewer free shares sends fewer, and the summary says what they're worth.
  const sharesUsdRaw =
    stock && holding
      ? (sharesRaw * holding.priceRaw) / 10n ** BigInt(stock.decimals + ORACLE_DECIMALS - USDC.decimals)
      : 0n;
  const theyGet = !shown
    ? "—"
    : p.asset === "cash"
      ? formatUsd(amountUsd)
      : `${formatShares(shares)} ${ticker} · ${SEND_COPY.about(toUsd(sharesUsdRaw))}`;
  const rows = [
    { label: SEND_COPY.to, value: who ?? "—" },
    { label: SEND_COPY.theyGet, value: theyGet },
  ];

  const ready = !!token && amountRaw > 0n && !amountBlock && !!p.recipient && !!to && !to.block && !to.waiting;
  const button =
    p.asset === "cash"
      ? amountUsd > 0 && !amountBlock
        ? SEND_COPY.sendUsd(amountUsd)
        : SEND_COPY.button
      : holding
        ? SEND_COPY.sendStock(holding.name)
        : SEND_COPY.button;
  // The done line names the stock ("Sent 0.0072 Amazon"), as the Trade sheet's "Sold 0.0029 Alphabet" does.
  const what = p.asset === "cash" ? formatUsd(amountUsd) : `${formatShares(shares)} ${holding?.name ?? ticker}`;

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
    toNote: to?.block
      ? { text: to.block, tone: "act" as const }
      : to?.warn
        ? { text: to.warn, tone: "watch" as const }
        : null,
    waiting: !!to?.waiting,
    rows,
    smallPrint:
      ready && token && p.recipient
        ? sendSmallPrint({
            token,
            amountRaw,
            multiplier: holding?.multiplier,
            to: p.recipient.address,
            name: holding?.name,
          })
        : null,
    button,
    ready,
    /** "$20.00" or "0.043 NVIDIA", and to whom, for the done state. */
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
export function sendSmallPrint(p: {
  token: ReserveAsset;
  amountRaw: bigint;
  multiplier?: bigint;
  to: Address;
  name?: string;
}): string {
  const isCash = isAddressEqual(p.token.address, USDC.address);
  const what = isCash
    ? `exactly ${exact(p.amountRaw, USDC.decimals)} USDC`
    : `exactly ${exact((p.amountRaw * (p.multiplier ?? 10n ** 18n)) / 10n ** 18n, p.token.decimals)} ${tickerOf(p.token.symbol)}`;
  const stockLine = isCash
    ? ""
    : ` Only free shares are sent; what backs your credit stays. ${p.name ?? p.token.name} here is a tokenized stock: it tracks the share price; it is not a company share and carries no vote.`;
  return `In one go: ${what} goes to ${getAddress(p.to)} on Base.${stockLine} A send can’t be undone.`;
}
