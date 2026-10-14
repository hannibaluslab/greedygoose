import { erc20Abi, isAddressEqual, parseEventLogs, type Log } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { ALL_RESERVES, EQUITIES, USDC, findByAddress } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { GUARDIAN } from "@/lib/guardian/config";

export type ActivityKind = "supply" | "withdraw" | "borrow" | "repay" | "buy" | "sell" | "receive" | "send" | "save" | "unsave" | "convert";

export type ActivityItem = {
  kind: ActivityKind;
  /** Registry symbol, e.g. NVDAc or USDC. */
  symbol: string;
  /** Human amount in token units (raw / 10^decimals; shares use raw units). */
  amount: number;
  /** For buys: USDC paid. */
  paidUsd?: number;
  /** For sells, and for other dollars turned into cash (`convert`, `symbol` is the coin's): USDC received. */
  receivedUsd?: number;
  /** For a buy or a repay: what came out of savings in the same batch to pay for it (cash is savings, D15). */
  fromSavingsUsd?: number;
};

const byReserveId = (id: bigint) => ALL_RESERVES.find((r) => BigInt(r.reserveId) === id);
const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/**
 * Decode what happened to `user` in one transaction receipt. A bundle tx can carry other
 * accounts' operations, so every event is filtered by the user's address. A savings withdrawal
 * that pays for a buy or a repay in the same batch is part of that move, not one of its own: it
 * goes on it as `fromSavingsUsd` (the raw move stays in the details, plan item 1).
 */
