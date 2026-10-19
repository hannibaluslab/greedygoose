import { isAddressEqual } from "viem";
import { SEND_COPY, sendActivity, type Recipient } from "@/lib/send";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";
import { txKey, type TxPlan } from "../prepared";
import type { Address, Batch } from "./types";

/** What a Send signs: from the account, the token, the recipient on screen and the exact amount (raw units). */
export type SendInput = {
  user: Address;
  token: ReserveAsset;
  recipient: Recipient;
  amountRaw: bigint;
};

export const isCashToken = (token: ReserveAsset) => isAddressEqual(token.address, USDC.address);

/**
 * What a Send signs (useTx), keyed by the account, the token, the recipient's address as resolved and the amount: a
 * batch prepared for one recipient is never signed for another (a name that resolved late can't take its place). The
 * recipient's name only labels Activity, so it isn't in the key.
 */
export const sendPlan = (p: SendInput, batch: Batch<SendInput>): TxPlan => ({
  key: txKey(
    "send",
    p.user.toLowerCase(),
    p.token.address.toLowerCase(),
    p.recipient.address.toLowerCase(),
    p.amountRaw,
  ),
  user: p.user,
  calls: () => batch(p),
  fallback: isCashToken(p.token) ? SEND_COPY.fallback : SEND_COPY.stockFallback,
  activity: sendActivity(p.token, p.amountRaw, p.recipient),
});
