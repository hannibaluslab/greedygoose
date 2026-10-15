"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { isAddressEqual, type Address } from "viem";
import { usePublicClient } from "wagmi";
import { TxStop, txKey, useTx, type TxPlan } from "./useTx";
import { useSigningCash } from "./useSigningCash";
import { CHAIN_ID } from "@/lib/chain";
import { accountName, addressOfName, hasEthereumCode } from "@/lib/jaw/name";
import { SEND_COPY, SendStop, buildSendCalls, readRecipient, sendActivity, toLookups, type Recipient, type RecipientChecks, type ToState } from "@/lib/send";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

/** What a Send signs: from the account, the token, the recipient on screen and the exact amount (raw units). */
export type SendInput = { user: Address; token: ReserveAsset; recipient: Recipient; amountRaw: bigint };

const isCashToken = (token: ReserveAsset) => isAddressEqual(token.address, USDC.address);

/**
 * Send's batch, built from fresh reads while the screen is idle (lib/tx/prepared.ts): the cash is read again
 * (useSigningCash). A cash send needs the amount and the network fee, a stock send the fee; when the wallet can't be
 * counted on for them, a savings withdrawal goes first (buildSendCalls → payFromCash). The recipient is the one on
 * screen, never looked up again: what the user saw is what is sent.
 */
export function useSendBatch() {
  const cashToSign = useSigningCash();
  return async (p: SendInput) => {
    const cash = await cashToSign(p.user, isCashToken(p.token) ? p.amountRaw : 0n);
    try {
      return buildSendCalls({ user: p.user, token: p.token, to: p.recipient.address, amountRaw: p.amountRaw, cash });
    } catch (e) {
      throw e instanceof SendStop ? new TxStop(e.message) : e;
    }
  };
}

/**
 * What a Send signs (useTx), keyed by the account, the token, the recipient's address as resolved and the amount: a
 * batch prepared for one recipient is never signed for another (a name that resolved late can't take its place). The
 * recipient's name only labels Activity, so it isn't in the key.
 */
export const sendPlan = (p: SendInput, batch: ReturnType<typeof useSendBatch>): TxPlan => ({
  key: txKey("send", p.user.toLowerCase(), p.token.address.toLowerCase(), p.recipient.address.toLowerCase(), p.amountRaw),
  user: p.user,
  calls: () => batch(p),
  fallback: isCashToken(p.token) ? SEND_COPY.fallback : SEND_COPY.stockFallback,
  activity: sendActivity(p.token, p.amountRaw, p.recipient),
});

/**
 * Send's one write path: one useTx, one batch. `input` is what the screen would send now (null while it can't): its
 * batch is prepared while the screen is idle and simulated from the user (useTx), so `sign()` opens JAW's sheet straight
 * from the tap. A stock's transfer that Base refuses (the stock's own rules for who may hold it, or a pause) is worded
 * as being about the recipient, since the screen has already kept the amount to the free shares.
 */
export function useSend(input: SendInput | null) {
  const batch = useSendBatch();
  return useTx(SEND_COPY.failedOnChain, input ? sendPlan(input, batch) : null);
}

export type { ToState };

/**
 * Send's To: what was typed, looked up (a name through ENS's offchain lookup, as the Leaderboard's add by name does),
 * or picked from the quick picks, and what Base says about the address it gives (readRecipient). An address typed in
 * or picked shows its own name when it has one. Lookups run in order (toLookups): one that answers after the field
 * changed is dropped.
 */
export function useRecipient() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const [state, setState] = useState<ToState>({ kind: "idle" });
  const [{ find, pick, edit, clear }] = useState(() => toLookups(setState, addressOfName));
  const found = state.kind === "found" ? state.recipient : null;

  const base = useQuery({
    queryKey: ["send-recipient", found?.address.toLowerCase()],
    queryFn: () => readRecipient(client!, found!.address),
    enabled: !!client && !!found,
    staleTime: 30_000,
    retry: 1,
  });
  const eth = useQuery({
    queryKey: ["eth-code", found?.address.toLowerCase()],
    queryFn: () => hasEthereumCode(found!.address),
    enabled: !!found && !found.onBase,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  // An address typed in or picked: its own name, when it has one (read as the header reads it) and that name points
  // back to it. A reverse record alone proves nothing (anyone can set theirs to any name), and a pasted address shown
  // under someone's name is what address poisoning wants. Quick picks come here too: the name they were saved or
  // listed under may point elsewhere now.
  const own = useQuery({
    queryKey: ["send-name", found?.address.toLowerCase()],
    queryFn: async () => {
      const a = found!.address;
      const name = await accountName(a);
      if (!name) return null;
      const back = await addressOfName(name).catch(() => null);
      return back && isAddressEqual(back.address, a) ? name : null;
    },
    enabled: !!found && !found.name,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const checks: RecipientChecks = {
    base: base.isError ? null : base.data,
    ethCode: !found || found.onBase ? undefined : eth.isError ? null : eth.data,
  };
  const recipient = found ? { ...found, name: found.name ?? own.data ?? null } : null;
  return { state, recipient, checks, find, pick, edit, clear };
}
