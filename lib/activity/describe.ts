import type { ActivityItem } from "@/lib/activity/decode";
import { formatCoin, formatShares, formatUsd } from "@/lib/formatting";
import { ALL_RESERVES, findByAddress, tickerOf } from "@/lib/tokens/registry";

/** A row of Activity: the moves of one batch, and whether it is confirming, done or failed. */
type MoveRow = { status: "pending" | "done" | "failed"; items: readonly ActivityItem[] };

/**
 * One decoded move in words: what happened, then its amount and sign. Dollars are "Cash" (ruling 26); a send names who
 * it went to, `to` (ruling 25: "Sent Cash to ana.eth").
 */
export function describeActivity(
  i: ActivityItem,
  to?: string,
): { title: string; amount: string; sign: "+" | "−" | "" } {
  const r = ALL_RESERVES.find((x) => x.symbol === i.symbol) ?? findByAddress(i.symbol);
  const name = r?.kind === "equity" ? r.name : "Cash";
  const shares = `${formatShares(i.amount)} ${tickerOf(i.symbol)}`;
  // What moved: shares of a stock, else dollars.
  const moved = r?.kind === "equity" ? shares : formatUsd(i.amount);
  switch (i.kind) {
    case "buy":
      return { title: `Bought ${name}`, amount: `${shares} · ${formatUsd(i.paidUsd ?? 0)}`, sign: "" };
    case "sell":
      return { title: `Sold ${name}`, amount: `${shares} · ${formatUsd(i.receivedUsd ?? 0)}`, sign: "" };
    case "supply":
      return {
        title: `Backed credit with ${name}`,
        amount: moved,
        sign: "",
      };
    case "withdraw":
      return { title: `Freed up ${name}`, amount: moved, sign: "" };
    case "borrow":
      return { title: "Used credit", amount: formatUsd(i.amount), sign: "+" };
    case "earn":
      // One move (lib/activity/decode.ts): the credit that came to the cash and went in to earn, as the Cash sheet says.
      return { title: "Earn with stocks", amount: `${formatUsd(i.amount)} from credit, earning`, sign: "+" };
    case "save":
      // Start earning (lib/activity/decode.ts): the cash went into savings. It stayed the user's cash, so no sign.
      return { title: "Started earning", amount: `${formatUsd(i.amount)} into savings`, sign: "" };
    case "repay":
      return { title: "Repaid credit", amount: formatUsd(i.amount), sign: "−" };
    case "receive":
      return { title: `Received ${name}`, amount: moved, sign: "+" };
    case "send":
      return {
        title: to ? `Sent ${name} to ${to}` : `Sent ${name}`,
        amount: moved,
        sign: "−",
      };
    case "convert":
      return {
        title: `Turned ${i.symbol} into cash`,
        amount: `${formatCoin(i.amount)} ${i.symbol} · ${formatUsd(i.receivedUsd ?? 0)}`,
        sign: "",
      };
  }
}

/** A move's status in words: Confirming or Failed; nothing once it's confirmed. */
export const moveStatus = (status: MoveRow["status"]) =>
  status === "pending" ? "Confirming" : status === "failed" ? "Failed" : null;

/**
 * The line under a move's title: its amount, how many other moves rode in the same batch, and its status. Earn with
 * stocks reads as one move: the backing it put in use is in its details, not "1 more".
 */
export function moveLine(row: MoveRow, d: ReturnType<typeof describeActivity> | null): string {
  const more = row.items[0]?.kind !== "earn" && row.items.length > 1;
  return [d && `${d.sign}${d.amount}`, more && `${row.items.length - 1} more`, moveStatus(row.status)]
    .filter(Boolean)
    .join(" · ");
}
