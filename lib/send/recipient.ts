import { getAddress, isAddress, isAddressEqual, type Address } from "viem";
import type { LocalActivity } from "@/lib/activity/local";
import { fullName } from "@/lib/jaw/name";
import { SEND_COPY } from "./copy";

// ─── To ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What was typed in To: nothing, an address (checksum-valid or all lowercase), a name to look up, or why it's neither. */
type ToInput =
  | { kind: "empty" }
  | { kind: "address"; address: Address }
  | { kind: "name"; name: string }
  | { kind: "invalid"; text: string };

/**
 * Reads what was typed in To. Anything starting with 0x and without a dot is an address: 0x and 40 hex characters,
 * all lowercase, all capitals (EIP-55's two forms without a checksum; QR codes often use capitals) or in its
 * checksum's exact capitals (viem's strict `isAddress`); mixed capitals that don't match the checksum have a typo.
 * Anything else is a name, 0xfoo.eth included: "sam" means sam.justan.id (the app's name parent), a dotted one is
 * taken as typed (ENS's normalization).
 */
export function parseTo(text: string): ToInput {
  const t = text.trim();
  if (!t) return { kind: "empty" };
  if (/^0x/i.test(t) && !t.includes(".")) {
    if (!/^0x[0-9a-f]{40}$/i.test(t)) return { kind: "invalid", text: SEND_COPY.shape };
    const hex = t.slice(2);
    const noChecksum = hex === hex.toLowerCase() || hex === hex.toUpperCase();
    if (!noChecksum && !isAddress(`0x${hex}`, { strict: true })) return { kind: "invalid", text: SEND_COPY.typo };
    return { kind: "address", address: getAddress(`0x${hex.toLowerCase()}`) };
  }
  const name = fullName(t);
  return name ? { kind: "name", name } : { kind: "invalid", text: SEND_COPY.badName };
}

/** Who Send pays: the address, the name it came from (or the address's own name), and whether that's its Base address. */
export type Recipient = { address: Address; name: string | null; onBase: boolean };

/** What Base says about the recipient (readRecipient). */
export type BaseCheck = { code: boolean; used: boolean; notAccount: boolean };

/**
 * What Base says about the recipient (readRecipient): whether it has code, whether it was ever used (code, a sent
 * transaction, ETH or USDC), and whether it's a token or a trading pool rather than an account. `ethCode`: for a name
 * that only gives an Ethereum address, whether that address has code on Ethereum (a contract wallet there may not be the
 * same account on Base). Undefined while reading, null if the read failed.
 */
export type RecipientChecks = {
  base?: BaseCheck | null;
  ethCode?: boolean | null;
};

/** Where To stands: nothing yet, looking a name up, who it is, or why there's no one. */
export type ToState =
  | { kind: "idle" }
  | { kind: "looking"; name: string }
  | { kind: "found"; recipient: Recipient }
  | { kind: "none"; text: string };

/** Looks a name up (lib/jaw/name.ts addressOfName): its address, the name it gives back, and whether that's its Base address. */
type NameLookup = (name: string) => Promise<{ name: string | null; address: Address; onBase: boolean } | null>;

/**
 * To's lookups, in order (useRecipient holds one). Each find, pick, edit or clear replaces whatever came before it: a
 * lookup that answers after the user moved on (typed something else, cleared the field, pasted an address, picked
 * someone) is dropped, so it never becomes the recipient. A pasted address is taken at once; a name is looked up. A
 * pick has no name of its own: the address's name is checked again where it's shown (it could point elsewhere now).
 */
export function toLookups(set: (s: ToState) => void, lookup: NameLookup) {
  let seq = 0;
  let now: ToState = { kind: "idle" };
  const put = (s: ToState) => {
    now = s;
    set(s);
  };
  return {
    async find(text: string) {
      const id = ++seq;
      const parsed = parseTo(text);
      if (parsed.kind === "empty") return put({ kind: "idle" });
      if (parsed.kind === "invalid") return put({ kind: "none", text: parsed.text });
      if (parsed.kind === "address")
        return put({ kind: "found", recipient: { address: parsed.address, name: null, onBase: true } });
      put({ kind: "looking", name: parsed.name });
      try {
        const r = await lookup(parsed.name);
        if (id !== seq) return;
        put(
          r
            ? { kind: "found", recipient: { address: r.address, name: r.name ?? parsed.name, onBase: r.onBase } }
            : { kind: "none", text: SEND_COPY.noName(parsed.name) },
        );
      } catch {
        if (id === seq) put({ kind: "none", text: SEND_COPY.lookupFailed });
      }
    },
    pick(address: Address) {
      seq += 1;
      put({ kind: "found", recipient: { address, name: null, onBase: true } });
    },
    /** The field changed: a lookup in flight is dropped, and what the last one said (looking, or why there was no one) goes. */
    edit() {
      seq += 1;
      if (now.kind === "looking" || now.kind === "none") put({ kind: "idle" });
    },
    clear() {
      seq += 1;
      put({ kind: "idle" });
    },
  };
}

/** The people sent to from this device, newest first, once each, for the quick picks: from Activity's own records. */
export function recentRecipients(
  local: readonly LocalActivity[],
  limit = 4,
): { address: Address; name: string | null }[] {
  const out: { address: Address; name: string | null }[] = [];
  for (const entry of [...local].sort((a, b) => b.time - a.time)) {
    if (entry.status === "failed") continue;
    for (const item of entry.items) {
      if (item.kind !== "send" || !item.to || !isAddress(item.to, { strict: false })) continue;
      if (out.some((o) => isAddressEqual(o.address, item.to!))) continue;
      out.push({ address: getAddress(item.to), name: item.toName ?? null });
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}
