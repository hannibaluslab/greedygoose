import { erc20Abi, isAddressEqual, parseAbi, parseEventLogs, type Log } from "viem";
import { entryPoint08Abi, entryPoint08Address } from "viem/account-abstraction";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { ALL_RESERVES, EQUITIES, USDC, findByAddress } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { GUARDIAN } from "@/lib/guardian/config";

export type ActivityKind = "supply" | "withdraw" | "borrow" | "repay" | "buy" | "sell" | "receive" | "send" | "convert";

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
};

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
    if (a.paymasterMode !== ERC20_MODE || !a.token || !isAddressEqual(a.token, USDC.address) || a.tokenAmountPaid === undefined) return;
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
 * a move either (feeTransfers): it is no "Sent", and a buy's price leaves it out.
 */
export function decodeActivity(logs: Log[], user: `0x${string}`): ActivityItem[] {
  const items: ActivityItem[] = [];
  const fees = feeTransfers(logs, user);

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
    logs: logs.filter((l) => tracked.some((a) => isAddressEqual(a, l.address)) && !fees.has(l)),
    eventName: "Transfer",
    strict: false,
  });
  const touchesAave = (addr?: `0x${string}`) => !!addr && (isAddressEqual(addr, AAVE.HUB) || isAddressEqual(addr, AAVE.SPOKE));
  let usdcOut = 0n;
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
    // Aave V3 savings: USDC into or out of the aToken contract, within the user's own cash.
    if (token.kind === "debt" && from && to && isAddressEqual(from, user) && isAddressEqual(to, GUARDIAN.AUSDC)) continue;
    if (token.kind === "debt" && from && to && isAddressEqual(from, GUARDIAN.AUSDC) && isAddressEqual(to, user)) continue;
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
  return items;
}

function firstBigint(args: Record<string, unknown>, keys: string[]): bigint {
  for (const k of keys) if (typeof args[k] === "bigint") return args[k] as bigint;
  // Fall back to the last bigint arg (amount fields come last in these events).
  const vals = Object.values(args).filter((v): v is bigint => typeof v === "bigint");
  return vals.at(-1) ?? 0n;
}
