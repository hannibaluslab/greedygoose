import { CHAIN_ID } from "@/lib/chain";
import { AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";

/** Where a coin is swapped for USDC: the deepest venue for it on Base, measured 2026-10-14 (DAI, EURC: 2026-10-19). */
export type EntryVenue =
  | { kind: "aerodrome"; router: `0x${string}`; tickSpacing: number }
  | { kind: "uniswap"; router: `0x${string}`; fee: number }
  | { kind: "psm3"; psm: `0x${string}` };

/**
 * A coin that isn't a dollar: Chainlink's feed of its price in dollars (`decimals` places), the oldest reading that may
 * set its floor (`maxAgeSec`), and what the words call the rate ("euro").
 */
type UsdPeg = { feed: `0x${string}`; decimals: number; maxAgeSec: number; name: string };

export type EntryCoinAsset = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  chainId: number;
  venue: EntryVenue;
  /** Only on a coin that isn't a dollar; a dollar coin is worth its face value. */
  peg?: UsdPeg;
};

const aerodrome: EntryVenue = {
  kind: "aerodrome",
  router: AERODROME_V1.ROUTER,
  tickSpacing: AERODROME_V1.STABLE_TICK_SPACING,
};
/** Uniswap v3 at 0.05%: $724k of USDC against USDe, 99.95% from $1k to $100k. Aerodrome's USDe pools hold under $20. */
const uniswap: EntryVenue = { kind: "uniswap", router: UNISWAP.SWAP_ROUTER_02, fee: 500 };
const psm3: EntryVenue = { kind: "psm3", psm: SPARK_PSM3.PSM3 };

const coin = (c: Omit<EntryCoinAsset, "chainId">): EntryCoinAsset => ({ ...c, chainId: CHAIN_ID });

/*
 * Each address was checked on-chain against its issuer's record:
 * - USDT and USDbC are the Base bridge's own (Superchain token list; `l1Token()` / `REMOTE_TOKEN()` return Ethereum's
 *   USDT and USDC);
 * - USDe is Ethena's (docs.ethena.fi key addresses: the address on most L2s, a LayerZero OFT);
 * - USDS is Sky's (spark-address-registry Base.sol, and PSM3's `usds()`);
 * - DAI is the Superchain token list's, EURC is Circle's (developers.circle.com, EURC on Base).
 * GHO is not here: Base has no GHO/USDC liquidity to speak of ($100 of GHO quotes $0.15, 2026-10-14).
 */
const USDT = coin({
  symbol: "USDT",
  name: "Tether USD",
  address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  decimals: 6,
  venue: aerodrome,
});
const USDE = coin({
  symbol: "USDe",
  name: "USDe",
  address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
  decimals: 18,
  venue: uniswap,
});
const USDBC = coin({
  symbol: "USDbC",
  name: "USD Base Coin",
  address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  decimals: 6,
  venue: aerodrome,
});
const USDS = coin({
  symbol: "USDS",
  name: "USDS Stablecoin",
  address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc",
  decimals: 18,
  venue: psm3,
});
/** Uniswap v3 at 0.01%: 100.00% at $1k, 99.98% at $10k (2026-10-19). Its 0.05% and 0.3% pools are thin. */
const DAI = coin({
  symbol: "DAI",
  name: "Dai Stablecoin",
  address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  decimals: 18,
  venue: { kind: "uniswap", router: UNISWAP.SWAP_ROUTER_02, fee: 100 },
});
/**
 * Aerodrome's first Slipstream at tick spacing 1: 100.04% of the euro rate (2026-10-19). The rate is Chainlink's
 * "EUR / USD" on Base, 8 decimals, a 1-hour heartbeat and 0.1% deviation; up to two hours old may set the floor.
 */
const EURC = coin({
  symbol: "EURC",
  name: "EURC",
  address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
  decimals: 6,
  venue: aerodrome,
  peg: { feed: "0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F", decimals: 8, maxAgeSec: 7_200, name: "euro" },
});

/**
 * The coins the old GooseExecutor's Entry agent turned into USDC (contracts/src/jobs/EntryJob.sol). Kept for its
 * rules' test vectors and so a Send never pays USDbC's contract; GooseGuard converts CASH_COINS instead.
 */
export const ENTRY_COINS: readonly EntryCoinAsset[] = [USDT, USDE, USDBC, USDS];

/**
 * The coins the user's own Turn into cash takes, and the ones the Entry agent converts on its own, in GooseGuard's
 * order (its CONVERT `k`, decision 10): USDbC is left out (a $5.5M supply trading $0.2M a day), DAI and EURC are in.
 * The allowlist approves and converts these only, and the Entry grant lists one approve and one spend per coin.
 */
export const CASH_COINS: readonly EntryCoinAsset[] = [USDT, USDE, USDS, DAI, EURC];

/** Every coin of either list, once: what reading history or refusing a Send to a coin's contract needs to know. */
export const OTHER_COINS: readonly EntryCoinAsset[] = [...new Set([...ENTRY_COINS, ...CASH_COINS])];
