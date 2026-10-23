// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IGooseGuard, PlanBase} from "../../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../../src/planner/TradePlanner.sol";
import {CashPlanner} from "../../src/planner/CashPlanner.sol";
import {MockGuard, MockSpoke, PlannerHarness} from "../GoosePlanner.t.sol";
import {MockToken} from "../PlannerRank.t.sol";

/// A ProtectPlanner stand-in whose rankOf costs what a real one does after protectCheck warmed the account (the fork's
/// warm figure, about 720k; cold is 1.15M), and whose plan is a $1 repay.
contract GasyProtect {
    IGooseGuard public immutable GUARD;
    uint256 public burn;

    constructor(IGooseGuard g) {
        GUARD = g;
    }

    function setBurn(uint256 b) external {
        burn = b;
    }

    function rankOf(address, uint256) external view returns (uint256, bool) {
        uint256 stop = gasleft() - burn;
        while (gasleft() > stop) {}
        return (5e6 | 1 << 128, false);
    }

    function planProtectExcept(address a, uint256, uint256) external pure returns (PlanBase.Move[] memory m) {
        m = new PlanBase.Move[](1);
        uint256[] memory args = new uint256[](2);
        args[0] = 1e6;
        m[0] = PlanBase.Move(a, 1, args);
    }
}

/// R3: the scan admits a member while CHECK_GAS / 3 (500k) of its share is left, and gives the check and rankOf
/// together at most CHECK_GAS / 3 past the share. A member under its line whose check plus rank costs more than
/// 2/3 CHECK_GAS (1M; the fork measures 715k + ~720k on a seven-stock account) and lands in the last ~400k before the
/// cut is reached, checked, then its rankOf runs out of gas: the catch drops it, the read plans nothing for it, and
/// scanOf counts it as reached.
///   forge test --match-contract ReviewScanEdgeTest -vv
contract ReviewScanEdgeTest is Test {
    address constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant AUSDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    uint8 constant PROTECT_BITS = 1 << 1 | 1 << 2;

    function _setUp() internal returns (MockGuard guard, MockSpoke spoke, GasyProtect protect, PlannerHarness planner) {
        guard = new MockGuard();
        vm.etch(SPOKE, type(MockSpoke).runtimeCode);
        spoke = MockSpoke(SPOKE);
        vm.etch(USDC, type(MockToken).runtimeCode);
        vm.etch(AUSDC, type(MockToken).runtimeCode);
        IGooseGuard ig = IGooseGuard(address(guard));
        protect = new GasyProtect(ig);
        planner = new PlannerHarness(ig, ProtectPlanner(address(protect)), new TradePlanner(ig), new CashPlanner(ig));
        vm.warp(100);
        spoke.setBurn(600_000); // Aave's account read on a seven-stock account (protectCheck cold: 715k in all)
        protect.setBurn(720_000); // rankOf, warm
    }

    /// Fillers with no debt (cheap checks), then the victim, then one more filler; returns whether the read planned
    /// the victim.
    function _planned(uint256 fillers) internal returns (bool, address victim, PlannerHarness planner) {
        MockGuard guard;
        MockSpoke spoke;
        (guard, spoke,, planner) = _setUp();
        for (uint256 i; i < fillers; ++i) {
            address f = address(uint160(0x10000 + i));
            guard.add(f, PROTECT_BITS, 0);
            spoke.set(f, 0, 0, false);
        }
        victim = address(uint160(0x90000));
        guard.add(victim, PROTECT_BITS, 0);
        spoke.set(victim, 100e6, 1.0e18, false);
        (bool need, bytes memory data) = planner.checkUpkeep{gas: 8_600_000}(abi.encode(uint256(0), uint256(1)));
        if (!need) return (false, victim, planner);
        PlanBase.Move[] memory m = abi.decode(data, (PlanBase.Move[]));
        for (uint256 i; i < m.length; ++i) {
            if (m[i].account == victim) return (true, victim, planner);
        }
        return (false, victim, planner);
    }

    function test_R3_a_reached_member_is_dropped_when_rankOf_runs_out_of_gas() public {
        // Find the first filler count at which the victim is no longer planned.
        uint256 lo = 0;
        uint256 hi = 2000;
        uint256 snap = vm.snapshotState();
        (bool ok,,) = _planned(hi);
        vm.revertToState(snap);
        assertFalse(ok, "victim still planned at the top of the range");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            snap = vm.snapshotState();
            (ok,,) = _planned(mid);
            vm.revertToState(snap);
            if (ok) lo = mid;
            else hi = mid;
        }
        console2.log("first filler count with the victim unplanned", hi);
        // At that count the victim was reached: scanOf (same admission rule) counts it, and rankOf was called.
        address victim;
        PlannerHarness planner;
        (ok, victim, planner) = _planned(hi);
        assertFalse(ok);
        (, uint256 scanned,) = planner.scanOf{gas: 8_600_000}(0, 0, 1);
        console2.log("scanOf reached (of fillers + victim)", scanned, hi + 1);
        // Flipped (R3 late member dropped): the scan now ends before a member it can't finish, so the victim is
        // never read nor ranked this round (it is not dropped mid-check; the next round resumes at it).
        vm.expectCall(SPOKE, abi.encodeCall(MockSpoke.getUserAccountData, (victim)), 0);
        // rankOf is only called once protectCheck returned need 1: the check passed, the rank ran out of gas.
        address protect = address(planner.PROTECT());
        vm.expectCall(protect, abi.encodeCall(GasyProtect.rankOf, (victim, 1.0e18)), 0);
        planner.checkUpkeep{gas: 8_600_000}(abi.encode(uint256(0), uint256(1)));
    }
}
