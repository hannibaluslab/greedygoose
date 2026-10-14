// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJustaPermissionManager} from "./IJustaPermissionManager.sol";

/// The parts of USDC, Aave and JAW's account that GooseExecutor uses. Signatures from the verified sources:
/// Aave V3 Pool, the Aave V4 spoke (lib/aave/abis/ISpoke.ts, generated with `forge inspect` at aave-v4 326751e)
/// and JustanAccount (JAW's Sourcify bundle).

interface IERC20 {
    function balanceOf(address who) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface ISpoke {
    struct UserAccountData {
        uint256 riskPremium;
        uint256 avgCollateralFactor; // WAD
        uint256 healthFactor; // WAD, max uint with no debt
        uint256 totalCollateralValue; // Value units (1e26 = $1)
        uint256 totalDebtValueRay; // Value units × RAY
        uint256 activeCollateralCount;
        uint256 borrowCount;
    }

    function getUserAccountData(address user) external view returns (UserAccountData memory);
    function getUserTotalDebt(uint256 reserveId, address user) external view returns (uint256);
    function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
}

/// JustanAccount, the contract behind every JAW account.
interface IJustanAccount {
    function isOwnerAddress(address account) external view returns (bool);
    function executeBatch(IJustaPermissionManager.Call[] calldata calls) external;
}
