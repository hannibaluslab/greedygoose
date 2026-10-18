import { erc20Abi, isAddressEqual, parseAbi, parseEventLogs, type Log } from "viem";
import { entryPoint08Abi, entryPoint08Address } from "viem/account-abstraction";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { ALL_RESERVES, EQUITIES, USDC, findByAddress } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { PROTOCOLS } from "@/lib/protocols/config";
import { savingsEventsAbi } from "@/lib/board/logs";

type ActivityKind =
  | "supply"
  | "withdraw"
  | "borrow"
  | "repay"
  | "buy"
  | "sell"
  | "receive"
  | "send"
  | "convert"
  | "earn"
  | "save";

export type ActivityItem = {
  kind: ActivityKind;
  /** Registry symbol, e.g. NVDAc or USDC. */
  symbol: string;
  /**
   * Human amount in token units (raw / 10^decimals; shares use raw units). For `earn`, the credit that went in to earn;
   * for `save`, the cash that went into savings.
   */
  amount: number;
  /** For buys: USDC paid. */
  paidUsd?: number;
  /** For sells, and for other dollars turned into cash (`convert`, `symbol` is the coin's): USDC received. */
  receivedUsd?: number;
  /** For sends: who it went to, when one account got all of it. */
  to?: `0x${string}`;
  /** For a send this device made: the name it was sent to (sam.justan.id), for Activity and Send's quick picks. */
  toName?: string;
};

/** A stock's own moves: bought, sold, sent or received. */
const TRADES: readonly ActivityKind[] = ["buy", "sell", "send", "receive"];

/**
 * Whether a move is about `symbol`, for that stock's sheet: the stock is the main item, not only the backing for
 * something else. A buy, sale, send or receipt of the stock is; so is the stock coming out of backing (a free-up, a
 * repay that frees it). The stock going in to back credit counts only when nothing else is the move: in a Credit Buy
 * of another stock, or credit that went to earn, it only backs that.
 */
export function aboutStock(items: readonly ActivityItem[], symbol: string): boolean {
  if (items.some((i) => i.symbol === symbol && (TRADES.includes(i.kind) || i.kind === "withdraw"))) return true;
  const other = items.some((i) => i.kind === "earn" || (TRADES.includes(i.kind) && i.symbol !== USDC.symbol));
  return !other && items.some((i) => i.symbol === symbol && i.kind === "supply");
}

const byReserveId = (id: bigint) => ALL_RESERVES.find((r) => BigInt(r.reserveId) === id);
const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/**
 * The paymaster's own record of what it charged (Pimlico's SingletonPaymaster, BaseSingletonPaymaster.sol), emitted
 * at the end of its postOp. Its topic, 0x7a270f29…, is the one on JAW's receipts.
 */
const sponsoredAbi = parseAbi([
  "event UserOperationSponsored(bytes32 indexed userOpHash, address indexed user, uint8 paymasterMode, address token, uint256 tokenAmountPaid, uint256 exchangeRate)",
]);
/** The paymaster's ERC-20 mode: the user pays the fee in a token. */
const ERC20_MODE = 1;

/**
 * JAW's network fee, paid in USDC (D4): the paymaster pulls it from the account in its postOp, inside the same
 * transaction, so it is no move of the user's (measured 2026-10-15 on JAW receipts 0xfb269d33… and 0x21377f51…: a
 * USDC transfer from the account to the paymaster's treasury, `0x4337Ff05…`, not to the paymaster itself). Read from the
 * chain, not guessed: for each user operation of `user` that EntryPoint v0.8 (viem's `entryPoint08Address`, the one JAW
 * sends to) reports with a paymaster, that paymaster's `UserOperationSponsored` for the same operation names the USDC it
 * took; the USDC transfer from the user for exactly that amount just before it is the fee. A paymaster that pre-charged
 * and refunded has no such single transfer, and then nothing is left out.
 */
