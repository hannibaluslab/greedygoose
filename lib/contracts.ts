import { isAddressEqual, zeroAddress, type Address } from "viem";
import { entryPoint06Address, entryPoint07Address, entryPoint08Address } from "viem/account-abstraction";
import { AAVE } from "@/lib/aave/addresses";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { GOOSE_BOARD } from "@/lib/board/config";
import { JAW_PAYMASTER } from "@/lib/board/logs";
import { AAVE_V3_USDC_DEBT } from "@/lib/board/tokens";
import { CHAIN } from "@/lib/chain";
import { EFP_ACCOUNT_METADATA, EFP_LIST_MINTER, EFP_LIST_RECORDS, EFP_LIST_REGISTRY } from "@/lib/efp/efp";
import { GUARDIAN } from "@/lib/guardian/config";
import { AERODROME, AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

/**
 * Where JAW's paymaster sends the USDC network fees it takes, measured on JAW receipts 2026-10-15 (tx 0xfb269d33… and
 * 0x21377f51…; tests/unit/decode.test.ts records it). Not anyone's account in the app.
 */
const JAW_FEE_TREASURY: Address = "0x4337Ff05c84B9A80Ea0a78dBE7B8E102F66d4c08";

/**
 * Every contract the app or the protocols under it use on Base, from the typed registries only: the tokens (USDC, the
 * seven stocks, savings and its debt token, the other dollars), Aave V4's hub, spoke and oracle, Aave V3's pool, the
 * swap venues' factories, quoters and routers, JAW's permission manager, paymaster and fee treasury, the ERC-4337 entry points, EFP,
 * Multicall3, and GooseExecutor and GooseBoard once they're set. None of them is someone's account: money sent to one
 * is stuck there or taken by whoever can sweep it, so Send refuses them (lib/send.ts) and the allowlist never lets a
 * transfer reach one (lib/allowlist.ts).
 */
export const APP_CONTRACTS: readonly Address[] = [
  USDC.address,
  ...EQUITIES.map((e) => e.address),
  ...ENTRY_COINS.map((c) => c.address),
  GUARDIAN.AUSDC,
  AAVE_V3_USDC_DEBT,
  AAVE.HUB,
  AAVE.SPOKE,
  AAVE.SPOKE_ORACLE,
  GUARDIAN.AAVE_V3_POOL,
  GUARDIAN.PERMISSION_MANAGER,
  AERODROME.FACTORY,
  AERODROME.QUOTER,
  AERODROME.ROUTER,
  AERODROME_V1.FACTORY,
  AERODROME_V1.QUOTER,
  AERODROME_V1.ROUTER,
  SPARK_PSM3.PSM3,
  UNISWAP.FACTORY,
  UNISWAP.QUOTER_V2,
  UNISWAP.SWAP_ROUTER_02,
  JAW_PAYMASTER,
  JAW_FEE_TREASURY,
  entryPoint06Address,
  entryPoint07Address,
  entryPoint08Address,
  EFP_ACCOUNT_METADATA,
  EFP_LIST_REGISTRY,
  EFP_LIST_RECORDS,
  EFP_LIST_MINTER,
  CHAIN.contracts.multicall3.address,
  ...(GOOSE_EXECUTOR ? [GOOSE_EXECUTOR] : []),
  ...(GOOSE_BOARD ? [GOOSE_BOARD] : []),
];

/** Whether `address` is one of the app's or its protocols' own contracts (APP_CONTRACTS). */
export const isAppContract = (address: Address) => APP_CONTRACTS.some((c) => isAddressEqual(c, address));

/** Why money can't be sent to `to` from `user`, as a reason the screen words; null when it can. */
export type RecipientBlock = "self" | "zero" | "contract";

export function recipientBlock(to: Address, user: Address): RecipientBlock | null {
  if (isAddressEqual(to, zeroAddress)) return "zero";
  if (isAddressEqual(to, user)) return "self";
  if (isAppContract(to)) return "contract";
  return null;
}
