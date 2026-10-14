// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../src/IJustaPermissionManager.sol";

/// GooseExecutor with a few internals opened up for tests. Never deployed.
contract ExecutorHarness is GooseExecutor {
    constructor(Config memory c) GooseExecutor(c) {}

    function permissionFor(Job job, address account, Grant memory g, uint256 salt, uint256 t)
        external
        view
        returns (PM.Permission memory)
    {
        return _permission(job, account, g, salt, t);
    }

    function preFreeze(uint256 ts) external view returns (bool preFreeze_) {
        (, preFreeze_) = _clock(ts);
    }

    /// Skips the 7-day queue, for calendar tests only.
    function setHolidayNow(uint32 day, bool on) external {
        holiday[day] = on;
    }
}
