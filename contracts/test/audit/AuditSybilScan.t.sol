// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {MockGuard, MockSpoke, PlannerHarness} from "../GoosePlanner.t.sol";
import {IGooseGuard} from "../../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../../src/planner/TradePlanner.sol";
import {CashPlanner} from "../../src/planner/CashPlanner.sol";

/// Audit PoC, flipped (GG-04, GG-14): sybil members registered through GooseGuard.register used to dilute the Planner's
/// Protect scan, so a real account under its line waited many rounds before Protect even saw it. Now a sybil the
/// manager doesn't own can't register (GooseGuard.t.sol, GooseGuardJunkFork), and one with Protect off is a member
/// but not in the Protect set the scan walks: each scenario below keeps its sybils and their Aave cost, adds one real
/// account under its line among them, and asserts every read scans that account alone, from the first round.
contract AuditSybilScanTest is Test {
    address constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    uint8 constant PROTECT_BITS = 1 << 1 | 1 << 2;
    /// What a sybil can still register: an agent other than Protect (Save, Rebalance, Turn into cash).
    uint8 constant JUNK_BITS = 1 << 0 | 1 << 3 | 1 << 4;
    MockGuard guard;
    MockSpoke spoke;
    PlannerHarness planner;

    function setUp() public {
        guard = new MockGuard();
        vm.etch(SPOKE, type(MockSpoke).runtimeCode);
        spoke = MockSpoke(SPOKE);
        IGooseGuard ig = IGooseGuard(address(guard));
        planner = new PlannerHarness(ig, new ProtectPlanner(ig), new TradePlanner(ig), new CashPlanner(ig));
    }

    /// Registers `n` sybils with Protect off and, halfway through them, one victim with Protect on under its line.
    /// Returns the most Protect-set entries one read scans, and the worst round in which a read missed the victim.
    function _coverage(uint256 n, uint256 burn, uint256 debt) internal returns (uint256 perRead, uint256 missed) {
        spoke.setBurn(burn);
        address victim = address(0xBEEF);
        for (uint256 i; i < n; ++i) {
            if (i == n / 2) {
                guard.add(victim, PROTECT_BITS, 0);
                spoke.set(victim, 1_000e6, 1.0e18, false);
            }
            address s = address(uint160(0x10000 + i));
            guard.add(s, JUNK_BITS, 0); // a member for the page, not in the Protect set
            spoke.set(s, debt, 1.4e18, false);
        }
        assertEq(guard.membersLength(), n + 1);
        uint256 round = 2_942_000;
        for (uint256 k; k < 20; ++k) {
            for (uint256 shard; shard < 2; ++shard) {
                (, uint256 scanned, address[] memory cands) = planner.scanOf{gas: 50_000_000}(round + k, shard, 1);
                if (scanned > perRead) perRead = scanned;
                if (cands.length != 1 || cands[0] != victim) missed = k + 1;
            }
        }
    }

    function _check(string memory label, uint256 n, uint256 burn, uint256 debt) internal {
        (uint256 per, uint256 missed) = _coverage(n, burn, debt);
        console2.log(label);
        console2.log("  Protect-set entries one read scans", per);
        console2.log("  last round a read missed the victim (0 = none)", missed);
        assertEq(per, 1, "the scan read a sybil");
        assertEq(missed, 0, "a read missed the victim");
    }

    function test_1000_owing_sybils() public {
        _check("1000 owing sybils, 391k Aave read each", 1000, 391_000, 1e6);
    }

    function test_3000_owing_sybils_80k() public {
        _check("3000 owing sybils, 80k Aave read each", 3000, 80_000, 1e6);
    }

    function test_20000_empty_sybils() public {
        _check("20000 sybils with nothing owed", 20_000, 0, 0);
    }
}
