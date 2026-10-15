import { createPublicClient, http, isAddress, toCoinType, type Address } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import type { JustaName } from "@justaname.id/sdk";
import { CHAIN_ID } from "@/lib/chain";

/** ENS lives on Ethereum mainnet. Empty uses viem's public mainnet RPC, as the Base transport does for Base. */
const MAINNET_RPC = process.env.NEXT_PUBLIC_MAINNET_RPC_URL || mainnet.rpcUrls.default.http[0];

let names: JustaName["subnames"] | undefined;

/**
 * The account's name ("sam.justan.id"), or null when it has none. JustaName's `reverseResolve`, the SDK JAW's own
 * screens use: the account's ENS reverse record for Base, then the primary name JAW gave it at sign-up (JAW's
 * subnames have no reverse record on chain). Loaded on first use, so the SDK stays out of the first page load.
 * Read-only: no API key.
 */
export async function accountName(address: `0x${string}`): Promise<string | null> {
  if (!names) {
    const { JustaName } = await import("@justaname.id/sdk");
    names = JustaName.init({ networks: [{ chainId: 1, providerUrl: MAINNET_RPC }] }).subnames;
  }
  return names.reverseResolve({ address, chainId: CHAIN_ID });
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

/**
 * The account a name points to, for adding a contact by name: its Base address first (ENSIP-11), then its Ethereum
 * one (a JAW account has the same address on every chain). JAW's names resolve through ENS's offchain lookup, which
 * viem follows. Null when the name points nowhere. An address typed in is returned as it is.
 */
export async function addressOfName(input: string): Promise<{ name: string | null; address: Address } | null> {
  if (isAddress(input.trim())) return { name: null, address: input.trim() as Address };
  const name = fullName(input);
  if (!name) return null;
  ens ??= createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) });
  const onBase = await ens.getEnsAddress({ name, coinType: toCoinType(CHAIN_ID) }).catch(() => null);
  const address = onBase ?? (await ens.getEnsAddress({ name }));
  return address ? { name, address } : null;
}
