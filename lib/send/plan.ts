import type { Address } from "viem";
import { ORACLE_DECIMALS } from "@/lib/aave/addresses";
import { cashRaw, feeBufferRaw, toUsd } from "@/lib/cash";
import { formatShares, formatUsd, shortAddress } from "@/lib/formatting";
import { rawToShares } from "@/lib/tokens/b20";
import { USDC } from "@/lib/tokens/registry";
import { maxUsdOf, sharesForUsdRaw, stockOf, type AmountHint } from "@/lib/trade";
import { NO_DUST_USD } from "@/lib/sell";
import { SEND_COPY, recipientNote, sendSmallPrint, tickerOf } from "./copy";
import { sendTokenOf } from "./calls";
import { usdRawOf, type SendAsset, type SendData } from "./options";
import type { Recipient, RecipientChecks } from "./recipient";

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
  // An amount that would leave less than NO_DUST_USD of a stock sends all of it (ruling 7b).
  const sellAll =
    maxUsd > 0 &&
    amountUsd > 0 &&
    (p.all ? amountUsd >= maxUsd : !!stock && amountUsd <= maxUsd + 1e-9 && maxUsd - amountUsd < NO_DUST_USD);
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

  const hint: AmountHint | null = !p.asset
    ? null
    : p.asset === "cash"
      ? SEND_COPY.cashHint(data.cashUsd)
      : { shares, priceUsd: holding?.priceUsd ?? 0, upToUsd: maxUsd };

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
  // Ruling 44: while it's off for want of an amount or a person, the button says which.
  const button =
    amountRaw === 0n
      ? SEND_COPY.enterAmount
      : !p.recipient
        ? SEND_COPY.addWho
        : p.asset === "cash"
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
          })
        : null,
    button,
    ready,
    /** "$20.00" or "0.043 NVIDIA", and to whom, for the done state. */
    sentTitle: who ? SEND_COPY.sent(what, who) : null,
  };
}
