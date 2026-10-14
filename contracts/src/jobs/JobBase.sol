// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IJustanAccount} from "../IProtocols.sol";

/// @title JobBase
/// @notice What the executor and every job share: a permission's status and what is left of its daily limits.
library JobBase {
    /// Most gas the manager's batch may use for one Cash move (one Protect batch measured at about 404k).
    uint256 internal constant ACCOUNT_GAS = 1_000_000;
    /// aUSDC moves can be off by a unit or two from the amount (Aave's ray rounding).
    uint256 internal constant SAVINGS_ROUNDING = 2;

    /// The permission's on-chain status, past its approval (checked at registration, and never undone).
    function alive(PM manager, PM.Permission memory p) internal view returns (bool, GooseExecutor.OffReason) {
        if (!managerOwns(manager, p.account)) return (false, GooseExecutor.OffReason.NotOwner);
        if (manager.isRevoked(p)) return (false, GooseExecutor.OffReason.Revoked);
        return (true, GooseExecutor.OffReason.Revoked);
    }

    /// The manager runs every batch through the account, so it must be one of its owners (MANAGER-NOTES §6). A failed
    /// or odd answer (an EIP-7702 account that changed its code) counts as no.
    function managerOwns(PM manager, address account) internal view returns (bool owns) {
        bytes memory data = abi.encodeCall(IJustanAccount.isOwnerAddress, (address(manager)));
        assembly ("memory-safe") {
            // Gas-capped, and only the first word of the answer is copied.
            let ok := staticcall(50000, account, add(data, 0x20), mload(data), 0x00, 0x20)
            owns := and(and(ok, eq(returndatasize(), 0x20)), eq(mload(0x00), 1))
        }
    }

    /// What's left of today's limit on spend `i`.
    function capLeft(PM manager, PM.Permission memory perm, uint256 i) internal view returns (uint256) {
        uint256 cap = perm.spends[i].allowance;
        uint256 spent = manager.getCurrentPeriod(perm, perm.spends[i]).spend;
        return cap > spent ? cap - spent : 0;
    }
}
