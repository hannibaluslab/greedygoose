// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GooseGuard} from "../../src/GooseGuard.sol";

/// Audit PoC: the owner queue has no order and no expiry. Two queued changes on the same runner can be applied in
/// either order by anyone, and a matured change stays applicable for ever.
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
    /// (the swap was called off, and the owner re-queues the add instead of cancelling). Once both are due, a
    /// griefer applies ADD first (a no-op) and REMOVE last: KeeperHub ends removed, the only runner gone, Protect off.
    function test_anyone_picks_the_order_of_opposite_changes() public {
        vm.startPrank(owner);
        g.queueChange(REMOVE_RUNNER, _arg(keeper));
        vm.warp(block.timestamp + 1 days);
        g.queueChange(ADD_RUNNER, _arg(keeper));
        vm.stopPrank();

        vm.warp(block.timestamp + 48 hours);
        vm.startPrank(griefer);
        g.applyChange(ADD_RUNNER, _arg(keeper)); // already a runner: no-op
        g.applyChange(REMOVE_RUNNER, _arg(keeper));
        vm.stopPrank();
        assertFalse(g.isRunner(keeper), "the owner's last word was 'add', yet KeeperHub is removed");
    }

    /// A change queued and forgotten stays live: years later anyone may still apply it.
    function test_a_matured_change_never_expires() public {
        vm.prank(owner);
        g.queueChange(REMOVE_RUNNER, _arg(keeper));
        vm.warp(block.timestamp + 3 * 365 days);
        vm.prank(griefer);
        g.applyChange(REMOVE_RUNNER, _arg(keeper));
        assertFalse(g.isRunner(keeper));
    }

    /// The owner can stop Protect for every account that relies on KeeperHub, with a 48h public wait: pause can't,
    /// but REMOVE_RUNNER of the only runner can.
    function test_removing_the_last_runner_stops_protect_rounds() public {
        vm.prank(owner);
        g.queueChange(REMOVE_RUNNER, _arg(keeper));
        vm.warp(block.timestamp + 48 hours);
        g.applyChange(REMOVE_RUNNER, _arg(keeper));
        assertFalse(g.isRunner(keeper));
        // No other runner exists: a REPAY sent by KeeperHub is now skipped silently (stranger branch).
        GooseGuard.Move[] memory m = new GooseGuard.Move[](1);
        m[0] = GooseGuard.Move(makeAddr("user"), 1, new uint256[](2));
        vm.recordLogs();
        vm.prank(keeper);
        g.performUpkeep(abi.encode(m));
        assertEq(vm.getRecordedLogs().length, 0, "the move was skipped: no Refused, no run");
    }
}
