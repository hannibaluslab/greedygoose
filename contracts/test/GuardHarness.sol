// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseGuard} from "../src/GooseGuard.sol";
import {IJustaPermissionManager as PM} from "../src/IJustaPermissionManager.sol";

/// GooseGuard with `_execute` and its fixed stocks and pools opened up, so tests can check the calldata it hands JAW's
/// manager and the addresses it fixes. Never deployed.
contract GuardHarness is GooseGuard {
    constructor(address owner_, address runner, bytes32 cloneCodehash)
        GooseGuard(owner_, runner, cloneCodehash, 300, 50, 100, 1e6, 1e6)
    {}

    function execute(address a, uint8 job, PM.Call[] memory calls) external {
        _execute(a, job, calls);
    }

    /// The Guard's fixed stock and pool for reserve r (DeployGuard.t.sol compares them with the deploy script's).
    function stockAndPool(uint256 r) external pure returns (address, address) {
        return (_stock(r), _pool(r));
    }
}
