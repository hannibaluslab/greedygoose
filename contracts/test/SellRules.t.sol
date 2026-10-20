// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Book, Holding, SellLimits, SellRules, Slice} from "../src/SellRules.sol";
import {Vectors} from "./Vectors.sol";

/// Protect · sell's rule against the TypeScript reference (planSell and sellsNow in lib/agents/rules/protectSell.ts),
/// on the vectors scripts/agent-vectors.ts exported, plus the properties the plan asks for: ranking, the least amount,
/// spill-over at a stock's limit, never-sell, keep-my-mix, and slices that keep Aave's withdrawal check happy.
contract SellRulesTest is Test {
    uint256 constant WAD = 1e18;
    uint256 constant FLOOR = 100; // 1%
    uint256 constant TARGET = 1.2e18; // the worked examples' target (2026-10-15); `amounts` takes any target
    uint256 constant LINE = 1.03e18; // Protect's line (CashRules.TRIGGER_HF)
    uint256 constant TARGET_NOW = 1.12e18; // Protect's target (config/risk.ts CASH_AGENT)
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

    function test_timing_agrees_with_sellsNow() public view {
        bytes memory timings = vm.parseJsonBytes(vm.readFile("test/vectors/sell.json"), ".timings");
        assertEq(timings.length, 1000);
        uint256[2] memory seen;
        for (uint256 i; i < timings.length; ++i) {
            Vectors.Timing memory v = Vectors.timingInput(i);
            bool sells = SellRules.sellsNow(v.hf, v.rescuing, v.frozen, v.triggerHf, v.targetHf);
            assertEq(sells ? 1 : 0, uint8(timings[i]), string.concat("vector ", vm.toString(i)));
            ++seen[sells ? 1 : 0];
        }
        assertGt(seen[0], 200, "waits are covered");
        assertGt(seen[1], 200, "sales are covered");
    }

    // ================================================================== timing (Adrian, 2026-10-19)

    /// At once below Protect's line (1.03), with no heads-up; nothing between it and Act (1.1) or above.
    function test_sells_at_once_below_1_03_and_nothing_above() public pure {
        assertTrue(SellRules.sellsNow(1.029e18, false, false, LINE, TARGET_NOW));
        assertTrue(SellRules.sellsNow(0.98e18, false, false, LINE, TARGET_NOW));
        assertFalse(SellRules.sellsNow(1.03e18, false, false, LINE, TARGET_NOW), "the line itself waits");
        assertFalse(SellRules.sellsNow(1.08e18, false, false, LINE, TARGET_NOW), "Act is a warning only");
        assertFalse(SellRules.sellsNow(1.3e18, false, false, LINE, TARGET_NOW), "Watch");
    }

    /// A rescue Protect started goes on below the target, so it ends back at 1.12, not at the line.
    function test_a_rescue_sells_on_until_the_target() public pure {
        assertTrue(SellRules.sellsNow(1.05e18, true, false, LINE, TARGET_NOW));
        assertTrue(SellRules.sellsNow(1.119e18, true, false, LINE, TARGET_NOW));
        assertFalse(SellRules.sellsNow(1.12e18, true, false, LINE, TARGET_NOW), "the target ends it");
        assertFalse(SellRules.sellsNow(1.3e18, true, false, LINE, TARGET_NOW));
    }

    function test_nothing_while_prices_are_held() public pure {
        assertFalse(SellRules.sellsNow(0.99e18, false, true, LINE, TARGET_NOW));
        assertFalse(SellRules.sellsNow(1.05e18, true, true, LINE, TARGET_NOW));
    }

    // ================================================================== which stock, how much

    /// The protect-panel example (eval/protect-panel.json), now in Act and back to Watch at 1.2 (Act is the line,
    /// 2026-10-15): NVDA $4,000, AAPL $3,500, TSLA $1,500 back $6,200 of credit at 1.049, with the panel's daily limit
    /// of half of each holding. Tesla (65%) goes first, up to its limit, then NVIDIA (70%); Apple (78%) is kept. Back
    /// to the old 1.4 target the same sale would be $3,164, Apple included.
    function test_sells_the_lowest_collateral_factor_first() public pure {
        Book memory b = _book();
        b.stocks[NVDA] = _holding(20e8, 200e8, 7_000);
        b.stocks[AAPL] = _holding(10e8, 350e8, 7_800);
        b.stocks[TSLA] = _holding(5e8, 300e8, 6_500);
        for (uint256 r; r < 7; ++r) {
            b.stocks[r].limit = b.stocks[r].shares / 2;
        }
        b.debt = 6_200e26;
        uint256[7] memory take = SellRules.amounts(b, TARGET, FLOOR, false);
        assertEq(take[TSLA], 2.5e8, "half the Tesla first: $750");
        assertGt(take[NVDA], 0, "then NVIDIA");
        assertEq(take[AAPL], 0, "Apple untouched");
        _assertReaches(b, take, TARGET);
        assertApproxEqAbs(_value(b, take) / 1e16, 1_839, 1, "about $1,839 in all, at Aave's prices");
        // The least: a little less leaves it short of the target.
        take[NVDA] -= 10;
        assertLt(_hf(b, take, FLOOR), TARGET);
        // The old target, 1.4, would have sold far more, and Apple too.
        uint256[7] memory old = SellRules.amounts(b, 1.4e18, FLOOR, false);
        assertApproxEqAbs(_value(b, old) / 1e16, 3_164, 1, "about $3,164 to reach 1.4");
        assertGt(old[AAPL], 0);
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
        b.debt = _debtAt(b, 1.05e18);
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
        b.debt = _debtAt(b, TARGET);
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
        vm.assume(v.book.debt > 0); // one input in 2,187 backs nothing at all
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
        SellLimits[6] memory bad;
        for (uint256 i; i < bad.length; ++i) {
            bad[i] = _defaults(); // each its own copy
        }
        bad[0].floorBps = 20;
        bad[1].floorBps = 501; // past Aave's 5.5% liquidation bonus, with room
        bad[2].poolCap = 999e6;
        bad[3].poolCap = 250_001e6;
        bad[4].maxSlice = 99e6;
        bad[5].maxSlice = 50_001e6;
        for (uint256 i; i < bad.length; ++i) {
            assertFalse(SellRules.limitsOk(bad[i]), vm.toString(i));
        }
    }

    // ================================================================== helpers

    /// config/risk.ts PROTECT_SELL.
    function _defaults() internal pure returns (SellLimits memory) {
        return SellLimits({floorBps: 300, poolCap: 10_000e6, maxSlice: 5_000e6});
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
