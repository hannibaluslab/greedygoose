import { CHAIN_ID } from "@/lib/chain";

/**
 * Guardian contracts on Base. Manager / Aave V3 addresses verified on-chain 2026-10-13.
 * The GuardianChecker is NOT deployed to mainnet yet (needs an independent audit first);
 * the app and keeper read its address from config and stay disabled until it is set.
 */
export const GUARDIAN = {
  chainId: CHAIN_ID,
  /** JAW JustaPermissionManager (verified source on Sourcify). */
  PERMISSION_MANAGER: "0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8",
  /** Aave V3 Pool on Base — where the savings buffer lives. */
  AAVE_V3_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  /** aBasUSDC — the savings balance token (getReserveData(USDC).aTokenAddress). */
  AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
} as const;

const addr = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : undefined);

/** Deployed GuardianChecker (contracts/src/GuardianChecker.sol). */
export const GUARDIAN_CHECKER = addr(process.env.NEXT_PUBLIC_GUARDIAN_CHECKER);
/** The keeper's spender address (its key lives only on the keeper server). */
export const GUARDIAN_KEEPER = addr(process.env.NEXT_PUBLIC_GUARDIAN_KEEPER);

export const guardianConfigured = () => !!GUARDIAN_CHECKER && !!GUARDIAN_KEEPER;

/** Fixed salt so a user's Guardian permission can be rebuilt deterministically for revoke / status. */
export const GUARDIAN_SALT = BigInt("0x" + "677561726469616e2e7631".padStart(64, "0")); // "guardian.v1"

/** Selectors the agent permissions whitelist. */
export const SEL = {
  withdraw: "0x69328dec", // Pool.withdraw(address,uint256,address)
  approve: "0x095ea7b3", // ERC20.approve(address,uint256)
  repay: "0xb1e8f8ef", // Spoke.repay(uint256,uint256,address)
  supply: "0x617ba037", // Pool.supply(address,uint256,address,uint16)
} as const;
