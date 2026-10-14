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
    /// Neither this nor isApproved checks time, and isApproved stays true after a revoke (`:815-821`).
    function isRevoked(Permission calldata permission) external view returns (bool);
    function getCurrentPeriod(Permission calldata permission, SpendLimit calldata spendLimit)
        external
        view
        returns (PeriodSpend memory);
    function getHash(Permission calldata permission) external view returns (bytes32);
}