export function decodeActivity(logs: Log[], user: `0x${string}`): ActivityItem[] {
  const items: ActivityItem[] = [];

  const spokeLogs = parseEventLogs({
    abi: spokeAbi,
    logs: logs.filter((l) => isAddressEqual(l.address, AAVE.SPOKE)),
    eventName: ["Supply", "Withdraw", "Borrow", "Repay"],
    strict: false,
  });
  for (const ev of spokeLogs) {
    const a = ev.args as { reserveId?: bigint; user?: `0x${string}`; suppliedAmount?: bigint; withdrawnAmount?: bigint; drawnAmount?: bigint; totalAmountRepaid?: bigint };
    if (!a.user || !isAddressEqual(a.user, user) || a.reserveId === undefined) continue;
    const r = byReserveId(a.reserveId);
    if (!r) continue;
    const raw = firstBigint(ev.args as Record<string, unknown>, ["suppliedAmount", "withdrawnAmount", "drawnAmount", "totalAmountRepaid", "amount"]);
    const kind = ({ Supply: "supply", Withdraw: "withdraw", Borrow: "borrow", Repay: "repay" } as const)[ev.eventName as "Supply" | "Withdraw" | "Borrow" | "Repay"];
    items.push({ kind, symbol: r.symbol, amount: units(raw, r.decimals) });
  }

  const tracked = [...EQUITIES.map((e) => e.address), USDC.address];
  const transfers = parseEventLogs({
    abi: erc20Abi,
    logs: logs.filter((l) => tracked.some((a) => isAddressEqual(a, l.address))),
    eventName: "Transfer",
    strict: false,
  });
  const touchesAave = (addr?: `0x${string}`) => !!addr && (isAddressEqual(addr, AAVE.HUB) || isAddressEqual(addr, AAVE.SPOKE));
  let usdcOut = 0n;
  let fromSavings = 0n;
  const usdcIn: bigint[] = [];
  const stockIn: { symbol: string; raw: bigint; decimals: number }[] = [];
  const stockOut: { symbol: string; raw: bigint; decimals: number }[] = [];
  for (const t of transfers) {
    const { from, to, value } = t.args as { from?: `0x${string}`; to?: `0x${string}`; value?: bigint };
    if (value === undefined) continue;
    const token = findByAddress(t.address);
    if (!token) continue;
    // Aave V4 moves are already covered by Spoke events.
    if (touchesAave(from) || touchesAave(to)) continue;
    // Aave V3 savings: USDC into / out of the aToken contract.
    if (token.kind === "debt" && from && to && isAddressEqual(from, user) && isAddressEqual(to, GUARDIAN.AUSDC)) {
      items.push({ kind: "save", symbol: token.symbol, amount: units(value, token.decimals) });
      continue;
    }
    if (token.kind === "debt" && from && to && isAddressEqual(from, GUARDIAN.AUSDC) && isAddressEqual(to, user)) {
      fromSavings += value;
      continue;
    }
    if (token.kind === "debt" && from && isAddressEqual(from, user)) usdcOut += value;
    if (token.kind === "equity" && to && isAddressEqual(to, user)) stockIn.push({ symbol: token.symbol, raw: value, decimals: token.decimals });
    if (token.kind === "equity" && from && isAddressEqual(from, user)) stockOut.push({ symbol: token.symbol, raw: value, decimals: token.decimals });
    if (token.kind === "debt" && to && isAddressEqual(to, user)) usdcIn.push(value);
  }
  for (const s of stockIn) {
    items.push(
      usdcOut > 0n
        ? { kind: "buy", symbol: s.symbol, amount: units(s.raw, s.decimals), paidUsd: units(usdcOut, USDC.decimals) }
        : { kind: "receive", symbol: s.symbol, amount: units(s.raw, s.decimals) },
    );
  }
  // Stock out and USDC in, in one transaction, is a sale (the app sells one stock per batch).
  const receivedRaw = usdcIn.reduce((a, v) => a + v, 0n);
  for (const s of stockOut) {
    items.push(
      receivedRaw > 0n
        ? { kind: "sell", symbol: s.symbol, amount: units(s.raw, s.decimals), receivedUsd: units(receivedRaw, USDC.decimals) }
        : { kind: "send", symbol: s.symbol, amount: units(s.raw, s.decimals) },
    );
  }
  // Other dollars out and USDC in is a conversion into cash (lib/swap/entry.ts): each swap pays the user once, in the
  // order the coins went out.
  const coinsOut = parseEventLogs({
    abi: erc20Abi,
    logs: logs.filter((l) => ENTRY_COINS.some((c) => isAddressEqual(c.address, l.address))),
    eventName: "Transfer",
    strict: false,
  }).flatMap((t) => {
    const { from, value } = t.args as { from?: `0x${string}`; value?: bigint };
    const coin = ENTRY_COINS.find((c) => isAddressEqual(c.address, t.address))!;
    return from && value !== undefined && isAddressEqual(from, user) ? [{ coin, value }] : [];
  });
  const converted = usdcIn.length >= coinsOut.length ? coinsOut : [];
  converted.forEach(({ coin, value }, i) =>
    items.push({ kind: "convert", symbol: coin.symbol, amount: units(value, coin.decimals), receivedUsd: units(usdcIn[i], USDC.decimals) }),
  );
  if (stockIn.length === 0 && usdcOut > 0n) items.push({ kind: "send", symbol: USDC.symbol, amount: units(usdcOut, USDC.decimals) });
  if (stockOut.length === 0) {
    for (const v of usdcIn.slice(converted.length)) items.push({ kind: "receive", symbol: USDC.symbol, amount: units(v, USDC.decimals) });
  }
  if (fromSavings > 0n) {
    const paid = items.find((i) => i.kind === "buy" || i.kind === "repay");
    if (paid) paid.fromSavingsUsd = units(fromSavings, USDC.decimals);
    else items.push({ kind: "unsave", symbol: USDC.symbol, amount: units(fromSavings, USDC.decimals) });
  }
  return items;
}

function firstBigint(args: Record<string, unknown>, keys: string[]): bigint {
  for (const k of keys) if (typeof args[k] === "bigint") return args[k] as bigint;
  // Fall back to the last bigint arg (amount fields come last in these events).
  const vals = Object.values(args).filter((v): v is bigint => typeof v === "bigint");
  return vals.at(-1) ?? 0n;
}
