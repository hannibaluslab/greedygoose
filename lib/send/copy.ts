import { formatUnits, getAddress, isAddressEqual, type Address } from "viem";
import { CASH } from "@/config/risk";
import { recipientBlock, type RecipientBlock } from "@/lib/contracts";
import { formatShares, formatUsd, shortAddress } from "@/lib/formatting";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";
import type { Recipient, RecipientChecks } from "./recipient";

export const tickerOf = (symbol: string) => symbol.replace(/c$/, "");

/** Every main-screen string of Send. None names a protocol or a token standard. */
export const SEND_COPY = {
  title: "Send",
  receive: "Receive",
  youSend: "You send",
  menu: "Send from",
  pill: (name: string) => `Send from: ${name}`,
  cashName: "Cash",
  cashHint: (usd: number) => `Cash available: ${formatUsd(usd)}`,
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
  enterAmount: "Enter an amount",
  addWho: "Add who to send to",
  sendUsd: (usd: number) => `Send ${formatUsd(usd)}`,
  sendStock: (name: string) => `Send ${name}`,
  feeUnsupported: "Your account can’t pay network fees from your cash right now, so this can’t be sent.",
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

export const BLOCK_TEXT: Record<RecipientBlock, string> = {
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

/** Every decimal of a raw amount, at least to the cent: "25.00", "0.00723456". */
const exact = (raw: bigint, decimals: number) => {
  const [int, frac = ""] = formatUnits(raw, decimals).split(".");
  return `${int}.${frac.padEnd(2, "0")}`;
};

/**
 * A Send's small print (D7): the one move, to the last decimal, with the full address. What a stock is stays on the
 * stock sheet (ruling 35). It may name the token, as the Buy and Sell steps' small print does. A stock's amount is in
 * shares (raw × uiMultiplier).
 */
export function sendSmallPrint(p: {
  token: ReserveAsset;
  amountRaw: bigint;
  multiplier?: bigint;
  to: Address;
}): string {
  const isCash = isAddressEqual(p.token.address, USDC.address);
  const what = isCash
    ? `exactly ${exact(p.amountRaw, USDC.decimals)} USDC`
    : `exactly ${exact((p.amountRaw * (p.multiplier ?? 10n ** 18n)) / 10n ** 18n, p.token.decimals)} ${tickerOf(p.token.symbol)}`;
  return `In one go: ${what} goes to ${getAddress(p.to)} on Base. A send can’t be undone.`;
}
