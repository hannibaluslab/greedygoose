import { CHAIN_ID } from "@/lib/chain";

/**
 * Aave V4 Equities Hub on Base.
 * Source: aave-dao/aave-address-book PR #1569; verified on-chain 2026-10-12
 * (code present, spoke.ORACLE() == SPOKE_ORACLE, reserves 0–7 listed on HUB).
 * `tests/onchain/verify-registry.test.ts` (`npm run verify:registry`) re-checks all of this.
 */
export const AAVE = {
  chainId: CHAIN_ID,
  HUB: "0xa4d5947Eb727A052bae69C593FfC84247EC9864E",
  SPOKE: "0x17905Db0e4A3514467539956c084180616AE7B8D",
  SPOKE_ORACLE: "0xaBaf048fD7675Ea34a84332371ffd5D55E322A47",
} as const satisfies Record<string, `0x${string}` | number>;

/** 1 USD in the spoke's "Value" units (Spoke.sol). */
export const VALUE_PER_USD = 10n ** 26n;
export const WAD = 10n ** 18n;
export const RAY = 10n ** 27n;
/** Spoke oracle price decimals (IPriceOracle.decimals()). */
export const ORACLE_DECIMALS = 8;
