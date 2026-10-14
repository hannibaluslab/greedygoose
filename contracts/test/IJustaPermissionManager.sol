// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// Minimal interface copied from the verified JustaPermissionManager on Base
/// (0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8, Sourcify) — structs must match exactly.
interface IJustaPermissionManager {
    /// JustaPermissionManager.sol:206-213. There is no Year: JAW's SDK sends 'year' as Month × 12.
    enum PeriodUnit { Minute, Hour, Day, Week, Month, Forever }

    struct CallPermission { address target; bytes4 selector; address checker; }
    struct SpendLimit { address token; uint160 allowance; PeriodUnit unit; uint16 multiplier; }
    struct Permission {
        address account;
        address spender;
        uint48 start;
        uint48 end;
        uint256 salt;
        CallPermission[] calls;
        SpendLimit[] spends;
    }
    struct Call { address target; uint256 value; bytes data; }
    struct PeriodSpend { uint48 start; uint48 end; uint160 spend; }

    event PermissionApproved(bytes32 indexed permissionHash, Permission permission);

    function approve(Permission calldata permission) external returns (bool);
    function revoke(Permission calldata permission) external;
    function executeBatch(Permission calldata permission, Call[] calldata calls) external;
    function isApproved(Permission calldata permission) external view returns (bool);
    function getCurrentPeriod(Permission calldata permission, SpendLimit calldata spendLimit)
        external
        view
        returns (PeriodSpend memory);
    function getHash(Permission calldata permission) external view returns (bytes32);
}

/// JAW's account factory (the SDK's FACTORY_ADDRESS). Owners are ABI-encoded addresses or 64-byte passkeys.
interface IJawFactory {
    function createAccount(bytes[] calldata owners, uint256 nonce) external payable returns (address);
}

/// JustanAccount, the contract behind every JAW account.
interface IJustanAccount {
    function executeBatch(IJustaPermissionManager.Call[] calldata calls) external;
}

interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface ISpokeLite {
    function supply(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf) external;
    function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function getUserTotalDebt(uint256 reserveId, address user) external view returns (uint256);
}

interface IERC20Lite {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
