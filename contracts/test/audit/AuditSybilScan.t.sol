// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {MockGuard, MockSpoke, PlannerHarness} from "../GoosePlanner.t.sol";
import {IGooseGuard} from "../../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../../src/planner/TradePlanner.sol";
import {CashPlanner} from "../../src/planner/CashPlanner.sol";

/// Audit PoC: sybil members registered through GooseGuard.register dilute the Planner's Protect scan, so a real
/// account under its line waits many rounds before Protect even sees it.
contract AuditSybilScanTest is Test {
    address constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    uint8 constant PROTECT_BITS = 1 << 1 | 1 << 2;
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

    /// Registers `n` healthy members (sybils) and returns: members one read scans, rounds until every member was
    /// scanned once, and the mean and worst round in which a member is first scanned (a victim at a random index).
    function _coverage(uint256 n, uint256 burn, uint256 debt)
        internal
        returns (uint256 perRead, uint256 full, uint256 mean, uint256 worst)
    {
        spoke.setBurn(burn);
        for (uint256 i; i < n; ++i) {
            address s = address(uint160(0x10000 + i));
            guard.add(s, PROTECT_BITS, 0); // what register() gives any JAW account with an approved grant
            spoke.set(s, debt, 1.4e18, false);
        }
        uint256[] memory first = new uint256[](n);
        uint256 covered;
        uint256 round = 2_942_000;
        uint256 k;
        for (; covered < n && k < 3000; ++k) {
            for (uint256 shard; shard < 2; ++shard) {
                (uint256 st, uint256 scanned,) = planner.scanOf{gas: 50_000_000}(round + k, shard, 1);
                perRead = scanned;
                for (uint256 j; j < scanned; ++j) {
                    uint256 idx = (st + j) % n;
                    if (first[idx] == 0) {
                        first[idx] = k + 1;
                        ++covered;
                    }
                }
            }
        }
        full = k;
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            sum += first[i];
            if (first[i] > worst) worst = first[i];
        }
        mean = sum / n;
    }

    function _log(string memory label, uint256 n, uint256 burn, uint256 debt) internal {
        (uint256 per, uint256 full, uint256 mean, uint256 worst) = _coverage(n, burn, debt);
        console2.log(label);
        console2.log("  members one read scans", per);
        console2.log("  rounds to scan everyone", full);
        console2.log("  mean round a member is first scanned", mean);
        console2.log("  worst round (x10 min)", worst);
    }

    function test_1000_owing_sybils() public {
        _log("1000 owing sybils, 391k Aave read each", 1000, 391_000, 1e6);
    }

    function test_3000_owing_sybils_80k() public {
        _log("3000 owing sybils, 80k Aave read each", 3000, 80_000, 1e6);
    }

    function test_20000_empty_sybils() public {
        _log("20000 sybils with Protect on and nothing owed", 20_000, 0, 0);
    }
}
