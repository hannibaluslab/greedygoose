import { isAddressEqual, type Address } from "viem";
import { GUARDIAN } from "@/lib/guardian/config";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import type { TokenInfo } from "./flows";

/** Aave V4's USDC reserve on the Equities Hub (lib/tokens/registry.ts): credit is drawn from it. */
export const USDC_RESERVE_ID = USDC.reserveId;

/**
 * The tokens a member's net worth is made of, and whose transfers are money in or out: USDC, savings (aUSDC, 6
 * decimals like USDC), the other dollar coins the app turns into cash (USDT, USDe, USDbC, USDS, at face value) and the
 * seven stocks (at Aave's price).
 */
export const BOARD_TOKENS: readonly { address: Address; info: TokenInfo }[] = [
  { address: USDC.address, info: { kind: "usd", decimals: USDC.decimals } },
  { address: GUARDIAN.AUSDC, info: { kind: "usd", decimals: USDC.decimals } },
  ...ENTRY_COINS.map((c) => ({ address: c.address, info: { kind: "usd", decimals: c.decimals } as TokenInfo })),
  ...EQUITIES.map((e) => ({ address: e.address, info: { kind: "stock", reserveId: e.reserveId } as TokenInfo })),
];

export const tokenInfo = (address: Address): TokenInfo | undefined =>
  BOARD_TOKENS.find((t) => isAddressEqual(t.address, address))?.info;

/**
 * Aave V3's variable debt token for USDC on Base ("variableDebtBasUSDC", 6 decimals, underlying USDC): the pool's
 * `getReserveData(USDC).variableDebtTokenAddress`, read 2026-10-15. Its balance is the USDC credit an account owes on
 * Aave V3, which a JAW account can draw against its savings in another app (tests/onchain/board.test.ts re-checks it).
 */
export const AAVE_V3_USDC_DEBT: Address = "0x59dca05b6c26dbd64b5381374aAaC5CD05644C28";
