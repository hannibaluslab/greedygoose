// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IGooseGuard} from "../../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../../src/planner/TradePlanner.sol";
import {CashPlanner} from "../../src/planner/CashPlanner.sol";
import {MockGuard, MockSpoke, PlannerHarness} from "../GoosePlanner.t.sol";

/// Audit PoC, flipped (GG-14): scan coverage when members' Aave reads are costly (7-stock positions, ~390k per the
/// Planner's own comment). Each scenario keeps its members and their Aave cost, but they are junk with Protect off
/// (a member the manager doesn't own can't register at all, GG-04), so they're not in the Protect set; eight real
/// Protect accounts spread among them at the same cost are scanned in every read: worst gap one round, none missed.
///   forge test --match-contract PlannerCoverageAuditTest -vv
contract PlannerCoverageAuditTest is Test {
    address constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    uint256 constant REAL = 8;
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

    function _run(uint256 n, uint256 burn) internal {
        spoke.setBurn(burn);
        for (uint256 i; i < n; ++i) {
            if (i % (n / REAL) == 0 && guard.protectMembersLength() < REAL) {
                address p = address(uint160(0xA0000 + i));
                guard.add(p, 1 << 1 | 1 << 2, 0);
                spoke.set(p, 1_000e6, 1.4e18, false);
            }
            address a = address(uint160(0x10000 + i));
            guard.add(a, 1 << 0 | 1 << 3, 0); // Save and Rebalance: the page reads it, the Protect scan doesn't
            spoke.set(a, 1_000e6, 1.4e18, false);
        }
        assertEq(guard.protectMembersLength(), REAL);
        uint256[] memory last = new uint256[](REAL);
        uint256 maxGap;
        uint256 per = type(uint256).max;
        uint256 r0 = 2_942_000;
        for (uint256 round = r0; round < r0 + 120; ++round) {
            (uint256 start, uint256 scanned,) = planner.scanOf{gas: 8_600_000}(round, 0, 1);
            if (scanned < per) per = scanned;
            for (uint256 j; j < scanned; ++j) {
                uint256 k = (start + j) % REAL;
                if (last[k] != 0 && round - last[k] > maxGap) maxGap = round - last[k];
                last[k] = round;
            }
        }
        uint256 never;
        for (uint256 k; k < REAL; ++k) {
            if (last[k] == 0) ++never;
        }
        console2.log("members, Aave read gas", n, burn);
        console2.log("  fewest Protect accounts a read scanned, worst gap (rounds), never seen in 120 rounds", per, maxGap, never);
        assertEq(per, REAL, "a read missed a Protect account");
        assertEq(maxGap, 1, "a Protect account waited past one round");
        assertEq(never, 0);
    }

    function test_cheap_members_500() public {
        _run(500, 80_000);
    }

    function test_seven_stock_members_500() public {
        _run(500, 390_000);
    }

    function test_seven_stock_members_200() public {
        _run(200, 390_000);
    }
}