function feeTransfers(logs: readonly Log[], user: `0x${string}`): Set<Log> {
  const ops = parseEventLogs({
    abi: entryPoint08Abi,
    logs: logs.filter((l) => isAddressEqual(l.address, entryPoint08Address)),
    eventName: "UserOperationEvent",
    strict: false,
  }).filter((o) => o.args.sender && o.args.paymaster && isAddressEqual(o.args.sender, user));
  const fees = new Set<Log>();
  logs.forEach((log, i) => {
    const op = ops.find((o) => isAddressEqual(o.args.paymaster!, log.address));
    if (!op) return;
    const [sponsored] = parseEventLogs({ abi: sponsoredAbi, logs: [log], strict: false });
    const a = sponsored?.args;
    if (!a || a.userOpHash !== op.args.userOpHash || !a.user || !isAddressEqual(a.user, user)) return;
    if (
      a.paymasterMode !== ERC20_MODE ||
      !a.token ||
      !isAddressEqual(a.token, USDC.address) ||
      a.tokenAmountPaid === undefined
    )
      return;
    for (let j = i - 1; j >= 0; j--) {
      const l = logs[j];
      if (fees.has(l) || !isAddressEqual(l.address, USDC.address)) continue;
      const [t] = parseEventLogs({ abi: erc20Abi, logs: [l], eventName: "Transfer", strict: false });
      if (t?.args.from && isAddressEqual(t.args.from, user) && t.args.value === a.tokenAmountPaid) {
        fees.add(l);
        break;
      }
    }
  });
  return fees;
}

/**
 * Decode what happened to `user` in one transaction receipt. A bundle tx can carry other
 * accounts' operations, so every event is filtered by the user's address. USDC moving between the
 * wallet and savings stays inside the cash (D15), and the cash is one pot on screen (D20): it is no
 * move of its own, and a buy or a repay it paid for reads as paid from cash. JAW's network fee isn't
 * a move either (feeTransfers): it is no "Sent", and a buy's price leaves it out. Credit the user's own batch put
 * where the cash earns (Earn with stocks: a USDC savings supply for the user, by the user, beside the credit) is one
 * `earn` item, first, in place of that much credit: money that came to the cash, earning, not money that left. With no
 * credit beside it (Start earning: the wallet's cash into savings, by the user, for the user), it is one `save` item:
 * the cash started earning, nothing left it.
 */
