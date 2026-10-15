import { createPublicClient, http, isAddress, toCoinType, type Address } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import type { JustaName } from "@justaname.id/sdk";
import { CHAIN_ID } from "@/lib/chain";

/** ENS lives on Ethereum mainnet. Empty uses viem's public mainnet RPC, as the Base transport does for Base. */
const MAINNET_RPC = process.env.NEXT_PUBLIC_MAINNET_RPC_URL || mainnet.rpcUrls.default.http[0];

let names: JustaName["subnames"] | undefined;

/** Name lookups in flight at once: a screen of names (the leaderboard's page) queues instead of firing together. */
const NAME_LOOKUPS = 6;
let lookups = 0;
const waiting: (() => void)[] = [];
async function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  if (lookups >= NAME_LOOKUPS) await new Promise<void>((go) => waiting.push(go));
  lookups += 1;
  try {
    return await job();
  } finally {
    lookups -= 1;
    waiting.shift()?.();
  }
}

/**
 * The account's name ("sam.justan.id"), or null when it has none. JustaName's `reverseResolve`, the SDK JAW's own
 * screens use: the account's ENS reverse record for Base, then the primary name JAW gave it at sign-up (JAW's
 * subnames have no reverse record on chain). Loaded on first use, so the SDK stays out of the first page load.
 * Read-only: no API key. At most six at once.
 */
export async function accountName(address: `0x${string}`): Promise<string | null> {
  return oneAtATime(async () => {
    if (!names) {
      const { JustaName } = await import("@justaname.id/sdk");
      names = JustaName.init({ networks: [{ chainId: 1, providerUrl: MAINNET_RPC }] }).subnames;
    }
    return names.reverseResolve({ address, chainId: CHAIN_ID });
  });
}

/** "sam.justan.id" → "Sam", for "Hi, Sam". */
export function firstName(name: string): string {
  const label = name.split(".")[0];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

let ens: ReturnType<typeof createPublicClient> | undefined;

/** The app's name parent (D6), as lib/jaw/config.ts reads it; read here so names don't load the wallet config. */
const NAME_PARENT = process.env.NEXT_PUBLIC_ENS_PARENT ?? "justan.id";

/**
 * "sam" → "sam.justan.id" (the app's name parent, D6); a name with a dot is taken as typed. Lowercased and trimmed;
 * null when it isn't a name ENS can normalize.
 */
export function fullName(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/^@/, "");
  if (!raw) return null;
  try {
    return normalize(raw.includes(".") ? raw : `${raw}.${NAME_PARENT}`);
  } catch {
    return null;
  }
}

/** Whether `address` has code on Ethereum: a contract wallet there may not be the same account on Base (Send asks). */
export async function hasEthereumCode(address: Address): Promise<boolean> {
  ens ??= createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) });
  const code = await ens.getCode({ address });
  return !!code && code !== "0x";
}

/**
 * The account a name points to, for adding a contact by name: its Base address first (ENSIP-11), then its Ethereum
 * one. JAW's names resolve through ENS's offchain lookup, which viem follows; some give a Base address and some only an
 * Ethereum one (measured 2026-10-15). A name under the app's parent is a JAW account, which has the same address on
 * every chain, so its Ethereum address is its Base one. For any other name an Ethereum address may be a different
 * account on Base (a contract wallet), so `onBase` is false and the screen says so. Null when the name points
 * nowhere. An address typed in is returned as it is.
 *
 * Only a Base lookup that says "no Base address" falls back to the Ethereum one. viem already answers null for that
 * (no resolver, no record, a gateway that has none: cb.id's answers an HTTP error, measured 2026-10-15), so anything it
 * throws is a real failure (the RPC or the network) and is thrown on: falling back then could pay an Ethereum address
 * that is someone else's account on Base. Send shows "We couldn't look that up"; the Leaderboard, no one found.
 */
export async function addressOfName(input: string): Promise<{ name: string | null; address: Address; onBase: boolean } | null> {
  if (isAddress(input.trim())) return { name: null, address: input.trim() as Address, onBase: true };
  const name = fullName(input);
  if (!name) return null;
  ens ??= createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) });
  const base = await ens.getEnsAddress({ name, coinType: toCoinType(CHAIN_ID) });
  if (base) return { name, address: base, onBase: true };
  const eth = await ens.getEnsAddress({ name });
  return eth ? { name, address: eth, onBase: name.endsWith(`.${NAME_PARENT}`) } : null;
}
