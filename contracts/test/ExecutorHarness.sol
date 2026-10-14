// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../src/IJustaPermissionManager.sol";
import {SellJob} from "../src/jobs/SellJob.sol";

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

    /// Runs `calls` through the manager as a Protect · sell batch for `account`, under the sale's post-checks, so tests
    /// can show what they catch. `sold` is what the batch claims to sell, by reserve id.
    function sellWith(address account, uint256[7] calldata sold, PM.Call[] calldata calls) external {
        Job job = Job.ProtectSell;
        PM.Permission memory p =
            _permission(job, account, grants[account][job], salts[account][job], terms[account][job]);
        SellJob.Before memory b =
            SellJob.snapshot(_env(), account, sold, SPOKE.getUserAccountData(account).healthFactor);
        MANAGER.executeBatch(p, calls);
        SellJob.check(_env(), account, b);
    }

    /// Skips the 7-day queue, for calendar tests only.
    function setHolidayNow(uint32 day, bool on) external {
        holiday[day] = on;
    }
}
