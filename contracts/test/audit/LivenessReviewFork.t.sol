// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../../src/GooseGuard.sol";
import {GoosePlanner} from "../../src/GoosePlanner.sol";
import {PlanBase} from "../../src/planner/PlanBase.sol";
import {ISpoke} from "../IJustaPermissionManager.sol";
import {GooseKeeperHubRoundForkTest, IERC20Like} from "../GooseKeeperHubRoundFork.t.sol";

interface IV3Borrow {
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256);
}

/// Liveness-review tests. Those that proved a finding now assert its fix (each names the finding it guards); the rest
/// log measurements. Run only with --match-test "test_LR_".
contract ZLivenessReviewForkTest is GooseKeeperHubRoundForkTest {
    address constant V3 = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;

    // ------------------------------------------------------------------ 1. free junk: a V3 borrow blocks the savings repay

    /// A junk account: AAPLc backing V4 credit at 1.005, its savings (aUSDC) pledged to a V3 USDC borrow so the
    /// withdraw always fails, and its wallet emptied. The Planner plans REPAY [0, savings] every round; the Guard
    /// refuses it every round; the attacker pays nothing per round.
    function _v3Junk(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        _backWith(a, AAPL, 1e7); // 0.1 share
        _drawTo(a, 1.005e18);
        deal(address(USDC), a, 30e6);
        _save(a, 30e6);
        (,,uint256 avail,,,) = IV3Borrow(V3).getUserAccountData(a);
        vm.prank(a);
        IV3Borrow(V3).borrow(address(USDC), avail / 100 * 999 / 1000, 2, 0, a);
        uint256 bal = USDC.balanceOf(a);
        vm.prank(a);
        IERC20Like2(address(USDC)).transfer(address(0xdead), bal);
        _protectOn(a);
    }

    /// Guards the V3-borrow junk finding: savings that back a V3 borrow count only down to V3 health 1.01, so the junk
    /// gets no move, nothing is refused, and every victim is repaid.
    function test_LR_v3_borrow_junk_blocks_every_repay() public {
        address[] memory v = new address[](4);
        for (uint256 i; i < 4; ++i) {
            v[i] = _owing(string.concat("victim", vm.toString(i)), 1.02e18, true);
        }
        address[] memory j = new address[](4);
        for (uint256 i; i < 4; ++i) {
            j[i] = _v3Junk(string.concat("v3junk", vm.toString(i)));
        }
        PlanBase.Move[] memory m = planner.movesOf(j[0]);
        console2.log("junk moves, junk savingsOut, junk hf", m.length, protect.savingsOut(j[0]), _hf(j[0]));
        assertEq(m.length, 0, "a move is planned from savings V3 won't let go");
        RoundLog memory log;
        for (uint256 k; k < 3; ++k) {
            _round(log);
        }
        console2.log("writes, moves, refused", log.writes, log.moves, log.refused);
        for (uint256 i; i < 4; ++i) {
            console2.log("victim health after 3 rounds", _hf(v[i]));
        }
        assertEq(log.refused, 0, "a move was refused");
        for (uint256 i; i < 4; ++i) {
            assertGe(_hf(v[i]), 1.03e18, "a victim still under its line");
        }
    }

    // ------------------------------------------------------------------ 2. a keepMix sale over six stocks never fits

    function _diversified(string memory name, bool keepMix) internal returns (address a) {
        a = _newJawAccount(name);
        _backWithAllStocks(a, 1e8);
        vm.prank(a);
        g.setProtect(13000, 14000); // a cautious user: line 1.30, target 1.40 (decision 3 allows it)
        _drawTo(a, 1.25e18);
        deal(address(USDC), a, 0);
        _protectOn(a);
        _sellOn(a);
        vm.prank(a);
        g.setKeepMix(keepMix);
    }

    /// Guards GG-03: a lone keep-my-mix sale over six stocks used to need more than a write's gas and was never sent;
    /// now it's cut to fit, checked as cut, and the account is back over its line within four rounds.
    function test_LR_keepmix_six_stock_sale_is_never_sent() public {
        address a = _diversified("keepmix", true);
        PlanBase.Move[] memory m = planner.movesOf(a);
        for (uint256 i; i < m.length; ++i) {
            console2.log("planned kind, legs, cap", m[i].kind, m[i].args.length, g.capOf(m[i].kind, m[i].args));
        }
        (bool need, bytes memory data) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        console2.log("checkUpkeep need, bytes", need, data.length);
        RoundLog memory log;
        uint256 before = _hf(a);
        for (uint256 k; k < 4; ++k) {
            _round(log);
        }
        console2.log("health before, after 4 rounds", before, _hf(a));
        console2.log("writes, refused", log.writes, log.refused);
        assertEq(log.refused, 0, "a move was refused");
        assertGe(_hf(a), 1.30e18, "still under its line after 4 rounds");
    }

    function test_LR_control_no_keepmix_sale_is_sent() public {
        address a = _diversified("nokeep", false);
        PlanBase.Move[] memory m = planner.movesOf(a);
        for (uint256 i; i < m.length; ++i) {
            console2.log("planned kind, legs, cap", m[i].kind, m[i].args.length, g.capOf(m[i].kind, m[i].args));
        }
        RoundLog memory log;
        for (uint256 k; k < 2; ++k) {
            _round(log);
        }
        console2.log("health after, refused", _hf(a), log.refused);
    }

    // ------------------------------------------------------------------ 3. scan coverage with diversified members

    function test_LR_scan_coverage_with_seven_stock_members() public {
        for (uint256 i; i < 40; ++i) {
            address a = _newJawAccount(string.concat("d", vm.toString(i)));
            _backWithAllStocks(a, 1e8);
            _drawTo(a, 1.4e18);
            _protectOn(a);
            _sellOn(a);
        }
        uint256 g0 = gasleft();
        planner.protectCheck(g.members(0), 0);
        console2.log("one protectCheck, seven stocks", g0 - gasleft());
        g0 = gasleft();
        planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        console2.log("checkUpkeep gas", g0 - gasleft());
        (, uint256 scanned,) = planner.scanOf{gas: READ_CAP}(vm.getBlockTimestamp() / 600, 0, 1);
        console2.log("members one read scans (of 40)", scanned);
        // The same input twice in a round: the same window.
        (uint256 s1,,) = planner.scanOf{gas: READ_CAP}(vm.getBlockTimestamp() / 600, 0, 1);
        (uint256 s2,,) = planner.scanOf{gas: READ_CAP}(vm.getBlockTimestamp() / 600, 0, 1);
        console2.log("first and second read's start", s1, s2);
    }

    // ------------------------------------------------------------------ 4. the crash, with slower arbitrage

    /// The suite's crash, except arbitrage brings the pool to Aave's price once a round (before the first read), not
    /// before each read. `lag`: the pool only reaches the previous round's price (Aave moves first, the pool follows).
    function _crash(bool lag) internal {
        address[] memory a = new address[](20);
        for (uint256 i; i < 20; ++i) {
            a[i] = _owing(string.concat("crash", vm.toString(i)), 1.06e18 + i * 0.015e18, i % 2 == 0);
        }
        uint256 price = _price(NVDA);
        RoundLog memory log;
        uint256 lowest = type(uint256).max;
        uint256 under1;
        for (uint256 k; k < 13; ++k) {
            uint256 prev = price;
            if (k < 10) price = price * 98 / 100;
            vm.mockCall(ORACLE, abi.encodeWithSignature("getReservePrice(uint256)", NVDA), abi.encode(price));
            _poolTo(NVDA, lag ? prev : price);
            _readWrite(log);
            _readWrite(log);
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
            vm.roll(block.number + 300);
            for (uint256 i; i < 20; ++i) {
                uint256 hf = _hf(a[i]);
                if (hf < lowest) lowest = hf;
            }
            console2.log("round, lowest so far, pool vs aave bps", k, lowest, planner.poolPrice(NVDA) * 1e4 / price);
        }
        for (uint256 i; i < 20; ++i) {
            (uint256 line,) = g.linesOf(a[i]);
            if (_hf(a[i]) < line) ++under1;
        }
        console2.log("writes, moves, refused", log.writes, log.moves, log.refused);
        console2.log("lowest health, accounts still under their line", lowest, under1);
    }

    function test_LR_crash_arbitrage_once_a_round() public {
        _crash(false);
    }

    function test_LR_crash_pool_lags_one_round() public {
        _crash(true);
    }

    // ------------------------------------------------------------------ 5. the paying attacker, re-borrowing each round

    /// Guards GG-01 (tiny junk): eight $5 accounts at health 1.005 re-borrowing every round no longer rank above the
    /// victims, whose need is larger: every victim is repaid.
    function test_LR_tiny_junk_reborrowing_each_round() public {
        address[] memory v = new address[](4);
        for (uint256 i; i < 4; ++i) {
            v[i] = _owing(string.concat("victim", vm.toString(i)), 1.02e18, true);
        }
        address[] memory j = new address[](8);
        for (uint256 i; i < 8; ++i) {
            j[i] = _newJawAccount(string.concat("tiny", vm.toString(i)));
            _backWith(j[i], AAPL, 2e6); // 0.02 share, about $5
            _drawTo(j[i], 1.005e18);
            deal(address(USDC), j[i], 3e6);
            _protectOn(j[i]);
        }
        PlanBase.Move[] memory m = planner.movesOf(j[0]);
        console2.log("tiny junk planned moves, repay", m.length, m.length > 0 ? m[0].args[0] + m[0].args[1] : 0);
        RoundLog memory log;
        for (uint256 k; k < 3; ++k) {
            _round(log);
            for (uint256 i; i < 8; ++i) {
                _reborrowTo(j[i], 1.005e18); // the attacker's one borrow per account per round
            }
        }
        console2.log("writes, moves, refused", log.writes, log.moves, log.refused);
        for (uint256 i; i < 4; ++i) {
            console2.log("victim health after 3 rounds", _hf(v[i]));
        }
        for (uint256 i; i < 4; ++i) {
            assertGe(_hf(v[i]), 1.03e18, "a victim still under its line");
        }
    }
    /// The attacker's borrow back down to `hf`, for an account Protect repaid (one it didn't owes a little more by now).
    function _reborrowTo(address a, uint256 hf) internal {
        ISpoke.UserAccountData memory d = SPOKE.getUserAccountData(a);
        uint256 owed = d.totalCollateralValue * d.avgCollateralFactor / 1e18 * 1e18 / hf / 1e20;
        if (owed > SPOKE.getUserTotalDebt(7, a)) _drawMoreTo(a, hf);
    }

    // ------------------------------------------------------------------ 6. Protect planning budget at scale

    function test_LR_plan_gas_per_candidate() public {
        address one = _owing("one", 1.02e18, false);
        address seven = _diversified2("seven", 1.02e18);
        address repay = _owing("repay", 1.02e18, true);
        uint256 g0 = gasleft();
        protect.planProtect(one);
        console2.log("planProtect gas, one-stock sale", g0 - gasleft());
        g0 = gasleft();
        protect.planProtect(seven);
        console2.log("planProtect gas, seven-stock sale", g0 - gasleft());
        g0 = gasleft();
        protect.planProtect(repay);
        console2.log("planProtect gas, savings repay", g0 - gasleft());
    }

    function _diversified2(string memory name, uint256 hf) internal returns (address a) {
        a = _newJawAccount(name);
        _backWithAllStocks(a, 1e8);
        _drawTo(a, hf);
        deal(address(USDC), a, 0);
        _protectOn(a);
        _sellOn(a);
    }

    /// 40 healthy seven-stock members, then 4 seven-stock accounts under the line with no cash (sale only).
    function test_LR_seven_stock_victims_behind_a_full_scan() public {
        for (uint256 i; i < 40; ++i) {
            address a = _newJawAccount(string.concat("d", vm.toString(i)));
            _backWithAllStocks(a, 1e8);
            _drawTo(a, 1.4e18);
            _protectOn(a);
            _sellOn(a);
        }
        address[] memory v = new address[](4);
        for (uint256 i; i < 4; ++i) {
            v[i] = _diversified2(string.concat("sv", vm.toString(i)), 1.02e18);
        }
        uint256 round = vm.getBlockTimestamp() / 600;
        for (uint256 k; k < 6; ++k) {
            (uint256 start, uint256 scanned, address[] memory c) =
                planner.scanOf{gas: READ_CAP}(vm.getBlockTimestamp() / 600, 0, 1);
            uint256 g0 = gasleft();
            (bool need, bytes memory data) =
                planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
            uint256 used = g0 - gasleft();
            uint256 n = need ? abi.decode(data, (GooseGuard.Move[])).length : 0;
            console2.log("round, start, scanned", vm.getBlockTimestamp() / 600 - round, start, scanned);
            console2.log("  candidates, moves planned, read gas", c.length, n, used);
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
        }
    }
    /// Guards GG-18: four seven-stock victims near health 1.0 whose sales all start on the same pool. A sale near the
    /// withdraw floor takes six slices of one stock, a 4.3M cap, so one fits a write (the Guard's SELL caps bound this,
    /// not the pool); the write's sales never share a pool, its caps fit PACK_GAS, nothing is refused, and each round
    /// sells for a different victim, so all four are sold for within two rounds.
    function test_LR_diversified_victims_sell_the_same_pool() public {
        address[] memory v = new address[](4);
        for (uint256 i; i < 4; ++i) {
            address a = _diversified2(string.concat("sv", vm.toString(i)), 1.0e18 + 0.005e18 * (i + 1));
            v[i] = a;
            PlanBase.Move[] memory m = planner.movesOf(a);
            for (uint256 k; k < m.length; ++k) {
                for (uint256 l; l < m[k].args.length; ++l) {
                    console2.log("victim, kind, leg stock", i, m[k].kind, m[k].args[l] >> 248);
                }
            }
        }
        (bool need, bytes memory data) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        GooseGuard.Move[] memory w = need ? abi.decode(data, (GooseGuard.Move[])) : new GooseGuard.Move[](0);
        console2.log("moves in the write", w.length);
        uint256 sales;
        uint256 seen;
        uint256 gas;
        for (uint256 k; k < w.length; ++k) {
            gas += g.capOf(w[k].kind, w[k].args);
            if (w[k].kind != 2) continue;
            ++sales;
            uint256 bits;
            for (uint256 l; l < w[k].args.length; ++l) {
                bits |= 1 << (w[k].args[l] >> 248);
            }
            assertEq(bits & seen, 0, "two sales in one write share a pool");
            seen |= bits;
        }
        console2.log("sales in the write, caps", sales, gas);
        assertGe(sales, 1, "no sale");
        assertLe(gas, planner.PACK_GAS(), "the write's caps pass PACK_GAS");
        uint256[] memory before = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            before[i] = _hf(v[i]);
        }
        RoundLog memory log;
        _round(log);
        _round(log);
        assertEq(log.refused, 0, "a move was refused");
        for (uint256 i; i < 4; ++i) {
            console2.log("victim, health before, after two rounds", i, before[i], _hf(v[i]));
            assertGt(_hf(v[i]), before[i], "a victim waited two rounds");
        }
    }

    /// GG-18 where the caps allow it: two cautious seven-stock victims (line 1.30, target 1.40) at health 1.25 whose
    /// sales both start on the same lowest-factor stock, a slice or two each. Both go in one write, on different
    /// pools, and neither is refused.
    function test_LR_two_sales_through_different_pools_in_one_write() public {
        address[] memory v = new address[](2);
        for (uint256 i; i < 2; ++i) {
            v[i] = _diversified(string.concat("tv", vm.toString(i)), false);
            assertEq(planner.movesOf(v[i]).length, 1, "not one sale");
        }
        uint256 first = planner.movesOf(v[0])[0].args[0] >> 248;
        assertEq(planner.movesOf(v[1])[0].args[0] >> 248, first, "the sales don't start on the same stock");
        (bool need, bytes memory data) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        assertTrue(need);
        GooseGuard.Move[] memory w = abi.decode(data, (GooseGuard.Move[]));
        uint256 seen;
        uint256 sold;
        for (uint256 k; k < w.length; ++k) {
            if (w[k].kind != 2) continue;
            uint256 bits;
            for (uint256 l; l < w[k].args.length; ++l) {
                bits |= 1 << (w[k].args[l] >> 248);
            }
            assertEq(bits & seen, 0, "two sales in one write share a pool");
            seen |= bits;
            sold |= w[k].account == v[0] ? 1 : w[k].account == v[1] ? 2 : 0;
        }
        assertEq(sold, 3, "both sales aren't in the write");
        uint256 h0 = _hf(v[0]);
        uint256 h1 = _hf(v[1]);
        RoundLog memory log;
        _readWrite(log);
        assertEq(log.refused, 0, "a move was refused");
        assertGt(_hf(v[0]), h0);
        assertGt(_hf(v[1]), h1);
    }
    function test_LR_one_sale_depth_per_pool() public view {
        for (uint256 r; r < 7; ++r) {
            uint256 price = _price(r);
            uint256 shares = planner.stockDepth(r, price, false, g.SALE_FLOOR_BPS(), 1e20);
            console2.log("stock, sale depth USD, pool vs aave bps", r, shares * price / 1e16, planner.poolPrice(r) * 1e4 / price);
        }
    }
}



interface IERC20Like2 {
    function transfer(address, uint256) external returns (bool);
}
