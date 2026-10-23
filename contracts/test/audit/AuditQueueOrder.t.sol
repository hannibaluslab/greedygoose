// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GooseGuard} from "../../src/GooseGuard.sol";

/// Audit PoC, flipped (GG-08, GG-09): the owner queue had no order and no expiry, and could remove the last runner.
/// Now a change can't be queued while its opposite waits, a due change expires 7 days after its ETA, and the last
/// runner can never be removed, queued or at once.
contract AuditQueueOrderTest is Test {
    uint8 constant ADD_RUNNER = 0;
    uint8 constant REMOVE_RUNNER = 1;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeperhub");
    address griefer = makeAddr("griefer");
    GooseGuard g;

    function setUp() public {
        vm.warp(1_800_000_000);
        g = new GooseGuard(owner, keeper, bytes32(uint256(1)), 300, 50, 100, 1e6, 1e6);
    }

    function _arg(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// Maintenance: the owner queues "remove KeeperHub" (planned swap), then a day later "add KeeperHub back"
    /// (the swap was called off, and the owner re-queues the add instead of cancelling). The add is refused while the
    /// remove waits, so no griefer can pick their order: the owner must cancel the remove first. And the remove
    /// itself can't apply: KeeperHub is the only runner.
    function test_no_one_picks_the_order_of_opposite_changes() public {
        vm.startPrank(owner);
        g.queueChange(REMOVE_RUNNER, _arg(keeper));
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(GooseGuard.OppositeQueued.selector);
        g.queueChange(ADD_RUNNER, _arg(keeper));
        vm.stopPrank();

        vm.warp(block.timestamp + 48 hours);
        vm.startPrank(griefer);
        vm.expectRevert(GooseGuard.NotQueued.selector);
        g.applyChange(ADD_RUNNER, _arg(keeper));
        vm.expectRevert(GooseGuard.LastRunner.selector);
        g.applyChange(REMOVE_RUNNER, _arg(keeper));
        vm.stopPrank();
        assertTrue(g.isRunner(keeper), "KeeperHub stays the runner");
    }

    /// A change queued and forgotten expires 7 days after its ETA: years later no one can apply it.
    function test_a_matured_change_expires_7_days_after_its_eta() public {
        vm.prank(owner);
        g.queueChange(REMOVE_RUNNER, _arg(keeper));
        vm.warp(block.timestamp + 3 * 365 days);
        vm.expectRevert(GooseGuard.ChangeExpired.selector);
        vm.prank(griefer);
        g.applyChange(REMOVE_RUNNER, _arg(keeper));
        assertTrue(g.isRunner(keeper));
    }

    /// The owner can't stop Protect for every account that relies on KeeperHub: REMOVE_RUNNER of the only runner is
    /// refused, queued or at once, and KeeperHub's moves still run (here refused on their own checks, not skipped).
    function test_the_last_runner_can_never_be_removed() public {
        vm.prank(owner);
        g.queueChange(REMOVE_RUNNER, _arg(keeper));
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(GooseGuard.LastRunner.selector);
        g.applyChange(REMOVE_RUNNER, _arg(keeper));
        vm.expectRevert(GooseGuard.LastRunner.selector);
        vm.prank(owner);
        g.removeRunner(keeper);
        assertTrue(g.isRunner(keeper));
        GooseGuard.Move[] memory m = new GooseGuard.Move[](1);
        m[0] = GooseGuard.Move(makeAddr("user"), 1, new uint256[](2));
        vm.recordLogs();
        vm.prank(keeper);
        g.performUpkeep(abi.encode(m));
        assertEq(vm.getRecordedLogs().length, 1, "the move ran to its own checks (Refused), not skipped");
    }
}
