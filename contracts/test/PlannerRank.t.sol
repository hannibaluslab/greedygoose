// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IGooseGuard, PlanBase} from "../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../src/planner/TradePlanner.sol";
import {CashPlanner} from "../src/planner/CashPlanner.sol";
import {MockGuard, MockSpoke, PlannerHarness} from "./GoosePlanner.t.sol";

/// A ProtectPlanner stand-in: each account's rank, and either no move or a $1 repay.
contract MockProtect {
    IGooseGuard public immutable GUARD;
    mapping(address => uint256) public key;
    mapping(address => bool) public empty;

    constructor(IGooseGuard g) {
        GUARD = g;
    }

    function set(address a, uint256 k, bool e) external {
        key[a] = k;
        empty[a] = e;
    }

    function rankOf(address a, uint256) external view returns (uint256, bool) {
        return (key[a], false);
    }

    function planProtectExcept(address a, uint256, uint256) external view returns (PlanBase.Move[] memory m) {
        if (empty[a]) return m;
        m = new PlanBase.Move[](1);
        uint256[] memory args = new uint256[](2);
        args[0] = 1e6;
        m[0] = PlanBase.Move(a, 1, args);
    }
}

/// A token whose balances a test sets (USDC and aUSDC, offline).
contract MockToken {
    mapping(address => uint256) public balanceOf;

    function set(address a, uint256 b) external {
        balanceOf[a] = b;
    }
}

/// Offline tests for the Protect read's ranking: an empty plan hands its place on (G3), and the scan's stage 1 skips
/// Aave's account read for a member no move can help or that can't beat a full list (G5).
/// Run: forge test --match-contract PlannerRankTest -vv
contract PlannerRankTest is Test {
    address constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant AUSDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    uint8 constant PROTECT_BITS = 1 << 1 | 1 << 2;
    uint8 constant PROTECT_ONLY = 1 << 1;

    MockGuard guard;
    MockSpoke spoke;
    MockProtect protect;
    PlannerHarness planner;

    function setUp() public {
        guard = new MockGuard();
        vm.etch(SPOKE, type(MockSpoke).runtimeCode);
        spoke = MockSpoke(SPOKE);
        vm.etch(USDC, type(MockToken).runtimeCode);
        vm.etch(AUSDC, type(MockToken).runtimeCode);
        IGooseGuard ig = IGooseGuard(address(guard));
        protect = new MockProtect(ig);
        planner = new PlannerHarness(
            ig, ProtectPlanner(address(protect)), new TradePlanner(ig), new CashPlanner(ig)
        );
        vm.warp(100); // round 0: the scan starts at member 0
    }

    function _member(uint256 i, uint8 jobs, uint256 debt, uint256 key, bool empty) internal returns (address a) {
        a = address(uint160(0x10000 + i));
        guard.add(a, jobs, 0);
        spoke.set(a, debt, 1.0e18, false);
        protect.set(a, key, empty);
    }

    function _accounts() internal view returns (address[] memory who) {
        (bool need, bytes memory data) = planner.checkUpkeep{gas: 8_600_000}(abi.encode(uint256(0), uint256(1)));
        if (!need) return who;
        PlanBase.Move[] memory m = abi.decode(data, (PlanBase.Move[]));
        who = new address[](m.length);
        for (uint256 i; i < m.length; ++i) {
            who[i] = m[i].account;
        }
    }

    // ================================================================== G3: an empty plan hands its place on

    /// Thirty members ranked above a victim whose plans all come back empty: the victim, 31st in rank, is planned.
    /// Before, the scan kept 24 and each empty plan used up a place, so the victim was never reached.
    function test_an_empty_plan_hands_its_place_to_the_next_in_rank() public {
        for (uint256 i; i < 30; ++i) {
            _member(i, PROTECT_BITS, 1_000e6, 1_000e6, true);
        }
        address victim = _member(30, PROTECT_BITS, 100e6, 5e6, false);
        address[] memory who = _accounts();
        assertEq(who.length, 1, "one repay in the write");
        assertEq(who[0], victim, "the victim wasn't planned");
    }

    /// No more than MAX_CANDS + CAND_RESERVE are kept: a victim ranked under that many empty plans waits.
    function test_the_reserve_is_bounded() public {
        uint256 kept = planner.MAX_CANDS() + planner.CAND_RESERVE();
        for (uint256 i; i < kept; ++i) {
            _member(i, PROTECT_BITS, 1_000e6, 1_000e6, true);
        }
        _member(kept, PROTECT_BITS, 100e6, 5e6, false);
        assertEq(_accounts().length, 0);
    }

    // ================================================================== G5: stage 1, before Aave's account read

    /// A member whose Aave read reverts: a check that reads it reverts, one that stops at stage 1 doesn't.
    function test_stage_one_skips_the_read_when_the_bound_cannot_beat_the_list() public {
        address a = _member(0, PROTECT_BITS, 100e6, 0, true);
        spoke.set(a, 100e6, 1.0e18, true); // its Aave read reverts
        (uint8 need, uint256 hf) = planner.protectCheck(a, 100e6); // its debt, the most its rank could be
        assertEq(need, 0);
        assertEq(hf, 0);
        vm.expectRevert(bytes("oracle down"));
        planner.protectCheck(a, 100e6 - 1);
    }

    /// Protect without Protect · sell and no rescue: with no wallet cash above the keep-back and no savings, no move can
    /// help, so Aave's account isn't read.
    function test_stage_one_skips_the_read_with_no_cash_and_no_sell() public {
        address a = _member(0, PROTECT_ONLY, 100e6, 0, true);
        spoke.set(a, 100e6, 1.0e18, true);
        MockToken(USDC).set(a, 1e6); // the keep-back, no more
        (uint8 need,) = planner.protectCheck(a, 0);
        assertEq(need, 0);
        MockToken(AUSDC).set(a, 1); // a unit of savings
        vm.expectRevert(bytes("oracle down"));
        planner.protectCheck(a, 0);
        MockToken(AUSDC).set(a, 0);
        MockToken(USDC).set(a, 5e6); // $4 above the keep-back
        vm.expectRevert(bytes("oracle down"));
        planner.protectCheck(a, 0);
        // The bound is the cash, within the debt: $4 can't beat a full list whose worst rank is $4.
        (need,) = planner.protectCheck(a, 4e6);
        assertEq(need, 0);
    }

    /// In the read: once the list is full, a member whose bound can't beat its worst rank is never read.
    function test_the_read_skips_aave_for_a_member_that_cannot_beat_a_full_list() public {
        uint256 kept = planner.MAX_CANDS() + planner.CAND_RESERVE();
        for (uint256 i; i < kept; ++i) {
            _member(i, PROTECT_BITS, 1_000e6, 600e6, true);
        }
        address low = _member(kept, PROTECT_BITS, 500e6, 0, true); // debt $500 < the worst kept rank, $600
        address high = _member(kept + 1, PROTECT_BITS, 700e6, 0, true);
        vm.expectCall(SPOKE, abi.encodeCall(MockSpoke.getUserAccountData, (low)), 0);
        vm.expectCall(SPOKE, abi.encodeCall(MockSpoke.getUserAccountData, (high)), 1);
        planner.checkUpkeep{gas: 8_600_000}(abi.encode(uint256(0), uint256(1)));
    }
}
