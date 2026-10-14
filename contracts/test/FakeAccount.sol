// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJustaPermissionManager as PM} from "../src/IJustaPermissionManager.sol";

/// Not a JAW account. It says the manager owns it and answers the manager's executeBatch without running the calls,
/// or, with `burn`, spends all the gas it is given.
contract FakeAccount {
    bool internal immutable BURN;

    constructor(bool burn) {
        BURN = burn;
    }

    function isOwnerAddress(address) external pure returns (bool) {
        return true;
    }

    function executeBatch(PM.Call[] calldata) external view {
        while (BURN) {}
    }
}
