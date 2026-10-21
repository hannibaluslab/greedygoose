import type { Address } from "viem";
import { ORACLE_DECIMALS } from "@/lib/aave/addresses";
import { cashRaw, feeBufferRaw, toUsd } from "@/lib/cash";
import { formatShares, formatUsd, shortAddress } from "@/lib/formatting";
import { rawToShares } from "@/lib/tokens/b20";
import { USDC } from "@/lib/tokens/registry";
import { maxUsdOf, sharesForUsdRaw, stockOf, type AmountHint } from "@/lib/trade";
import { NO_DUST_USD } from "@/lib/sell";
import { SEND_COPY, recipientNote, sendSmallPrint } from "./copy";
import { tickerOf } from "@/lib/tokens/registry";
import { sendTokenOf } from "./calls";
import { usdRawOf, type SendAsset, type SendData } from "./options";
import type { Recipient, RecipientChecks } from "./recipient";

// ─── The screen ─────────────────────────────────────────────────────────────────────────────────────────────────────

type SendInput = {
  asset: SendAsset | null;
  amount: string;
  all: boolean;
  data: SendData;
  user: Address;
  recipient: Recipient | null;
  checks: RecipientChecks;
};
type SendAmount = ReturnType<typeof sendAmount>;

/**
 * What the amount moves: USDC raw units, or the stock's raw shares. MAX sends every free share, to the last unit, while
 * the dollars still say all of it; typed dollars become shares at Aave's price, rounded down.
 */
function sendAmount(p: SendInput) {
  const { data } = p;
  const stock = p.asset && p.asset !== "cash" ? stockOf(p.asset) : undefined;
  const holding = stock ? data.holdings.find((h) => h.symbol === stock.symbol) : undefined;
  const usdRaw = usdRawOf(p.amount);
  const amountUsd = toUsd(usdRaw);
  const maxUsd = p.asset ? maxUsdOf(p.asset, data) : 0;
  // An amount that would leave less than NO_DUST_USD of a stock sends all of it (ruling 7b).
  const sellAll =
    maxUsd > 0 &&
    amountUsd > 0 &&
    (p.all ? amountUsd >= maxUsd : !!stock && amountUsd <= maxUsd + 1e-9 && maxUsd - amountUsd < NO_DUST_USD);
  const sharesRaw =
    stock && holding ? (sellAll ? holding.freeRaw : sharesForUsdRaw(usdRaw, holding.priceRaw, stock.decimals)) : 0n;
  const shares = stock && holding ? rawToShares(sharesRaw, holding.multiplier, stock.decimals) : 0;
  // A stock's dollars are what the shares sent are worth at Aave's price, not the dollars typed: on MAX, a refresh
  // that leaves fewer free shares sends fewer, and the summary says what they're worth.
  const sharesUsdRaw =
    stock && holding
      ? (sharesRaw * holding.priceRaw) / 10n ** BigInt(stock.decimals + ORACLE_DECIMALS - USDC.decimals)
      : 0n;
  return {
    stock,
    holding,
    usdRaw,
    amountUsd,
    maxUsd,
    sharesRaw,
    amountRaw: p.asset === "cash" ? usdRaw : sharesRaw,
    shares,
    sharesUsdRaw,
    ticker: stock ? tickerOf(stock.symbol) : "",
  };
}

/** Why the amount can't go: first what the asset allows at any amount, then the amount. */
function sendAmountBlock(p: SendInput, a: SendAmount): string | null {
  const { data } = p;
  const { stock, holding, amountUsd } = a;
  if (p.asset === "cash" && amountUsd > a.maxUsd)
    return amountUsd > data.cashUsd ? SEND_COPY.overCash(data.cashUsd) : SEND_COPY.feeBuffer;
  if (!stock) return null;
  if (cashRaw(data.cash) < feeBufferRaw) return SEND_COPY.noFee;
  if (holding && holding.freeRaw === 0n) return SEND_COPY.allBacks(holding.name);
  if (holding && a.sharesRaw > holding.freeRaw) return SEND_COPY.notFree;
  if (amountUsd > 0 && a.sharesRaw === 0n) return SEND_COPY.tooSmall;
  return null;
}

