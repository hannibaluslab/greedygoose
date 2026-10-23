// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GooseGuard} from "../../src/GooseGuard.sol";
import {FakeAccount} from "../FakeAccount.sol";

/// Throwaway review test: queued owner changes never expire, apply in any order by anyone, and can remove the last runner.
contract ReviewOwnerQueueTest is Test {
    address constant KEEPERHUB = 0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93;
    GooseGuard g;
    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_792_600_000);
        address acct = address(new FakeAccount(false));
        g = new GooseGuard(owner, KEEPERHUB, acct.codehash, 300, 50, 100, 1e6, 1e6);
    }

    function test_last_runner_can_be_removed() public {
        bytes32 arg = bytes32(uint256(uint160(KEEPERHUB)));
        vm.prank(owner);
        g.queueChange(1, arg);
        vm.warp(block.timestamp + 48 hours);
        // Flipped (owner queue, last runner): the fix refuses to remove the last runner.
        vm.prank(stranger);
        vm.expectRevert(GooseGuard.LastRunner.selector);
        g.applyChange(1, arg);
        assertTrue(g.isRunner(KEEPERHUB), "the last runner stays");
    }

    function test_stale_remove_applies_after_readd_by_stranger_any_time() public {
        address b = makeAddr("backup");
        bytes32 argK = bytes32(uint256(uint160(KEEPERHUB)));
        bytes32 argB = bytes32(uint256(uint160(b)));
        vm.startPrank(owner);
        g.queueChange(1, argK); // remove KeeperHub, queued and forgotten
        g.queueChange(0, argB); // add backup
        vm.stopPrank();
        vm.warp(block.timestamp + 365 days); // a year later, still live: no expiry
        // Flipped (owner queue, order/expiry): a matured change expires, so a stale remove can't be applied a year later.
        vm.prank(stranger);
        vm.expectRevert(GooseGuard.ChangeExpired.selector);
        g.applyChange(1, argK);
        assertTrue(g.isRunner(KEEPERHUB), "the stale remove did not apply");
        assertFalse(g.isRunner(b), "the expired add did not apply either");
    }
}
