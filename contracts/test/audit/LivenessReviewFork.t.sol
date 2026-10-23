// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../../src/GooseGuard.sol";
import {GoosePlanner} from "../../src/GoosePlanner.sol";
import {PlanBase} from "../../src/planner/PlanBase.sol";
import {GooseKeeperHubRoundForkTest, IERC20Like} from "../GooseKeeperHubRoundFork.t.sol";

interface IV3Borrow {
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256);
}

/// THROWAWAY liveness-review tests (not part of the suite). Run only with --match-test "test_LR_".
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
        console2.log("junk moves, kind, fromWallet", m.length, m[0].kind, m[0].args[0]);
        console2.log("junk fromSavings, junk hf", m[0].args[1], _hf(j[0]));
        RoundLog memory log;
        for (uint256 k; k < 3; ++k) {
            _round(log);
        }
        console2.log("writes, moves, refused", log.writes, log.moves, log.refused);
        for (uint256 i; i < 4; ++i) {
            console2.log("victim health after 3 rounds", _hf(v[i]));
        }
        // The claim: no victim was repaid.
        for (uint256 i; i < 4; ++i) {
            assertLt(_hf(v[i]), 1.03e18, "a victim got protected");
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
        console2.log("writes", log.writes);
        assertLt(_hf(a), 1.30e18, "it was protected");
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
        planner.protectCheck(g.members(0));
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
                _drawMoreTo(j[i], 1.005e18); // the attacker's one borrow per account per round
            }
        }
        console2.log("writes, moves, refused", log.writes, log.moves, log.refused);
        for (uint256 i; i < 4; ++i) {
            console2.log("victim health after 3 rounds", _hf(v[i]));
        }
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
    function test_LR_diversified_victims_sell_the_same_pool() public {
        for (uint256 i; i < 4; ++i) {
            address a = _diversified2(string.concat("sv", vm.toString(i)), 1.0e18 + 0.005e18 * (i + 1));
            PlanBase.Move[] memory m = planner.movesOf(a);
            for (uint256 k; k < m.length; ++k) {
                for (uint256 l; l < m[k].args.length; ++l) {
                    console2.log("victim, kind, leg stock", i, m[k].kind, m[k].args[l] >> 248);
                }
            }
        }
        (bool need, bytes memory data) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        console2.log("moves in the write", need ? abi.decode(data, (GooseGuard.Move[])).length : 0);
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
