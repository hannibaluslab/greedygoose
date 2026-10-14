import { StockAvatar, tickerOf } from "./StockAvatar";
import type { ActivityItem } from "@/lib/activity/decode";
import { ALL_RESERVES, findByAddress } from "@/lib/tokens/registry";
import { formatShares, formatUsd } from "@/lib/formatting";

/** One decoded move in words: what happened, then its amount and sign. */
export function describeActivity(i: ActivityItem): { title: string; amount: string; sign: "+" | "−" | "" } {
  const r = ALL_RESERVES.find((x) => x.symbol === i.symbol) ?? findByAddress(i.symbol);
  const name = r?.kind === "equity" ? r.name : "USDC";
  const shares = `${formatShares(i.amount)} ${tickerOf(i.symbol)}`;
  switch (i.kind) {
    case "buy":
      return { title: `Bought ${name}`, amount: `${shares} · ${formatUsd(i.paidUsd ?? 0)}`, sign: "" };
    case "supply":
      return { title: `Backed credit with ${name}`, amount: r?.kind === "equity" ? shares : formatUsd(i.amount), sign: "" };
    case "withdraw":
      return { title: `Freed up ${name}`, amount: r?.kind === "equity" ? shares : formatUsd(i.amount), sign: "" };
    case "borrow":
      return { title: "Used credit", amount: formatUsd(i.amount), sign: "+" };
    case "repay":
      return { title: "Repaid credit", amount: formatUsd(i.amount), sign: "−" };
    case "receive":
      return { title: `Received ${name}`, amount: r?.kind === "equity" ? shares : formatUsd(i.amount), sign: "+" };
    case "send":
      return { title: `Sent ${name}`, amount: r?.kind === "equity" ? shares : formatUsd(i.amount), sign: "−" };
    case "save":
      return { title: "Added to savings", amount: formatUsd(i.amount), sign: "" };
    case "unsave":
      return { title: "Moved savings to cash", amount: formatUsd(i.amount), sign: "" };
  }
}

/** The round mark beside a move: the stock's badge, or a green $ for USDC. */
export function ActivityAvatar({ symbol, size }: { symbol: string; size: number }) {
  if (symbol !== "USDC") return <StockAvatar symbol={symbol} size={size} />;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full bg-safe font-bold text-white"
      style={{ width: size, height: size, fontSize: size * 0.375 }}
    >
      $
    </span>
  );
}
