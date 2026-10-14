import { CHAIN_ID } from "@/lib/chain";

export type ReserveAsset = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  chainId: number;
  /** Aave V4 spoke reserve id; also the hub asset id on the Equities Hub. */
  reserveId: number;
  kind: "equity" | "debt";
  enabled: boolean;
};

/**
 * Verified on-chain 2026-10-12 against spoke.getReserve(i).underlying, symbol(), decimals().
 * Never resolve an asset by symbol alone — use chainId + address.
 * `coingeckoId`: the CoinGecko coin whose Base contract is this address (checked on /coins/<id> 2026-10-14), for
 * the market-price fallback only.
 */
export const EQUITIES = [
  { symbol: "AAPLc", name: "Apple", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", reserveId: 0, coingeckoId: "apple-coinbase-tokenized-stock" },
  { symbol: "AMZNc", name: "Amazon", address: "0xb200000000000000000000d9192b6B456483C2E8", reserveId: 1, coingeckoId: "amazon-coinbase-tokenized-stock" },
  { symbol: "GOOGLc", name: "Alphabet", address: "0xb2000000000000000000002D0BA3164cc74f58B7", reserveId: 2, coingeckoId: "alphabet-coinbase-tokenized-stock" },
  { symbol: "METAc", name: "Meta", address: "0xb2000000000000000000008bC8786B856E61707C", reserveId: 3, coingeckoId: "meta-coinbase-tokenized-stock" },
  { symbol: "MSFTc", name: "Microsoft", address: "0xB200000000000000000000Ab99cFa739E253872B", reserveId: 4, coingeckoId: "microsoft-coinbase-tokenized-stock" },
  { symbol: "NVDAc", name: "NVIDIA", address: "0xb20000000000000000000078ee7ce2fE4908108C", reserveId: 5, coingeckoId: "nvidia-coinbase-tokenized-stock" },
  { symbol: "TSLAc", name: "Tesla", address: "0xb2000000000000000000001e800a7f5189430cD0", reserveId: 6, coingeckoId: "tesla-coinbase-tokenized-stocks" },
].map((a) => ({ ...a, address: a.address as `0x${string}`, decimals: 8, chainId: CHAIN_ID, kind: "equity", enabled: true })) satisfies ReserveAsset[];

export const USDC: ReserveAsset = {
  symbol: "USDC",
  name: "USD Coin",
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
  chainId: CHAIN_ID,
  reserveId: 7,
  kind: "debt",
  enabled: true,
};

export const ALL_RESERVES: readonly ReserveAsset[] = [...EQUITIES, USDC];

export function findByAddress(address: string, chainId: number = CHAIN_ID): ReserveAsset | undefined {
  const a = address.toLowerCase();
  return ALL_RESERVES.find((r) => r.chainId === chainId && r.address.toLowerCase() === a);
}