/** Ruling 44: while it's off for want of an amount or a person, the button says which. */
function sendButton(p: SendInput, a: SendAmount): string {
  if (a.amountRaw === 0n) return SEND_COPY.enterAmount;
  if (!p.recipient) return SEND_COPY.addWho;
  // "Send", not "Send $5.00" or "Send Apple" (Adrian, 2026-10-21: what you do, not the details).
  return SEND_COPY.button;
}

/** The amount card's hint: the cash there is, or a stock's shares for the dollars typed and the most it can be. */
function sendHint(p: SendInput, a: SendAmount): AmountHint | null {
  if (!p.asset) return null;
  if (p.asset === "cash") return SEND_COPY.cashHint(p.data.cashUsd);
  return { shares: a.shares, priceUsd: a.holding?.priceUsd ?? 0, upToUsd: a.maxUsd };
}

/** What they get: the dollars, or the shares and what they're worth at Aave's price. */
function theyGetOf(p: SendInput, a: SendAmount): string {
  if (p.asset === "cash") return formatUsd(a.amountUsd);
  return `${formatShares(a.shares)} ${a.ticker} · ${SEND_COPY.about(toUsd(a.sharesUsdRaw))}`;
}

/** The recipient's line: refused (act), warned (watch), or none. */
function toNoteOf(to: { block: string | null; warn: string | null } | null) {
  if (to?.block) return { text: to.block, tone: "act" as const };
  if (to?.warn) return { text: to.warn, tone: "watch" as const };
  return null;
}

/**
 * Everything the Send screen shows, from what is sent, the dollars, the account and the recipient: the amount card's
 * hint, MAX, what it moves (USDC raw units, or the stock's raw shares: every free share on MAX), the line that says why
 * the amount can't go, the recipient's guard, the summary rows, the small print, the button and whether it's ready.
 */
export function planSend(p: SendInput) {
  const token = p.asset ? sendTokenOf(p.asset) : undefined;
  const a = sendAmount(p);
  const { stock, holding, maxUsd, amountUsd, amountRaw, shares, ticker } = a;
  const amountBlock = sendAmountBlock(p, a);

  const to = p.recipient ? recipientNote(p.recipient, p.user, p.checks) : null;
  const who = p.recipient ? (p.recipient.name ?? shortAddress(p.recipient.address)) : null;

  const rows = [
    { label: SEND_COPY.to, value: who ?? "—" },
    { label: SEND_COPY.theyGet, value: amountRaw > 0n && !amountBlock ? theyGetOf(p, a) : "—" },
  ];

  const ready = !!token && amountRaw > 0n && !amountBlock && !!p.recipient && !!to && !to.block && !to.waiting;
  // The done line names the stock ("Sent 0.0072 Amazon"), as the Trade sheet's "Sold 0.0029 Alphabet" does.
  const what = p.asset === "cash" ? formatUsd(amountUsd) : `${formatShares(shares)} ${holding?.name ?? ticker}`;

  return {
    token,
    stock,
    holding,
    maxUsd,
    amountUsd,
    amountRaw,
    sharesRaw: a.sharesRaw,
    hint: sendHint(p, a),
    amountNote: amountBlock,
    toNote: toNoteOf(to),
    waiting: !!to?.waiting,
    rows,
    smallPrint:
      ready && token && p.recipient
        ? sendSmallPrint({
            token,
            amountRaw,
            multiplier: holding?.multiplier,
            to: p.recipient.address,
          })
        : null,
    button: sendButton(p, a),
    ready,
    /** "$20.00" or "0.043 NVIDIA", and to whom, for the done state. */
    sentTitle: who ? SEND_COPY.sent(what, who) : null,
  };
}
