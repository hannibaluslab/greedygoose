import { CHAIN_ID } from "@/lib/chain";

/**
 * DEX venues for USDC → stock buys on Base. All addresses verified on-chain 2026-10-12
 * (code present; quoter/router factory() match; live quotes and an approve+swap simulation succeed).
 *
 * Aerodrome Slipstream holds the depth (~$0.5–1.4M USDC per stock pool, tick spacing 10).
 * Uniswap v3 pools are thin (~$1.5–57k) and are kept only as a fallback.
 */
export const AERODROME = {
  chainId: CHAIN_ID,
  FACTORY: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  QUOTER: "0x514c8B5f54112481E28028F1166Bd78501089259",
  ROUTER: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
  /** Tick spacings to try; the stock/USDC pools use 10. */
  TICK_SPACINGS: [1, 10, 50, 100] as const,
} as const;

export const UNISWAP = {
  chainId: CHAIN_ID,
  FACTORY: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  QUOTER_V2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  SWAP_ROUTER_02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  /** Fee tiers in hundredths of a bip (3000 = 0.3%). */
  FEE_TIERS: [100, 500, 3000, 10000] as const,
} as const;

export type Venue = "aerodrome" | "uniswap";
export const VENUE_LABEL: Record<Venue, string> = { aerodrome: "Aerodrome", uniswap: "Uniswap" };
export const ROUTERS = [AERODROME.ROUTER, UNISWAP.SWAP_ROUTER_02] as const;
