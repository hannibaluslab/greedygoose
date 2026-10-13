// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// Minimal interface copied from the verified JustaPermissionManager on Base
/// (0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8, Sourcify) — structs must match exactly.
interface IJustaPermissionManager {
    enum PeriodUnit { Minute, Hour, Day, Week, Month, Year, Forever }

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

    function approve(Permission calldata permission) external returns (bool);
    function revoke(Permission calldata permission) external;
    function executeBatch(Permission calldata permission, Call[] calldata calls) external;
    function isApproved(Permission calldata permission) external view returns (bool);
    function getHash(Permission calldata permission) external view returns (bytes32);
}

interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface ISpokeLite {
    function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function getUserTotalDebt(uint256 reserveId, address user) external view returns (uint256);
}

interface IERC20Lite {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
