import { encodeFunctionData, erc20Abi, isAddressEqual, type Address } from "viem";
import type { ActivityItem } from "@/lib/activity/decode";
import type { Call } from "@/lib/aave/tx";
import { payFromCash, type Cash } from "@/lib/cash";
import { recipientBlock } from "@/lib/contracts";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";
import { stockOf } from "@/lib/trade";
import { BLOCK_TEXT, SEND_COPY } from "./copy";
import type { SendAsset } from "./options";
import type { Recipient } from "./recipient";

/** Why a Send's batch can't be built, in the screen's words (the screen already stops these; this is the last check). */
export class SendStop extends Error {}

// ─── The batch ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The asset a Send moves: USDC for Cash, or a registry stock; never from a string alone. */
export const sendTokenOf = (asset: SendAsset): ReserveAsset | undefined => (asset === "cash" ? USDC : stockOf(asset));

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
