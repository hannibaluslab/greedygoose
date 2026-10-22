import { CHAIN_ID } from "@/lib/chain";

/** JAW's permission manager and Aave V3 (savings) on Base. Addresses verified on-chain 2026-10-13. */
export const PROTOCOLS = {
  chainId: CHAIN_ID,
  /** JAW JustaPermissionManager (verified source on Sourcify). */
  PERMISSION_MANAGER: "0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8",
  /** Aave V3 Pool on Base — where the savings buffer lives. */
  AAVE_V3_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  /** aBasUSDC — the savings balance token (getReserveData(USDC).aTokenAddress). */
  AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
} as const;

/** Selectors the agent permissions whitelist. */
export const SEL = {
  withdraw: "0x69328dec", // Pool.withdraw(address,uint256,address)
  approve: "0x095ea7b3", // ERC20.approve(address,uint256)
  repay: "0xb1e8f8ef", // Spoke.repay(uint256,uint256,address)
  supply: "0x617ba037", // Pool.supply(address,uint256,address,uint16)
  spokeWithdraw: "0x0ad58d2f", // Spoke.withdraw(uint256,uint256,address)
  aeroSwap: "0xa026383e", // Aerodrome Slipstream router exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))
  uniSwap: "0x04e45aaf", // Uniswap SwapRouter02 exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  psmSwap: "0x1a019e37", // Spark PSM3 swapExactIn(address,address,uint256,uint256,address,uint256)
  spokeRefresh: "0x826002e2", // Spoke.updateUserDynamicConfig(address)
} as const;
