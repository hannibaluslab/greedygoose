import { CHAIN_ID } from "@/lib/chain";
import { AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";

/** Where the Entry agent swaps a coin for USDC: the deepest venue for it on Base, measured 2026-10-14. */
export type EntryVenue =
  | { kind: "aerodrome"; router: `0x${string}`; tickSpacing: number }
  | { kind: "uniswap"; router: `0x${string}`; fee: number }
  | { kind: "psm3"; psm: `0x${string}` };

export type EntryCoinAsset = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  chainId: number;
  venue: EntryVenue;
};

const aerodrome: EntryVenue = {
  kind: "aerodrome",
  router: AERODROME_V1.ROUTER,
  tickSpacing: AERODROME_V1.STABLE_TICK_SPACING,
};
/** Uniswap v3 at 0.05%: $724k of USDC against USDe, 99.95% from $1k to $100k. Aerodrome's USDe pools hold under $20. */
const uniswap: EntryVenue = { kind: "uniswap", router: UNISWAP.SWAP_ROUTER_02, fee: 500 };
const psm3: EntryVenue = { kind: "psm3", psm: SPARK_PSM3.PSM3 };

/**
 * The dollar stablecoins the Entry agent turns into USDC on Base, in GooseExecutor's order (EntryJob): the index is the
 * coin's place in the Entry permission. Each address was checked on-chain 2026-10-14 against its issuer's record:
 * - USDT and USDbC are the Base bridge's own (Superchain token list; `l1Token()` / `REMOTE_TOKEN()` return Ethereum's
 *   USDT and USDC);
 * - USDe is Ethena's (docs.ethena.fi key addresses: the address on most L2s, a LayerZero OFT);
 * - USDS is Sky's (spark-address-registry Base.sol, and PSM3's `usds()`).
 * GHO is not here: Base has no GHO/USDC liquidity to speak of ($100 of GHO quotes $0.15, 2026-10-14).
 */
export const ENTRY_COINS = [
  {
    symbol: "USDT",
    name: "Tether USD",
    address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    decimals: 6,
    venue: aerodrome,
  },
  { symbol: "USDe", name: "USDe", address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", decimals: 18, venue: uniswap },
  {
    symbol: "USDbC",
    name: "USD Base Coin",
    address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    decimals: 6,
    venue: aerodrome,
  },
  {
    symbol: "USDS",
    name: "USDS Stablecoin",
    address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc",
    decimals: 18,
    venue: psm3,
  },
].map((c) => ({ ...c, address: c.address as `0x${string}`, chainId: CHAIN_ID })) satisfies EntryCoinAsset[];
