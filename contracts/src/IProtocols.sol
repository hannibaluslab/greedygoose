// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJustaPermissionManager} from "./IJustaPermissionManager.sol";

/// The parts of USDC, Aave, Aerodrome and JAW's account that GooseExecutor uses. Signatures from the verified
/// sources: Aave V3 Pool, the Aave V4 spoke and its oracle (lib/aave/abis, generated with `forge inspect` at aave-v4
/// 326751e), Aerodrome Slipstream's router (lib/swap/abis.ts, selector 0xa026383e in the deployed bytecode) and
/// JustanAccount (JAW's Sourcify bundle).

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

    struct Reserve {
        address underlying;
        address hub;
        uint16 assetId;
        uint8 decimals;
        uint24 collateralRisk;
        uint8 flags; // ReserveFlagsMap: bit 0 paused, bit 1 frozen
        uint32 dynamicConfigKey; // the config a withdrawal applies to the whole position
    }

    struct DynamicReserveConfig {
        uint16 collateralFactor; // BPS
        uint32 maxLiquidationBonus;
        uint16 liquidationFee;
    }

    function getUserAccountData(address user) external view returns (UserAccountData memory);
    function getUserTotalDebt(uint256 reserveId, address user) external view returns (uint256);
    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);
    function getUserReserveStatus(uint256 reserveId, address user) external view returns (bool collateral, bool debt);
    function getReserve(uint256 reserveId) external view returns (Reserve memory);
    function getDynamicReserveConfig(uint256 reserveId, uint32 dynamicConfigKey)
        external
        view
        returns (DynamicReserveConfig memory);
    function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    /// Sends the stock to the caller, here the account itself, and checks its health is still at least 1.
    function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
}

/// The spoke's price oracle (ISpoke.ORACLE()): 8 decimals, the only price GreedyGoose uses for limits.
interface IAaveOracle {
    function getReservePrice(uint256 reserveId) external view returns (uint256);
}

/// Aerodrome Slipstream's swap router (lib/swap/venues.ts AERODROME.ROUTER).
interface IAeroRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// JustanAccount, the contract behind every JAW account.
interface IJustanAccount {
    function isOwnerAddress(address account) external view returns (bool);
    function executeBatch(IJustaPermissionManager.Call[] calldata calls) external;
}
