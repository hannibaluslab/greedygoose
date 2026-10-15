"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { isAddressEqual, type Address } from "viem";
import { usePublicClient } from "wagmi";
import { TxStop, useTx } from "./useTx";
import { useSigningCash } from "./useSigningCash";
import { CHAIN_ID } from "@/lib/chain";
import { accountName, addressOfName, hasEthereumCode } from "@/lib/jaw/name";
import { SEND_COPY, SendStop, buildSendCalls, parseTo, readRecipient, sendActivity, type Recipient, type RecipientChecks } from "@/lib/send";
import { USDC, type ReserveAsset } from "@/lib/tokens/registry";

/**
 * Send's one write path: one useTx, one batch, built right before JAW's sheet. The cash is read again first
 * (useSigningCash): a cash send needs the amount and the network fee, a stock send the fee; when the wallet can't be
 * counted on for them, a savings withdrawal goes first (buildSendCalls → payFromCash). The recipient is the one on
 * screen, never looked up again: what the user saw is what is sent. useTx simulates the whole batch from the user.
 */
export function useSend() {
  const tx = useTx(SEND_COPY.failedOnChain);
  const cashToSign = useSigningCash();
  const send = (p: { user: Address; token: ReserveAsset; recipient: Recipient; amountRaw: bigint }) => {
    const isCash = isAddressEqual(p.token.address, USDC.address);
    return tx.run(
      p.user,
      async () => {
        const cash = await cashToSign(p.user, isCash ? p.amountRaw : 0n);
        try {
          return buildSendCalls({ user: p.user, token: p.token, to: p.recipient.address, amountRaw: p.amountRaw, cash });
        } catch (e) {
          throw e instanceof SendStop ? new TxStop(e.message) : e;
        }
      },
      SEND_COPY.fallback,
      sendActivity(p.token, p.amountRaw, p.recipient),
    );
  };
  return { ...tx, send };
}

/** Where To stands: nothing yet, looking a name up, who it is, or why there's no one. */
export type ToState =
  | { kind: "idle" }
  | { kind: "looking"; name: string }
  | { kind: "found"; recipient: Recipient }
  | { kind: "none"; text: string };

/**
 * Send's To: what was typed, looked up (a name through ENS's offchain lookup, as the Leaderboard's add by name does),
 * or picked from the quick picks, and what Base says about the address it gives (readRecipient). An address typed in
 * shows its own name when it has one. A lookup that a later one replaced is dropped.
 */
export function useRecipient() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const [state, setState] = useState<ToState>({ kind: "idle" });
  const seq = useRef(0);
  const found = state.kind === "found" ? state.recipient : null;

  const find = async (text: string) => {
    const id = ++seq.current;
    const parsed = parseTo(text);
    if (parsed.kind === "empty") return setState({ kind: "idle" });
    if (parsed.kind === "invalid") return setState({ kind: "none", text: parsed.text });
    if (parsed.kind === "address") return setState({ kind: "found", recipient: { address: parsed.address, name: null, onBase: true } });
    setState({ kind: "looking", name: parsed.name });
    try {
      const r = await addressOfName(parsed.name);
      if (id !== seq.current) return;
      setState(r ? { kind: "found", recipient: { address: r.address, name: r.name ?? parsed.name, onBase: r.onBase } } : { kind: "none", text: SEND_COPY.noName(parsed.name) });
    } catch {
      if (id === seq.current) setState({ kind: "none", text: SEND_COPY.lookupFailed });
    }
  };
  const pick = (address: Address, name: string | null) => {
    seq.current += 1;
    setState({ kind: "found", recipient: { address, name, onBase: true } });
  };
  const clear = () => {
    seq.current += 1;
    setState({ kind: "idle" });
  };

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
  // An address typed in or picked without a name: its own name, when it has one (read as the header reads it) and that
  // name points back to it. A reverse record alone proves nothing (anyone can set theirs to any name), and a pasted
  // address shown under someone's name is what address poisoning wants.
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
  return { state, recipient, checks, find, pick, clear };
}
