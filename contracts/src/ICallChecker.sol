// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Call checker interface used by JAW's JustaPermissionManager
///         (Base 0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8, src/interfaces/ICallChecker.sol).
interface ICallChecker {
    function canExecute(
        bytes32 permissionHash,
        address account,
        address spender,
        address target,
        uint256 value,
        bytes calldata data
    ) external view returns (bool);
}
