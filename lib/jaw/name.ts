import { mainnet } from "viem/chains";
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