export function decodeActivity(logs: Log[], user: `0x${string}`): ActivityItem[] {
  const items: ActivityItem[] = [];
  const fees = feeTransfers(logs, user);
  const savedRaw = savedByUser(logs, user);
  let creditRaw = 0n;

  const spokeLogs = parseEventLogs({
    abi: spokeAbi,
    logs: logs.filter((l) => isAddressEqual(l.address, AAVE.SPOKE)),
    eventName: ["Supply", "Withdraw", "Borrow", "Repay"],
    strict: false,
  });
  for (const ev of spokeLogs) {
    const a = ev.args as {
      reserveId?: bigint;
      user?: `0x${string}`;
      suppliedAmount?: bigint;
      withdrawnAmount?: bigint;
      drawnAmount?: bigint;
      totalAmountRepaid?: bigint;
    };
    if (!a.user || !isAddressEqual(a.user, user) || a.reserveId === undefined) continue;
    const r = byReserveId(a.reserveId);
    if (!r) continue;
    const raw = firstBigint(ev.args as Record<string, unknown>, [
      "suppliedAmount",
      "withdrawnAmount",
      "drawnAmount",
      "totalAmountRepaid",
      "amount",
    ]);
    const kind = ({ Supply: "supply", Withdraw: "withdraw", Borrow: "borrow", Repay: "repay" } as const)[
      ev.eventName as "Supply" | "Withdraw" | "Borrow" | "Repay"
    ];
    if (kind === "borrow" && r.symbol === USDC.symbol) creditRaw += raw;
    items.push({ kind, symbol: r.symbol, amount: units(raw, r.decimals) });
  }
  // Earn with stocks: the credit that went in to earn is one move, first; any credit beyond it stays credit.
  if (creditRaw > 0n && savedRaw > 0n) {
    const earnRaw = creditRaw < savedRaw ? creditRaw : savedRaw;
    const rest = creditRaw - earnRaw;
    const others = items.filter((i) => !(i.kind === "borrow" && i.symbol === USDC.symbol));
    items.length = 0;
    items.push(
      { kind: "earn", symbol: USDC.symbol, amount: units(earnRaw, USDC.decimals) },
      ...others,
      ...(rest > 0n ? [{ kind: "borrow" as const, symbol: USDC.symbol, amount: units(rest, USDC.decimals) }] : []),
    );
  } else if (creditRaw === 0n && savedRaw > 0n) {
    // Start earning: the wallet's cash went into savings. One move, first; the USDC to the savings pot isn't a send.
    items.unshift({ kind: "save", symbol: USDC.symbol, amount: units(savedRaw, USDC.decimals) });
  }

  const tracked = [...EQUITIES.map((e) => e.address), USDC.address];
  const transfers = parseEventLogs({
    abi: erc20Abi,
    logs: logs.filter((l) => tracked.some((a) => isAddressEqual(a, l.address)) && !fees.has(l)),
    eventName: "Transfer",
    strict: false,
  });
  const touchesAave = (addr?: `0x${string}`) =>
    !!addr && (isAddressEqual(addr, AAVE.HUB) || isAddressEqual(addr, AAVE.SPOKE));
  let usdcOut = 0n;
  const usdcOutTo = new Map<string, `0x${string}`>();
  const usdcIn: bigint[] = [];
  const stockIn: { symbol: string; raw: bigint; decimals: number }[] = [];
  const stockOut: { symbol: string; raw: bigint; decimals: number; to?: `0x${string}` }[] = [];
  for (const t of transfers) {
    const { from, to, value } = t.args as { from?: `0x${string}`; to?: `0x${string}`; value?: bigint };
    if (value === undefined) continue;
    const token = findByAddress(t.address);
    if (!token) continue;
    // Aave V4 moves are already covered by Spoke events.
    if (touchesAave(from) || touchesAave(to)) continue;
    // Aave V3 savings: USDC into or out of the aToken contract, within the user's own cash.
    if (token.kind === "debt" && from && to && isAddressEqual(from, user) && isAddressEqual(to, PROTOCOLS.AUSDC))
      continue;
    if (token.kind === "debt" && from && to && isAddressEqual(from, PROTOCOLS.AUSDC) && isAddressEqual(to, user))
      continue;
    if (token.kind === "debt" && from && isAddressEqual(from, user)) {
      usdcOut += value;
      if (to) usdcOutTo.set(to.toLowerCase(), to);
    }
    if (token.kind === "equity" && to && isAddressEqual(to, user))
      stockIn.push({ symbol: token.symbol, raw: value, decimals: token.decimals });
    if (token.kind === "equity" && from && isAddressEqual(from, user))
      stockOut.push({ symbol: token.symbol, raw: value, decimals: token.decimals, to });
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
        ? {
            kind: "sell",
            symbol: s.symbol,
            amount: units(s.raw, s.decimals),
            receivedUsd: units(receivedRaw, USDC.decimals),
          }
        : { kind: "send", symbol: s.symbol, amount: units(s.raw, s.decimals), ...(s.to ? { to: s.to } : {}) },
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
    items.push({
      kind: "convert",
      symbol: coin.symbol,
      amount: units(value, coin.decimals),
      receivedUsd: units(usdcIn[i], USDC.decimals),
    }),
  );
  if (stockIn.length === 0 && usdcOut > 0n) {
    const [to] = [...usdcOutTo.values()];
    items.push({
      kind: "send",
      symbol: USDC.symbol,
      amount: units(usdcOut, USDC.decimals),
      ...(usdcOutTo.size === 1 ? { to } : {}),
    });
  }
  if (stockOut.length === 0) {
    for (const v of usdcIn.slice(converted.length))
      items.push({ kind: "receive", symbol: USDC.symbol, amount: units(v, USDC.decimals) });
  }
  // A sale into cash puts what it brings straight into savings (lib/sell.ts saleSaveRaw): still the one pot (D20), so
  // the move is the sale alone, not a Start earning too.
  if (items.some((i) => i.kind === "sell")) return items.filter((i) => i.kind !== "save");
  return items;
}

/**
 * USDC the user put into savings for itself in this transaction: Aave V3's Supply of USDC with the user as both the
 * caller and the account it's for (the pool's own event, `savingsEventsAbi` as measured for the board).
 */
function savedByUser(logs: readonly Log[], user: `0x${string}`): bigint {
  return parseEventLogs({
    abi: savingsEventsAbi,
    logs: logs.filter((l) => isAddressEqual(l.address, PROTOCOLS.AAVE_V3_POOL)),
    eventName: "Supply",
    strict: false,
  }).reduce((sum, e) => {
    const a = e.args as { reserve?: `0x${string}`; user?: `0x${string}`; onBehalfOf?: `0x${string}`; amount?: bigint };
    const mine =
      a.reserve &&
      isAddressEqual(a.reserve, USDC.address) &&
      a.user &&
      isAddressEqual(a.user, user) &&
      a.onBehalfOf &&
      isAddressEqual(a.onBehalfOf, user);
    return mine && a.amount !== undefined ? sum + a.amount : sum;
  }, 0n);
}

function firstBigint(args: Record<string, unknown>, keys: string[]): bigint {
  for (const k of keys) if (typeof args[k] === "bigint") return args[k] as bigint;
  // Fall back to the last bigint arg (amount fields come last in these events).
  const vals = Object.values(args).filter((v): v is bigint => typeof v === "bigint");
  return vals.at(-1) ?? 0n;
}
