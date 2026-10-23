// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IGooseGuard} from "../../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../../src/planner/TradePlanner.sol";
import {CashPlanner} from "../../src/planner/CashPlanner.sol";
import {MockGuard, MockSpoke, PlannerHarness} from "../GoosePlanner.t.sol";

/// Audit PoC: scan coverage when members' Aave reads are costly (7-stock positions, ~390k per the Planner's own
/// comment), and the worst gap between two scans of one member.
///   forge test --match-contract PlannerCoverageAuditTest -vv
contract PlannerCoverageAuditTest is Test {
    address constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
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
        for (uint256 i = guard.membersLength(); i < n; ++i) {
            address a = address(uint160(0x10000 + i));
            guard.add(a, 1 << 1 | 1 << 2, 0);
            spoke.set(a, 1_000e6, 1.4e18, false);
        }
        uint256[] memory last = new uint256[](n);
        uint256 maxGap;
        uint256 per;
        uint256 r0 = 2_942_000;
        for (uint256 round = r0; round < r0 + 120; ++round) {
            (uint256 start, uint256 scanned,) = planner.scanOf{gas: 8_600_000}(round, 0, 1);
            per = scanned;
            for (uint256 j; j < scanned; ++j) {
                uint256 k = (start + j) % n;
                if (last[k] != 0 && round - last[k] > maxGap) maxGap = round - last[k];
                last[k] = round;
            }
        }
        uint256 never;
        for (uint256 k; k < n; ++k) {
            if (last[k] == 0) ++never;
        }
        console2.log("members, Aave read gas", n, burn);
        console2.log("  scanned a read, worst gap (rounds), never seen in 120 rounds", per, maxGap, never);
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
