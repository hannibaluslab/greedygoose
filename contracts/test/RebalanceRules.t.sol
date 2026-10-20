// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RebalanceBook, RebalanceHolding, RebalanceLimits, RebalanceRules, Trade} from "../src/RebalanceRules.sol";
import {Vectors} from "./Vectors.sol";

/// The Rebalancer's rules against the TypeScript reference (rebalanceTrades and planRebalance in
/// lib/agents/rules/rebalance.ts, investTrades in lib/agents/rules/topUps.ts), on the vectors scripts/agent-vectors.ts
/// exported, plus the band examples from the plan: 50/50 drifted to 56/44, 55/45, targets of 17.1% and 11.4%, and the
/// Manage board's 50/25/25; and the top-ups' buys: furthest below target first, pro rata on target.
contract RebalanceRulesTest is Test {
    uint256 constant ALL = 1e18; // a weekly limit that never binds
    uint256 constant NVDA = 5;
    uint256 constant AAPL = 0;
    uint256 constant TSLA = 6;

    function test_trades_agree_with_rebalanceTrades_and_planRebalance() public view {
        string memory json = vm.readFile("test/vectors/rebalance.json");
        bytes memory counts = vm.parseJsonBytes(json, ".counts");
        bytes memory planned = vm.parseJsonBytes(json, ".planned");
        bytes memory reserves = vm.parseJsonBytes(json, ".reserves");
        bytes memory buys = vm.parseJsonBytes(json, ".buys");
        uint256[] memory amountIns = vm.parseJsonUintArray(json, ".amountIns");
        uint256[] memory minOuts = vm.parseJsonUintArray(json, ".minOuts");
        assertEq(counts.length, 800);
        uint256 s;
        uint256 traded;
        uint256 held;
        for (uint256 i; i < counts.length; ++i) {
            Vectors.Rebalance memory v = Vectors.rebalanceInput(i);
            string memory at = string.concat("vector ", vm.toString(i));
            Trade[] memory got = RebalanceRules.trades(v.book, v.l);
            assertEq(got.length, uint8(counts[i]), at);
            bool tradable = true;
            for (uint256 k; k < got.length; ++k) {
                assertEq(got[k].reserveId, uint8(reserves[s]), at);
                assertEq(got[k].buy, uint8(buys[s]) == 1, at);
                assertEq(got[k].amountIn, amountIns[s], at);
                assertEq(got[k].minOut, minOuts[s++], at);
                if (!v.tradable[got[k].reserveId]) tradable = false;
            }
            assertEq(got.length > 0 && tradable, uint8(planned[i]) == 1, at);
            if (got.length > 0) ++traded;
            if (got.length > 0 && !tradable) ++held;
        }
        assertEq(s, amountIns.length, "every trade compared");
        assertGt(traded, 250, "most vectors trade");
        assertGt(held, 30, "a pool out of line holds some");
    }

    /// Every trade set the rule returns: the buys spend no more than the sales' minimums bring in, and within the USDC
    /// limit; a sale never exceeds the stock's weekly limit; a stock is only sold or only bought; only mix stocks trade.
    function test_never_spends_cash_and_stays_within_every_limit() public pure {
        for (uint256 i; i < 800; ++i) {
            Vectors.Rebalance memory v = Vectors.rebalanceInput(i);
            Trade[] memory got = RebalanceRules.trades(v.book, v.l);
            uint256 cashIn;
            uint256 cashOut;
            bool[7] memory seen;
            for (uint256 k; k < got.length; ++k) {
                Trade memory t = got[k];
                RebalanceHolding memory h = v.book.stocks[t.reserveId];
                assertGt(h.weight, 0, "only the mix");
                assertFalse(seen[t.reserveId], "one trade a stock");
                seen[t.reserveId] = true;
                if (t.buy) {
                    cashOut += t.amountIn;
                } else {
                    cashIn += t.minOut;
                    assertLe(t.amountIn, h.sellLeft, "within the weekly limit");
                    assertLe(t.amountIn, h.shares, "free stock only");
                }
            }
            assertLe(cashOut, cashIn, "the sales pay for the buys");
            assertLe(cashOut, v.book.usdcLeft, "within the USDC limit");
            if (got.length > 0) assertGt(cashOut, 0, "never sells to cash alone");
        }
    }

    // ================================================================== top-ups into the mix

    function test_invest_agrees_with_investTrades() public view {
        string memory json = vm.readFile("test/vectors/invest.json");
        bytes memory counts = vm.parseJsonBytes(json, ".counts");
        bytes memory reserves = vm.parseJsonBytes(json, ".reserves");
        uint256[] memory amountIns = vm.parseJsonUintArray(json, ".amountIns");
        uint256[] memory minOuts = vm.parseJsonUintArray(json, ".minOuts");
        assertEq(counts.length, 600);
        uint256 s;
        uint256 bought;
        uint256 several;
        for (uint256 i; i < counts.length; ++i) {
            Vectors.Invest memory v = Vectors.investInput(i);
            string memory at = string.concat("vector ", vm.toString(i));
            Trade[] memory got = RebalanceRules.invest(v.book, v.amount, v.l);
            assertEq(got.length, uint8(counts[i]), at);
            for (uint256 k; k < got.length; ++k) {
                assertEq(got[k].reserveId, uint8(reserves[s]), at);
                assertTrue(got[k].buy, at);
                assertEq(got[k].amountIn, amountIns[s], at);
                assertEq(got[k].minOut, minOuts[s++], at);
            }
            if (got.length > 0) ++bought;
            if (got.length > 2) ++several;
        }
        assertEq(s, amountIns.length, "every buy compared");
        assertGt(bought, 300, "most vectors buy");
        assertGt(several, 50, "and many buy several stocks");
    }

    /// Every buy set: only buys, only mix stocks, one a stock, each at least the minimum, at most a slice and never past
    /// its target with the top-up in; together never more than the amount.
    function test_invest_only_buys_within_the_amount_and_never_past_a_target() public pure {
        for (uint256 i; i < 600; ++i) {
            Vectors.Invest memory v = Vectors.investInput(i);
            Trade[] memory got = RebalanceRules.invest(v.book, v.amount, v.l);
            uint256 total = v.amount;
            for (uint256 r; r < 7; ++r) {
                if (v.book.stocks[r].weight > 0) total += _worth(v.book.stocks[r]);
            }
            uint256 spent;
            bool[7] memory seen;
            for (uint256 k; k < got.length; ++k) {
                Trade memory t = got[k];
                RebalanceHolding memory h = v.book.stocks[t.reserveId];
                assertTrue(t.buy, "never sells");
                assertGt(h.weight, 0, "only the mix");
                assertFalse(seen[t.reserveId], "one buy a stock");
                seen[t.reserveId] = true;
                assertGe(t.amountIn, v.l.minTrade, "worth a trade");
                assertLe(t.amountIn, v.l.maxSlice, "a slice at most");
                assertLe(_worth(h) + t.amountIn, total * h.weight / 1e4, "never past its target");
                spent += t.amountIn;
            }
            assertLe(spent, v.amount, "within the amount");
        }
    }

    /// 50/25/25 NVIDIA/Apple/Tesla at $5,000 / $3,000 / $2,000 and a $1,000 top-up: the targets with it in are $5,500,
    /// $2,750 and $2,750. Tesla is furthest below ($750) and gets it first; NVIDIA the $250 left; Apple, over, nothing.
    function test_a_top_up_buys_the_stock_furthest_below_its_target_first() public pure {
        RebalanceBook memory b = _book();
        b.stocks[NVDA] = _holding(5_000e6, 200e8, 5_000);
        b.stocks[AAPL] = _holding(3_000e6, 250e8, 2_500);
        b.stocks[TSLA] = _holding(2_000e6, 400e8, 2_500);
        Trade[] memory t = RebalanceRules.invest(b, 1_000e6, _limits());
        assertEq(t.length, 2);
        assertEq(abi.encode(t[0].reserveId, t[0].amountIn), abi.encode(uint8(NVDA), uint256(250e6)));
        assertEq(abi.encode(t[1].reserveId, t[1].amountIn), abi.encode(uint8(TSLA), uint256(750e6)));
        assertEq(t[1].minOut, uint256(750e6) * 1e10 * 9_950 / (400e8 * 1e4), "Aave's price less the floor");

        // $100: all of it to Tesla, never past its target, nothing left over.
        t = RebalanceRules.invest(b, 100e6, _limits());
        assertEq(t.length, 1);
        assertEq(abi.encode(t[0].reserveId, t[0].amountIn), abi.encode(uint8(TSLA), uint256(100e6)));
    }

    /// On target, a top-up buys pro rata to the mix; into a mix that holds nothing yet, too.
    function test_on_target_or_empty_a_top_up_buys_pro_rata() public pure {
        RebalanceBook memory b = _book();
        b.stocks[NVDA] = _holding(5_000e6, 200e8, 5_000);
        b.stocks[AAPL] = _holding(2_500e6, 250e8, 2_500);
        b.stocks[TSLA] = _holding(2_500e6, 300e8, 2_500);
        Trade[] memory t = RebalanceRules.invest(b, 1_000e6, _limits());
        assertEq(t.length, 3);
        assertApproxEqAbs(t[0].amountIn, 250e6, 1, "Apple 25%");
        assertApproxEqAbs(t[1].amountIn, 500e6, 1, "NVIDIA 50%");
        assertApproxEqAbs(t[2].amountIn, 250e6, 1, "Tesla 25%");

        RebalanceBook memory empty = _book();
        empty.stocks[NVDA] = _holding(0, 200e8, 5_000);
        empty.stocks[AAPL] = _holding(0, 250e8, 5_000);
        t = RebalanceRules.invest(empty, 300e6, _limits());
        assertEq(abi.encode(t[0].amountIn, t[1].amountIn), abi.encode(uint256(150e6), uint256(150e6)));
    }

    /// A buy is at most a slice ($25k): $60k into one stock buys $25k today and leaves the rest waiting. Legs under the
    /// minimum ($20) wait too: $100 over seven stocks on target ($14 each) buys nothing yet, $150 ($21 each) all seven.
    function test_a_top_up_waits_for_what_a_slice_or_the_minimum_leaves() public pure {
        RebalanceBook memory b = _book();
        b.stocks[NVDA] = _holding(0, 200e8, 10_000);
        Trade[] memory t = RebalanceRules.invest(b, 60_000e6, _limits());
        assertEq(t.length, 1);
        assertEq(t[0].amountIn, 25_000e6);

        b = _book();
        for (uint256 r; r < 7; ++r) {
            uint256 w = r < 6 ? 1_430 : 1_420;
            b.stocks[r] = _holding(7_000e6 * w / 1e4, 100e8, w);
        }
        assertEq(RebalanceRules.invest(b, 100e6, _limits()).length, 0, "$14 a stock: under $20");
        assertEq(RebalanceRules.invest(b, 150e6, _limits()).length, 7, "$21 a stock");
    }

    function _worth(RebalanceHolding memory h) internal pure returns (uint256) {
        return h.shares * h.price / 1e10;
    }

    // ================================================================== the band examples (plan item 9 step 3)

    /// The plan's fork example: a 50/50 NVIDIA/Apple mix drifted to 56/44 comes back to about 52.5/47.5 in one batch,
    /// the USDC netting to zero. The band is 5 points (20% of 50 is 10, so 5 binds).
    function test_50_50_drifted_to_56_44_comes_back_to_52_5_47_5() public pure {
        RebalanceBook memory b = _book();
        b.stocks[NVDA] = _holding(5_600e6, 200e8, 5_000);
        b.stocks[AAPL] = _holding(4_400e6, 250e8, 5_000);
        Trade[] memory t = RebalanceRules.trades(b, _limits());
        assertEq(t.length, 2);
        assertEq(t[0].reserveId, NVDA);
        assertFalse(t[0].buy);
        assertEq(t[0].amountIn * 200e8 / 1e10, 350e6, "sells $350 of NVIDIA: 56% to 52.5%");
        assertEq(t[1].reserveId, AAPL);
        assertTrue(t[1].buy);
        assertEq(t[1].amountIn, t[0].minOut, "buys Apple with exactly what the sale's minimum brings in");
        assertApproxEqAbs(t[1].amountIn, 350e6, 2e6, "about $350: 44% to 47.5%");
    }

    /// 55/45: bands of 5 points both ways. 59/41 is inside (55 + 5 = 60), 61/39 breaks out and goes back to 57.5/42.5.
    function test_55_45_holds_inside_the_band_and_trades_back_to_half_of_it() public pure {
        RebalanceBook memory b = _book();
        b.stocks[NVDA] = _holding(5_900e6, 200e8, 5_500);
        b.stocks[AAPL] = _holding(4_100e6, 250e8, 4_500);
        assertEq(RebalanceRules.trades(b, _limits()).length, 0, "59/41 is inside the band");
        b.stocks[NVDA] = _holding(6_100e6, 200e8, 5_500);
        b.stocks[AAPL] = _holding(3_900e6, 250e8, 4_500);
        Trade[] memory t = RebalanceRules.trades(b, _limits());
        assertEq(t[0].amountIn * 200e8 / 1e10, 350e6, "61% to 57.5%");
    }

    /// Small targets: 20% of the target binds before 5 points. 17.1% has a band of 3.42 points, 11.4% one of 2.28.
    function test_a_small_target_has_a_band_of_a_fifth_of_it() public pure {
        RebalanceBook memory b = _book();
        b.stocks[NVDA] = _holding(2_052e6, 200e8, 1_710); // 20.52%: on the edge, inside
        b.stocks[AAPL] = _holding(1_140e6, 250e8, 1_140); // 11.4%: on target
        b.stocks[TSLA] = _holding(6_808e6, 250e8, 7_150);
        assertEq(RebalanceRules.trades(b, _limits()).length, 0, "17.1 + 3.42 = 20.52 is still inside");
        b.stocks[NVDA] = _holding(2_100e6, 200e8, 1_710); // 21%: out
        b.stocks[TSLA] = _holding(6_760e6, 250e8, 7_150);
        Trade[] memory t = RebalanceRules.trades(b, _limits());
        assertEq(t[0].reserveId, NVDA);
        assertApproxEqAbs(t[0].amountIn * 200e8 / 1e10, 219e6, 1e6, "back to 17.1 + 1.71 = 18.81%");

        // Apple at 9.0% is under 11.4 − 2.28 = 9.12: it breaks out too and goes back to 10.26%.
        b.stocks[NVDA] = _holding(1_710e6, 200e8, 1_710);
        b.stocks[AAPL] = _holding(900e6, 250e8, 1_140);
        b.stocks[TSLA] = _holding(7_390e6, 250e8, 7_150);
        t = RebalanceRules.trades(b, _limits());
        assertTrue(t[t.length - 1].buy);
        assertEq(t[t.length - 1].reserveId, AAPL);
        assertApproxEqAbs(t[t.length - 1].amountIn, 126e6, 2e6, "9.0% to 10.26%");
    }

    /// The Manage board's 50/25/25 NVIDIA/Apple/Tesla mix, at 43/27/30. Only NVIDIA broke out (45 is its floor); it is
    /// bought back to 47.5%, paid for by Tesla, the furthest above its target (30 is the top of its band, still in).
    function test_only_the_stock_that_broke_out_and_the_other_side_from_the_furthest_off() public pure {
        RebalanceBook memory b = _book();
        b.stocks[NVDA] = _holding(4_300e6, 200e8, 5_000);
        b.stocks[AAPL] = _holding(2_700e6, 250e8, 2_500);
        b.stocks[TSLA] = _holding(3_000e6, 300e8, 2_500);
        Trade[] memory t = RebalanceRules.trades(b, _limits());
        assertEq(t.length, 2, "Apple stays put");
        assertEq(t[0].reserveId, TSLA);
        assertFalse(t[0].buy);
        assertEq(t[0].amountIn * 300e8 / 1e10, 450e6, "47.5% less 43%: $450 of Tesla");
        assertEq(t[1].reserveId, NVDA);
        assertTrue(t[1].buy);
    }

    // ================================================================== the skips

    function test_a_used_up_weekly_limit_and_trades_under_20_dollars_skip() public pure {
        RebalanceBook memory b = _book();
        b.stocks[NVDA] = _holding(5_600e6, 200e8, 5_000);
        b.stocks[AAPL] = _holding(4_400e6, 250e8, 5_000);
        b.stocks[NVDA].sellLeft = 0;
        assertEq(RebalanceRules.trades(b, _limits()).length, 0, "NVIDIA can't be sold this week, Apple isn't over");

        b.stocks[NVDA].sellLeft = ALL;
        b.usdcLeft = 0;
        assertEq(RebalanceRules.trades(b, _limits()).length, 0, "no USDC left for the buy: no sale to cash either");

        b = _book();
        b.stocks[NVDA] = _holding(336e6, 200e8, 5_000); // 56% of $600: $21 to move
        b.stocks[AAPL] = _holding(264e6, 250e8, 5_000);
        assertEq(RebalanceRules.trades(b, _limits()).length, 2, "$21 is worth it");
        b.stocks[NVDA] = _holding(280e6, 200e8, 5_000); // 56% of $500: $17.50
        b.stocks[AAPL] = _holding(220e6, 250e8, 5_000);
        assertEq(RebalanceRules.trades(b, _limits()).length, 0, "$17.50 isn't");
    }

    function test_a_slice_is_at_most_25k_and_free_stock_outside_the_mix_is_ignored() public pure {
        RebalanceBook memory b = _book();
        b.stocks[NVDA] = _holding(1_400_000e6, 200e8, 5_000); // 70% of $2M
        b.stocks[AAPL] = _holding(600_000e6, 250e8, 5_000);
        b.stocks[TSLA] = _holding(50_000e6, 300e8, 0); // not in the mix
        Trade[] memory t = RebalanceRules.trades(b, _limits());
        assertEq(t.length, 2);
        assertEq(t[0].amountIn * 200e8 / 1e10, 25_000e6, "one $25k slice today, the rest on the next days");
    }

    function test_pool_in_line_within_the_gap() public pure {
        assertTrue(RebalanceRules.poolInLine(100.5e8, 100e8, 50));
        assertTrue(RebalanceRules.poolInLine(99.5e8, 100e8, 50));
        assertFalse(RebalanceRules.poolInLine(100.51e8, 100e8, 50));
        assertFalse(RebalanceRules.poolInLine(99.49e8, 100e8, 50));
    }

    function test_the_mix_must_add_up() public pure {
        (uint256 mix, bool ok) = RebalanceRules.pack([uint16(5_000), 0, 0, 0, 0, 5_000, 0]);
        assertTrue(ok);
        assertEq(RebalanceRules.weight(mix, 0), 5_000);
        assertEq(RebalanceRules.weight(mix, 5), 5_000);
        (, ok) = RebalanceRules.pack([uint16(5_000), 0, 0, 0, 0, 4_999, 0]);
        assertFalse(ok);
        (mix, ok) = RebalanceRules.pack([uint16(0), 0, 0, 0, 0, 0, 0]);
        assertTrue(ok, "all 0 clears it");
        assertEq(mix, 0);
    }

    function test_limit_bounds() public pure {
        RebalanceLimits memory l = _limits();
        assertTrue(RebalanceRules.limitsOk(l));
        l.floorBps = 301;
        assertFalse(RebalanceRules.limitsOk(l));
        l = _limits();
        l.minTrade = 26_000e6;
        assertFalse(RebalanceRules.limitsOk(l), "the minimum trade under the slice");
        l = _limits();
        l.bandMaxBps = 99;
        assertFalse(RebalanceRules.limitsOk(l));
    }

    // ================================================================== helpers

    /// config/risk.ts REBALANCER.
    function _limits() internal pure returns (RebalanceLimits memory) {
        return RebalanceLimits({
            bandBps: 2_000, bandMaxBps: 500, poolGapBps: 50, floorBps: 50, minTrade: 20e6, maxSlice: 25_000e6
        });
    }

    function _book() internal pure returns (RebalanceBook memory b) {
        b.usdcLeft = 1e15;
    }

    /// `valueRaw` USDC units of a stock at `price`, with a weekly limit that never binds.
    function _holding(uint256 valueRaw, uint256 price, uint256 weight) internal pure returns (RebalanceHolding memory) {
        return RebalanceHolding(valueRaw * 1e10 / price, price, weight, ALL);
    }
}
