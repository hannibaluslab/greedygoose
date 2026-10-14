// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Book, Holding, SellLimits, SellRules, SellTiming, Slice} from "../src/SellRules.sol";
import {Vectors} from "./Vectors.sol";

/// Protect · sell's rule against the TypeScript reference (planSell and sellTiming in lib/guardian/sell.ts), on the
/// vectors scripts/agent-vectors.ts exported, plus the properties the plan asks for: ranking, the least amount,
/// spill-over at a stock's limit, never-sell, keep-my-mix, and slices that keep Aave's withdrawal check happy.
contract SellRulesTest is Test {
    uint256 constant WAD = 1e18;
    uint256 constant FLOOR = 100; // 1%
    uint256 constant TARGET = 1.4e18;
    uint256 constant NONE = 0;
    uint256 constant ALL = 1e13; // a limit, pool window or USDC limit that never binds

    // Collateral factors read live on 2026-10-13 (protect-panel): TSLA and META 65%, NVDA 70%, AAPL 78%.
    uint256 constant AAPL = 0;
    uint256 constant META = 3;
    uint256 constant NVDA = 5;
    uint256 constant TSLA = 6;

    function test_amounts_and_slices_agree_with_planSell() public view {
        string memory json = vm.readFile("test/vectors/sell.json");
        uint256[] memory amounts = vm.parseJsonUintArray(json, ".amounts");
        bytes memory counts = vm.parseJsonBytes(json, ".counts");
        bytes memory reserves = vm.parseJsonBytes(json, ".reserves");
        uint256[] memory shares = vm.parseJsonUintArray(json, ".shares");
        uint256[] memory minOuts = vm.parseJsonUintArray(json, ".minOuts");
        assertEq(counts.length, 600);
        uint256 s;
        uint256 sold;
        for (uint256 i; i < counts.length; ++i) {
            Vectors.Sell memory v = Vectors.sellInput(i);
            string memory at = string.concat("vector ", vm.toString(i));
            uint256[7] memory take = SellRules.amounts(v.book, v.targetHf, v.floorBps, v.keepMix);
            for (uint256 r; r < 7; ++r) {
                assertEq(take[r], amounts[7 * i + r], at);
            }
            Slice[] memory got = SellRules.slices(v.book, take, v.floorBps, v.maxSlice);
            assertEq(got.length, uint8(counts[i]), at);
            for (uint256 k; k < got.length; ++k) {
                assertEq(got[k].reserveId, uint8(reserves[s]), at);
                assertEq(got[k].shares, shares[s], at);
                assertEq(got[k].minOut, minOuts[s++], at);
            }
            if (got.length > 0) ++sold;
        }
        assertEq(s, shares.length, "every slice compared");
        assertGt(sold, 300, "most vectors sell");
    }

    function test_timing_agrees_with_sellTiming() public view {
        bytes memory timings = vm.parseJsonBytes(vm.readFile("test/vectors/sell.json"), ".timings");
        assertEq(timings.length, 1000);
        uint256[4] memory seen;
        for (uint256 i; i < timings.length; ++i) {
            Vectors.Timing memory v = Vectors.timingInput(i);
            SellLimits memory l;
            (l.headsUpHf, l.nowHf, l.headsUpDelay) = (v.headsUpHf, v.nowHf, v.headsUpDelay);
            (SellTiming t, bool atOnce) = SellRules.timing(v.hf, v.headsUpAt, v.now_, v.frozen, l);
            assertEq(uint8(t) * 2 + (atOnce ? 1 : 0), uint8(timings[i]), string.concat("vector ", vm.toString(i)));
            ++seen[uint8(t)];
        }
        for (uint256 t; t < 4; ++t) {
            assertGt(seen[t], 50, "every timing is covered");
        }
    }

    // ================================================================== timing (decision 3)

    function test_heads_up_then_a_sale_30_minutes_later_and_at_once_below_1_10() public pure {
        SellLimits memory l = _defaults();
        uint256 t0 = 1_792_000_000;
        _timing(1.2e18, 0, t0, false, l, SellTiming.HeadsUp, false);
        _timing(1.2e18, t0, t0 + 30 minutes - 1, false, l, SellTiming.Wait, false);
        _timing(1.2e18, t0, t0 + 30 minutes, false, l, SellTiming.Sell, false);
        _timing(1.09e18, 0, t0, false, l, SellTiming.Sell, true);
        _timing(1.25e18, t0, t0, false, l, SellTiming.Clear, false); // back at the line: a later fall gets a new heads-up
        _timing(1.3e18, 0, t0, false, l, SellTiming.Wait, false);
    }

    function test_nothing_while_prices_are_held_but_a_heads_up_can_clear() public pure {
        SellLimits memory l = _defaults();
        _timing(1.05e18, 0, 1, true, l, SellTiming.Wait, false);
        _timing(1.2e18, 0, 1, true, l, SellTiming.Wait, false);
        _timing(1.2e18, 1, 1 days, true, l, SellTiming.Wait, false);
        _timing(1.3e18, 1, 1 days, true, l, SellTiming.Clear, false);
    }

    // ================================================================== which stock, how much

    /// The protect-panel example (eval/protect-panel.json), at the 1.4 target Adrian picked: NVDA $4,000, AAPL $3,500,
    /// TSLA $1,500 back $5,350 of credit at 1.22, with the panel's daily limit of half of each holding. Tesla (65%)
    /// goes first, up to its limit, then NVIDIA (70%); Apple (78%) is kept.
    function test_sells_the_lowest_collateral_factor_first() public pure {
        Book memory b = _book();
        b.stocks[NVDA] = _holding(20e8, 200e8, 7_000);
        b.stocks[AAPL] = _holding(10e8, 350e8, 7_800);
        b.stocks[TSLA] = _holding(5e8, 300e8, 6_500);
        for (uint256 r; r < 7; ++r) {
            b.stocks[r].limit = b.stocks[r].shares / 2;
        }
        b.debt = 5_350e26;
        uint256[7] memory take = SellRules.amounts(b, TARGET, FLOOR, false);
        assertEq(take[TSLA], 2.5e8, "half the Tesla first: $750");
        assertGt(take[NVDA], 0, "then NVIDIA");
        assertEq(take[AAPL], 0, "Apple untouched");
        _assertReaches(b, take, TARGET);
        // $1,381 at a 1% floor; the panel's $1,367 assumed a 0.5% cost.
        assertApproxEqAbs(_value(b, take) / 1e16, 1_381, 1, "about $1,381 in all, at Aave's prices");
        // The least: a little less leaves it short of the target.
        take[NVDA] -= 10;
        assertLt(_hf(b, take, FLOOR), TARGET);
    }

    function test_a_near_tie_goes_to_the_larger_holding() public pure {
        Book memory b = _book();
        b.stocks[TSLA] = _holding(1e8, 300e8, 6_500);
        b.stocks[META] = _holding(5e8, 700e8, 6_550); // half a point higher, much larger
        b.debt = _debtAt(b, 1.2e18);
        assertLt(_rank(b, META), _rank(b, TSLA));
        b.stocks[META].cf = 6_700; // two points: no longer a tie
        assertLt(_rank(b, TSLA), _rank(b, META));
    }

    function test_a_stock_at_its_daily_limit_spills_over_to_the_next() public pure {
        Book memory b = _book();
        b.stocks[TSLA] = _holding(10e8, 300e8, 6_500);
        b.stocks[NVDA] = _holding(20e8, 200e8, 7_000);
        b.debt = _debtAt(b, 1.15e18);
        b.stocks[TSLA].limit = 0.5e8;
        uint256[7] memory take = SellRules.amounts(b, TARGET, FLOOR, false);
        assertEq(take[TSLA], 0.5e8, "Tesla up to its limit");
        assertGt(take[NVDA], 0, "the rest from NVIDIA");
        _assertReaches(b, take, TARGET);

        // The same with the pool's window for Tesla used up instead.
        b.stocks[TSLA].limit = ALL;
        b.stocks[TSLA].poolLeft = 30e6; // $30: a tenth of a share
        take = SellRules.amounts(b, TARGET, FLOOR, false);
        assertEq(take[TSLA], 0.1e8);
        _assertReaches(b, take, TARGET);
    }

    function test_a_never_sell_stock_is_kept_even_if_it_is_the_best_to_sell() public pure {
        Book memory b = _book();
        b.stocks[TSLA] = _holding(10e8, 300e8, 6_500);
        b.stocks[NVDA] = _holding(20e8, 200e8, 7_000);
        b.stocks[TSLA].limit = NONE;
        b.debt = _debtAt(b, 1.15e18);
        uint256[7] memory take = SellRules.amounts(b, TARGET, FLOOR, false);
        assertEq(take[TSLA], 0);
        _assertReaches(b, take, TARGET);
    }

    function test_keep_my_mix_sells_the_same_share_of_each() public pure {
        Book memory b = _book();
        b.stocks[TSLA] = _holding(10e8, 300e8, 6_500);
        b.stocks[NVDA] = _holding(20e8, 200e8, 7_000);
        b.stocks[AAPL] = _holding(10e8, 350e8, 7_800);
        b.debt = _debtAt(b, 1.15e18);
        uint256[7] memory take = SellRules.amounts(b, TARGET, FLOOR, true);
        uint256 share = take[TSLA] * WAD / 10e8;
        assertApproxEqAbs(take[NVDA] * WAD / 20e8, share, 1e9, "NVIDIA");
        assertApproxEqAbs(take[AAPL] * WAD / 10e8, share, 1e9, "Apple");
        _assertReaches(b, take, TARGET);
        // It costs a little more than the most safety per dollar.
        uint256[7] memory least = SellRules.amounts(b, TARGET, FLOOR, false);
        assertGt(_value(b, take), _value(b, least));
    }

    function test_the_usdc_limit_caps_the_sale() public pure {
        Book memory b = _book();
        b.stocks[NVDA] = _holding(20e8, 200e8, 7_000);
        b.debt = _debtAt(b, 1.15e18);
        b.usdcLeft = 300e6;
        uint256[7] memory take = SellRules.amounts(b, TARGET, FLOOR, false);
        Slice[] memory s = SellRules.slices(b, take, FLOOR, 5_000e6);
        uint256 repay;
        for (uint256 i; i < s.length; ++i) {
            repay += s[i].minOut;
        }
        assertLe(repay, 300e6);
        assertGt(repay, 299e6);
    }

    function test_nothing_to_sell_at_or_above_the_target() public pure {
        Book memory b = _book();
        b.stocks[NVDA] = _holding(20e8, 200e8, 7_000);
        b.debt = _debtAt(b, 1.4e18);
        uint256[7] memory take = SellRules.amounts(b, TARGET, FLOOR, false);
        assertEq(_value(b, take), 0);
    }

    // ================================================================== slices (Aave's withdrawal check)

    /// From 1.01 the sale needs more slices than one run allows; each withdrawal keeps the health above 1.001.
    function test_slices_keep_the_health_above_aaves_floor_after_each_withdrawal() public pure {
        Book memory b = _book();
        b.stocks[NVDA] = _holding(200e8, 200e8, 7_000);
        b.debt = _debtAt(b, 1.01e18);
        uint256[7] memory take = SellRules.amounts(b, TARGET, 300, false);
        Slice[] memory s = SellRules.slices(b, take, 300, 50_000e6);
        assertEq(s.length, SellRules.MAX_SLICES, "a run makes six; the rest is the next run's");
        _assertSlicesSafe(b, s);
    }

    function testFuzz_slices_are_safe_and_within_every_limit(uint256 seed) public pure {
        Vectors.Sell memory v = Vectors.sellInput(seed);
        uint256[7] memory take = SellRules.amounts(v.book, v.targetHf, v.floorBps, v.keepMix);
        uint256 repayMax;
        for (uint256 r; r < 7; ++r) {
            Holding memory h = v.book.stocks[r];
            assertLe(take[r], h.shares, "backing");
            assertLe(take[r], h.limit, "daily limit");
            assertLe(take[r] * h.price / 1e10, h.poolLeft, "pool window");
            repayMax += take[r] * h.price * (1e4 - v.floorBps) / 1e14;
        }
        assertLe(repayMax, v.book.usdcLeft + 7, "USDC limit");
        Slice[] memory s = SellRules.slices(v.book, take, v.floorBps, v.maxSlice);
        uint256[7] memory sliced;
        for (uint256 i; i < s.length; ++i) {
            sliced[s[i].reserveId] += s[i].shares;
            assertLe(s[i].shares * v.book.stocks[s[i].reserveId].price / 1e10, v.maxSlice, "slice size");
        }
        for (uint256 r; r < 7; ++r) {
            assertLe(sliced[r], take[r]);
        }
        _assertSlicesSafe(v.book, s);
    }

    /// With nothing in the way, a sale reaches the target, whatever the mix.
    function testFuzz_an_unlimited_sale_reaches_the_target(uint256 seed, bool keepMix) public pure {
        Vectors.Sell memory v = Vectors.sellInput(seed);
        for (uint256 r; r < 7; ++r) {
            (v.book.stocks[r].limit, v.book.stocks[r].poolLeft) = (ALL * 1e3, ALL * 1e3);
        }
        v.book.usdcLeft = ALL * 1e3;
        uint256 hf = SellRules.power(v.book.stocks) * 1e14 / v.book.debt;
        vm.assume(hf > 1.05e18);
        uint256[7] memory take = SellRules.amounts(v.book, v.targetHf, v.floorBps, keepMix);
        if (hf >= v.targetHf) return assertEq(_value(v.book, take), 0);
        if (_value(v.book, take) == 0) return; // nothing it may sell can lift the health that far
        bool soldAll;
        for (uint256 r; r < 7; ++r) {
            if (take[r] > 0 && take[r] == v.book.stocks[r].shares) soldAll = true;
        }
        if (!soldAll) assertGe(_hf(v.book, take, v.floorBps), v.targetHf);
    }

    function test_limits_bounds() public pure {
        assertTrue(SellRules.limitsOk(_defaults()));
        SellLimits[8] memory bad;
        for (uint256 i; i < bad.length; ++i) {
            bad[i] = _defaults(); // each its own copy
        }
        bad[0].headsUpHf = 1.51e18;
        bad[1].nowHf = 1.26e18; // above the heads-up line
        bad[2].targetHf = 1.29e18; // less than 0.05 above it
        bad[3].headsUpDelay = 5 minutes;
        bad[4].floorBps = 20;
        bad[5].actFloorBps = 501; // past Aave's 5.5% liquidation bonus, with room
        bad[6].poolCap = 999e6;
        bad[7].maxSlice = 50_001e6;
        for (uint256 i; i < bad.length; ++i) {
            assertFalse(SellRules.limitsOk(bad[i]), vm.toString(i));
        }
    }

    // ================================================================== helpers

    /// config/risk.ts PROTECT_SELL.
    function _defaults() internal pure returns (SellLimits memory) {
        return SellLimits({
            headsUpHf: 1.25e18,
            nowHf: 1.1e18,
            targetHf: 1.4e18,
            headsUpDelay: 30 minutes,
            floorBps: 100,
            actFloorBps: 300,
            poolCap: 10_000e6,
            maxSlice: 5_000e6
        });
    }

    function _timing(
        uint256 hf,
        uint256 headsUpAt,
        uint256 nowTs,
        bool frozen,
        SellLimits memory l,
        SellTiming want,
        bool wantAtOnce
    ) internal pure {
        (SellTiming t, bool atOnce) = SellRules.timing(hf, headsUpAt, nowTs, frozen, l);
        assertEq(uint8(t), uint8(want));
        assertEq(atOnce, wantAtOnce);
    }

    function _book() internal pure returns (Book memory b) {
        b.usdcPrice = 1e8;
        b.usdcLeft = ALL;
    }

    function _holding(uint256 shares, uint256 price, uint256 cf) internal pure returns (Holding memory) {
        return Holding(shares, price, cf, ALL, ALL);
    }

    function _debtAt(Book memory b, uint256 hf) internal pure returns (uint256) {
        return SellRules.power(b.stocks) * 1e14 / hf;
    }

    /// The health once `take` is sold at the floor and repaid, as Aave would count it.
    function _hf(Book memory b, uint256[7] memory take, uint256 floorBps) internal pure returns (uint256) {
        uint256 p = SellRules.power(b.stocks);
        uint256 debt = b.debt;
        for (uint256 r; r < 7; ++r) {
            Holding memory h = b.stocks[r];
            p -= h.cf * take[r] * h.price * 1e10;
            debt -= take[r] * h.price * (1e4 - floorBps) / 1e14 * b.usdcPrice * 1e12;
        }
        return p * 1e14 / debt;
    }

    function _assertReaches(Book memory b, uint256[7] memory take, uint256 target) internal pure {
        assertGe(_hf(b, take, FLOOR), target, "reaches the target");
    }

    function _assertSlicesSafe(Book memory b, Slice[] memory s) internal pure {
        uint256 p = SellRules.power(b.stocks);
        uint256 debt = b.debt;
        for (uint256 i; i < s.length; ++i) {
            Holding memory h = b.stocks[s[i].reserveId];
            p -= h.cf * s[i].shares * h.price * 1e10;
            assertGe(p * 1e14, SellRules.WITHDRAW_FLOOR_HF * debt, "health after the withdrawal");
            assertGt(s[i].minOut, 0);
            uint256 repaid = s[i].minOut * b.usdcPrice * 1e12;
            debt = repaid >= debt ? 0 : debt - repaid;
        }
    }

    /// Where reserve `r` comes in the sell order.
    function _rank(Book memory b, uint256 r) internal pure returns (uint256 k) {
        uint8[7] memory o = SellRules.order(b.stocks);
        while (o[k] != r) ++k;
    }

    function _value(Book memory b, uint256[7] memory take) internal pure returns (uint256 v) {
        for (uint256 r; r < 7; ++r) {
            v += take[r] * b.stocks[r].price;
        }
    }
}
