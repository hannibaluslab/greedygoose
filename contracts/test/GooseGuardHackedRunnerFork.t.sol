// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GuardForkBase} from "./GuardForkBase.sol";

/// Build step 7 (spec-final-v2.md §14, item 4): the hacked-runner suite. Every §12 row a runner (or a wrong Planner) can
/// reach is sent as raw performData from KeeperHub's address, the way a stolen KeeperHub key would send it. Each case
/// asserts the move is refused with the right reason, the victim's money doesn't move, and the perform itself doesn't
/// revert (a reverted write loses KeeperHub's round). Positive controls show the same position does move when the
/// move is honest. Victims are backed by one or two stocks, so every honest move fits today's gas caps.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardHackedRunnerForkTest -vv
contract GooseGuardHackedRunnerForkTest is GuardForkBase {
    address attacker = makeAddr("attacker");

    function setUp() public {
        _setUpGuard();
    }

    // ================================================================== fixtures

    /// A victim backed by `usd` of each stock in `mask`, drawn to `hf`, with the credit's cash in savings and $50 in
    /// the wallet, every agent on.
    function _victim(string memory name, uint256 mask, uint256 usd, uint256 hf) internal returns (address a) {
        a = _newJawAccount(name);
        _backMask(a, mask, usd);
        _drawTo(a, hf);
        uint256 cash = _bal(address(USDC), a);
        _save(a, cash - 50e6);
        _allOn(a);
    }

    /// Sends one move from KeeperHub as raw performData and asserts it was refused for `want`, nothing of the victim's
    /// moved, nothing reached the attacker or stayed with the Guard, and the perform didn't revert. Returns its gas.
    function _refused(address a, uint8 kind, uint256[] memory args, bytes4 want) internal returns (uint256) {
        return _refusedRaw(a, _one(a, kind, args), want);
    }

    function _refusedRaw(address a, bytes memory performData, bytes4 want) internal returns (uint256 gasUsed) {
        Holdings memory h = _holdings(a);
        Vm.Log[] memory logs;
        (gasUsed, logs) = _perform(performData);
        bytes4 got = _reason(logs, a);
        if (got != want) {
            console2.log("refused with:");
            console2.logBytes4(got);
        }
        assertEq(got, want, "not refused for the expected reason");
        _assertUnchanged(a, h);
        _assertNothingLeaked();
    }

    /// The attacker got nothing and the Guard holds nothing.
    function _assertNothingLeaked() internal view {
        address[2] memory who = [attacker, address(g)];
        for (uint256 w; w < 2; ++w) {
            assertEq(_bal(address(USDC), who[w]), 0, "USDC leaked");
            assertEq(_bal(address(AUSDC), who[w]), 0, "savings leaked");
            for (uint256 r; r < 7; ++r) {
                assertEq(_bal(STOCKS[r], who[w]), 0, "stock leaked");
            }
        }
    }

    /// `n` equal slices of stock r, each `bps` of the debt.
    function _slices(address a, uint256 r, uint256 n, uint256 bps) internal view returns (uint256[] memory legs) {
        legs = new uint256[](n);
        uint256 s = _slice(a, r, bps);
        for (uint256 i; i < n; ++i) {
            legs[i] = _leg(r, s);
        }
    }

    // ================================================================== pay someone else

    /// performData carries no address but the account's. An address smuggled into a sale or trade leg's unused bits is
    /// refused (BadArgs); one appended after the moves is ignored, and the honest repay it rides with pays only the
    /// victim's own credit.
    function test_paying_someone_else_is_impossible() public {
        address a = _victim("victim", 1 << NVDA, 4_000e6, 1.02e18);
        uint256 smuggled = (uint256(uint160(attacker)) & type(uint120).max) << 128;
        _refused(a, SELL, _a1(NVDA << 248 | smuggled | 1e6), GooseGuard.BadArgs.selector);

        uint16[7] memory w;
        w[AAPL] = 5000;
        w[NVDA] = 5000;
        vm.prank(a);
        g.setMix(_pack(w));
        deal(STOCKS[AAPL], a, _sharesFor(AAPL, 1_500e6));
        _refused(a, TRADE, _a2(0, AAPL << 248 | smuggled | 1e6), GooseGuard.BadArgs.selector);

        // Trailing bytes naming the attacker: decoding ignores them, and the repay pays the victim's own credit.
        uint256 repay = _repayTo(a, 1.10e18);
        bytes memory performData =
            bytes.concat(_one(a, REPAY, _a2(0, repay)), abi.encode(attacker, attacker, uint256(uint160(attacker))));
        uint256 debt = _debt(a);
        uint256 savings = _bal(address(AUSDC), a);
        (, Vm.Log[] memory logs) = _perform(performData);
        assertEq(_reason(logs, a), bytes4(0), "the honest repay was refused");
        assertApproxEqAbs(debt - _debt(a), repay, 2, "the repay didn't pay the victim's credit");
        assertApproxEqAbs(savings - _bal(address(AUSDC), a), repay, 2, "savings didn't pay it");
        _assertNothingLeaked();
    }

    // ================================================================== the gate

    function test_a_repay_while_healthy_is_refused() public {
        address a = _victim("healthy", 1 << NVDA, 4_000e6, 1.5e18);
        _refused(a, REPAY, _a2(10e6, 100e6), GooseGuard.NotNeeded.selector);
    }

    function test_a_sale_while_healthy_is_refused() public {
        address a = _victim("healthy", 1 << NVDA, 4_000e6, 1.5e18);
        _refused(a, SELL, _slices(a, NVDA, 1, 100), GooseGuard.NotNeeded.selector);
    }

    /// Just above the line (1.03) with no rescue on, still refused.
    function test_a_repay_just_above_the_line_is_refused() public {
        address a = _victim("line", 1 << NVDA, 4_000e6, 1.035e18);
        _refused(a, REPAY, _a2(0, 10e6), GooseGuard.NotNeeded.selector);
    }

    // ================================================================== overshoot and payoff

    /// A repay sized to land at 1.15, past the target plus 0.01 (1.13), is refused; one to 1.12 runs.
    function test_a_repay_past_the_target_is_refused() public {
        address a = _victim("over", 1 << NVDA, 4_000e6, 1.02e18);
        _refused(a, REPAY, _a2(0, _repayTo(a, 1.15e18)), GooseGuard.Overshoot.selector);
        assertEq(_send(a, REPAY, _a2(0, _repayTo(a, 1.12e18))), bytes4(0), "the honest repay was refused");
        assertApproxEqAbs(_hf(a), 1.12e18, 0.002e18, "not at the target");
    }

    /// A sale that would lift health past 1.13 is refused. The victim is in a rescue at 1.10 (a repay landed short of
    /// 1.12), so a sale may run above the line, and two slices of AAPLc would land past 1.13.
    function test_a_sale_past_the_target_is_refused() public {
        address a = _victim("oversell", 1 << AAPL | 1 << NVDA, 4_000e6, 1.02e18);
        assertEq(_send(a, REPAY, _a2(0, _repayTo(a, 1.10e18))), bytes4(0), "the repay that starts the rescue");
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        assertGt(acc.rescueAt, 0, "no rescue");
        _refused(a, SELL, _a2(_leg(AAPL, _slice(a, AAPL, 700)), _leg(AAPL, _slice(a, AAPL, 700))), GooseGuard.Overshoot.selector);
        // A small one lands under 1.13 and runs.
        assertEq(_send(a, SELL, _a1(_leg(AAPL, _slice(a, AAPL, 200)))), bytes4(0), "the honest sale was refused");
    }

    /// Paying off the whole credit from savings is refused while what's left at the ceiling (power / 1.13) is above
    /// DUST ($1).
    function test_a_full_payoff_above_dust_is_refused() public {
        address a = _victim("payoff", 1 << NVDA, 4_000e6, 1.02e18);
        deal(address(USDC), a, 100e6);
        _save(a, 99e6);
        uint256 debt = _debt(a);
        assertGe(_bal(address(AUSDC), a), debt, "savings can't pay it all");
        _refused(a, REPAY, _a2(0, debt + 1e6), GooseGuard.PaidOff.selector);
    }

    /// The fuel tank: a repay asked to take the whole wallet leaves exactly $1 there.
    function test_a_repay_keeps_a_dollar_in_the_wallet() public {
        address a = _victim("tank", 1 << NVDA, 4_000e6, 1.02e18);
        uint256 repay = _repayTo(a, 1.10e18);
        deal(address(USDC), a, 50e6);
        assertEq(_send(a, REPAY, _a2(type(uint128).max, repay - 49e6)), bytes4(0), "the repay was refused");
        assertEq(_bal(address(USDC), a), 1e6, "the dollar didn't stay");
    }

    // ================================================================== what may be sold

    /// The victim's NVDAc backing is small and AAPLc backs the rest; a free NVDAc share sits in the wallet. A sale leg
    /// asking for more NVDAc than backs the credit withdraws only what's there (step0-facts.md, fact 3), so the swap
    /// would take the free share: refused (StockMoved).
    function test_selling_free_stock_from_the_wallet_is_refused() public {
        address a = _newJawAccount("free");
        _backUsd(a, AAPL, 6_000e6);
        uint256 backing = _backUsd(a, NVDA, 50e6); // small enough that withdrawing it all keeps health above 1
        _drawTo(a, 1.02e18);
        _save(a, _bal(address(USDC), a) - 50e6);
        _allOn(a);
        deal(NVDAC, a, 1e8); // a free share in the wallet
        _refused(a, SELL, _a1(_leg(NVDA, backing + 0.2e8)), GooseGuard.StockMoved.selector);
        assertEq(_bal(NVDAC, a), 1e8, "the free share went");
    }

    /// Stock in the wallet that doesn't back the credit, and stock supplied with its collateral flag off: neither may
    /// be sold (NotCollateral).
    function test_selling_stock_that_doesnt_back_the_credit_is_refused() public {
        address a = _victim("notbacking", 1 << NVDA, 4_000e6, 1.02e18);
        deal(STOCKS[AAPL], a, 2e8);
        _refused(a, SELL, _a1(_leg(AAPL, 1e8)), GooseGuard.NotCollateral.selector);

        uint256 shares = _sharesFor(TSLA, 1_000e6);
        deal(STOCKS[TSLA], a, shares);
        vm.startPrank(a);
        IERC20Like(STOCKS[TSLA]).approve(address(SPOKE), shares);
        SPOKE.supply(TSLA, shares, a);
        vm.stopPrank();
        (bool collateral,) = SPOKE.getUserReserveStatus(TSLA, a);
        assertFalse(collateral, "TSLAc backs the credit");
        _refused(a, SELL, _a1(_leg(TSLA, shares / 2)), GooseGuard.NotCollateral.selector);
    }

    /// A Protect · sell permission that never approved AAPLc: the manager refuses the batch (UnauthorizedCall).
    function test_selling_a_stock_the_permission_never_approved_is_refused() public {
        address a = _newJawAccount("narrow");
        _backUsd(a, AAPL, 3_000e6);
        _backUsd(a, NVDA, 3_000e6);
        _drawTo(a, 1.025e18);
        _on(a, JOB_SELL, _sellP(a, 1 << NVDA));
        _refused(a, SELL, _a1(_leg(AAPL, _slice(a, AAPL, 200))), UNAUTHORIZED_CALL);
        // The approved stock sells.
        assertEq(_send(a, SELL, _a1(_leg(NVDA, _slice(a, NVDA, 200)))), bytes4(0), "the approved stock didn't sell");
    }

    // ================================================================== the band

    /// The stale-oracle sandwich: the pool sits 1.5% above Aave's price (Aave's price stale or wrong), so a sale with
    /// its floor on Aave's price could be sandwiched down to that floor. Refused (OffBand). The same 1.5% under too.
    function test_the_stale_oracle_sandwich_is_refused() public {
        address a = _victim("sandwich", 1 << NVDA, 4_000e6, 1.025e18);
        uint256[] memory legs = _slices(a, NVDA, 2, 250);
        uint256 snap = vm.snapshotState();
        _nudge(NVDA, 150);
        assertGt(_offBps(NVDA), 100, "the pool isn't 1% over");
        _refused(a, SELL, legs, GooseGuard.OffBand.selector);
        vm.revertToState(snap);
        _nudge(NVDA, -150);
        assertLt(_offBps(NVDA), -100, "the pool isn't 1% under");
        _refused(a, SELL, legs, GooseGuard.OffBand.selector);
    }

    /// A pool nudged 0.9% either way still fills; nudged 1.1% it is refused before the manager is called, cheaply.
    function test_a_pool_nudged_0_9_percent_fills_and_1_1_percent_is_refused_cheaply() public {
        address a = _victim("nudge", 1 << NVDA, 4_000e6, 1.025e18);
        uint256[] memory legs = _slices(a, NVDA, 2, 250);
        int256[4] memory bps = [int256(-90), 90, -110, 110];
        for (uint256 i; i < 4; ++i) {
            uint256 snap = vm.snapshotState();
            _nudge(NVDA, bps[i]);
            int256 off = _offBps(NVDA);
            if (i < 2) {
                assertLt(off < 0 ? -off : off, 100, "nudged past 1%");
                (bytes4 reason, uint256 used) = _sendGas(a, SELL, legs);
                console2.log("nudged (bps), sale gas:");
                console2.logInt(off);
                console2.log(used);
                assertEq(reason, bytes4(0), "a sale within the band was refused");
            } else {
                assertGt(off < 0 ? -off : off, 100, "not nudged past 1%");
                uint256 used = _refused(a, SELL, legs, GooseGuard.OffBand.selector);
                console2.log("nudged (bps), refusal gas (the perform's execution, no intrinsic):");
                console2.logInt(off);
                console2.log(used);
            }
            vm.revertToState(snap);
        }
        // The band is checked after the gate's health reading, so the refusal's cost grows with the collaterals read:
        // the same refusal for an account backed by all seven stocks.
        address b = _victim("nudge7", ALL_STOCKS, 2_000e6, 1.025e18);
        _nudge(NVDA, -110);
        uint256 used7 = _refused(b, SELL, _slices(b, NVDA, 2, 250), GooseGuard.OffBand.selector);
        console2.log("refusal gas, 7-stock account:", used7);
    }

    /// The Rebalance band's tight side, 0.40% (SWAP_FLOOR − fee − 5 bps): a trade sale with the pool 0.5% under Aave is
    /// refused cheaply; at 0.3% under it is allowed through to the swap.
    function test_a_rebalance_sale_with_the_pool_past_the_tight_side_is_refused() public {
        address a = _mixer("tight");
        uint256[] memory args = _a2(0, _leg(AAPL, _sharesFor(AAPL, 200e6)));
        uint256 snap = vm.snapshotState();
        _nudge(AAPL, -50);
        _refused(a, TRADE, args, GooseGuard.OffBand.selector);
        vm.revertToState(snap);
        _nudge(AAPL, -30);
        bytes4 reason = _send(a, TRADE, args);
        console2.log("rebalance sale with the pool 0.3% under: reason");
        console2.logBytes4(reason);
        assertTrue(reason != GooseGuard.OffBand.selector, "refused by the band inside the tight side");
    }

    // ================================================================== TRADE

    /// A 50/50 AAPLc/NVDAc mix drifted to $1,500 / $500 of free stock, Rebalance on.
    function _mixer(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        _rebalanceOn(a);
        uint16[7] memory w;
        w[AAPL] = 5000;
        w[NVDA] = 5000;
        vm.prank(a);
        g.setMix(_pack(w));
        deal(STOCKS[AAPL], a, _sharesFor(AAPL, 1_500e6));
        deal(NVDAC, a, _sharesFor(NVDA, 500e6));
        vm.warp(vm.getBlockTimestamp() + 1);
    }

    function test_trading_a_stock_outside_the_mix_is_refused() public {
        address a = _mixer("weight0");
        deal(STOCKS[TSLA], a, _sharesFor(TSLA, 1_000e6));
        _refused(a, TRADE, _a2(0, _leg(TSLA, _sharesFor(TSLA, 500e6))), GooseGuard.NotInMix.selector);
        _refused(a, TRADE, _a2(0, _buy(TSLA, 100e6)), GooseGuard.NotInMix.selector);
    }

    /// AAPLc is $500 over its target: a sale of $600 would cross it.
    function test_a_trade_crossing_the_target_is_refused() public {
        address a = _mixer("cross");
        _refused(a, TRADE, _a2(0, _leg(AAPL, _sharesFor(AAPL, 600e6))), GooseGuard.Crossed.selector);
        // NVDAc is under target: selling it moves away from it.
        _refused(a, TRADE, _a2(0, _leg(NVDA, _sharesFor(NVDA, 10e6))), GooseGuard.Crossed.selector);
        // Each stock trades once in a move.
        _refused(a, TRADE, _a3(0, _leg(AAPL, _sharesFor(AAPL, 100e6)), _buy(AAPL, 50e6)), GooseGuard.BadArgs.selector);
        // A top-up buying AAPLc, already over its target, crosses too.
        vm.prank(a);
        g.setTopUps(true, 0);
        deal(address(USDC), a, 101e6);
        _refused(a, TRADE, _a2(100e6, _buy(AAPL, 50e6)), GooseGuard.Crossed.selector);
        // Within the drift it runs.
        assertEq(_send(a, TRADE, _a2(0, _leg(AAPL, _sharesFor(AAPL, 400e6)))), bytes4(0), "the honest sale was refused");
    }

    function test_a_sale_after_a_buy_is_refused() public {
        address a = _mixer("order");
        deal(address(USDC), a, 101e6);
        vm.prank(a);
        g.setTopUps(true, 0);
        _refused(
            a, TRADE, _a3(100e6, _buy(NVDA, 100e6), _leg(AAPL, _sharesFor(AAPL, 100e6))), GooseGuard.BadArgs.selector
        );
        _refused(a, TRADE, _a3(0, _buy(NVDA, 50e6), _leg(AAPL, _sharesFor(AAPL, 100e6))), GooseGuard.CashOut.selector);
    }

    /// Buys may spend only the sales' floors (plus a top-up): $200 of buys after a $100 sale is refused.
    function test_buys_over_the_available_cash_are_refused() public {
        address a = _mixer("cashout");
        deal(address(USDC), a, 10_000e6); // wallet cash isn't the trade's to spend
        _refused(a, TRADE, _a3(0, _leg(AAPL, _sharesFor(AAPL, 100e6)), _buy(NVDA, 200e6)), GooseGuard.CashOut.selector);
        _refused(a, TRADE, _a2(0, _buy(NVDA, 1e6)), GooseGuard.CashOut.selector);
    }

    /// A top-up with top-ups off.
    function test_a_top_up_with_top_ups_off_is_refused() public {
        address a = _mixer("off");
        deal(address(USDC), a, 1_001e6);
        _refused(a, TRADE, _a2(500e6, _buy(NVDA, 400e6)), GooseGuard.NotTopUp.selector);
    }

    /// A top-up during a rescue: Protect may need that cash.
    function test_a_top_up_during_a_rescue_is_refused() public {
        address a = _victim("rescue", 1 << NVDA, 4_000e6, 1.02e18);
        assertEq(_send(a, REPAY, _a2(0, _repayTo(a, 1.06e18))), bytes4(0), "the repay that starts the rescue");
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        assertGt(acc.rescueAt, 0, "no rescue");
        _mixOn(a);
        _refused(a, TRADE, _a2(500e6, _buy(AAPL, 400e6)), GooseGuard.RescueOn.selector);
    }

    /// A top-up with credit at health 1.08: above the line, under 1.10.
    function test_a_top_up_under_health_1_10_is_refused() public {
        address a = _victim("low", 1 << NVDA, 4_000e6, 1.08e18);
        _mixOn(a);
        _refused(a, TRADE, _a2(500e6, _buy(AAPL, 400e6)), GooseGuard.HealthTooLow.selector);
    }

    /// Keep $500 with no savings: of a $1,000 wallet, at most $499 may go in.
    function test_a_top_up_above_wallet_minus_a_dollar_minus_keep_is_refused() public {
        address a = _mixer("toomuch");
        vm.prank(a);
        g.setTopUps(true, 500e6);
        deal(address(USDC), a, 1_000e6);
        _refused(a, TRADE, _a2(500e6, _buy(NVDA, 400e6)), GooseGuard.TooMuch.selector);
        assertEq(_send(a, TRADE, _a2(499e6, _buy(NVDA, 400e6))), bytes4(0), "the top-up within bounds was refused");
    }

    /// Savings never go into stock: $1,000 in savings and $1.50 in the wallet can't fund a $500 top-up.
    function test_a_top_up_from_savings_is_refused() public {
        address a = _mixer("savings");
        _saveOn(a);
        vm.prank(a);
        g.setTopUps(true, 0);
        deal(address(USDC), a, 1_001.5e6);
        _save(a, 1_000e6);
        _refused(a, TRADE, _a2(500e6, _buy(NVDA, 400e6)), GooseGuard.TooMuch.selector);
    }

    /// Top-ups on, a mix, the user's Rebalance permission, cash in the wallet.
    function _mixOn(address a) internal {
        uint16[7] memory w;
        w[AAPL] = 5000;
        w[NVDA] = 5000;
        vm.startPrank(a);
        g.setMix(_pack(w));
        g.setTopUps(true, 0);
        vm.stopPrank();
        deal(address(USDC), a, 1_001e6);
    }

    // ================================================================== SAVE and CONVERT

    /// With top-ups on and Keep already in savings, cash in the wallet is a waiting top-up: Save can't take it.
    function test_save_cant_take_a_waiting_top_up() public {
        address a = _newJawAccount("topupwait");
        _saveOn(a);
        deal(address(USDC), a, 1_101e6);
        _save(a, 100e6);
        uint256 savings = _bal(address(AUSDC), a);
        vm.prank(a);
        g.setTopUps(true, uint48(savings));
        _refused(a, SAVE, _a1(1_000e6), GooseGuard.NothingToMove.selector);
        // Keep raised by $200: Save may fill exactly the $200 Keep still needs.
        vm.prank(a);
        g.setTopUps(true, uint48(savings + 200e6));
        assertEq(_send(a, SAVE, _a1(1_000e6)), bytes4(0), "the save up to Keep was refused");
        assertApproxEqAbs(_bal(address(AUSDC), a), savings + 200e6, 2, "saved past Keep");
        assertEq(_bal(address(USDC), a), 801e6, "the top-up didn't wait in the wallet");
    }

    /// SURPRISE (not a loss): Aave V3 credits a $100 supply as 99.999999 aUSDC, so with Keep at $100 Save's room is
    /// 1 unit. Save then supplies 1 unit, which Aave refuses (its scaled amount rounds to 0), so the move is refused
    /// with Aave's own InvalidAmount (unwrapped from the account's ExecuteError) instead of NothingToMove. The Planner
    /// drops such a save.
    function test_save_of_a_one_unit_keep_shortfall_is_refused_by_aave() public {
        address a = _newJawAccount("oneunit");
        _saveOn(a);
        deal(address(USDC), a, 1_101e6);
        _save(a, 100e6);
        uint256 savings = _bal(address(AUSDC), a);
        console2.log("aUSDC after supplying 100e6", savings);
        vm.prank(a);
        g.setTopUps(true, 100e6);
        bytes4 want = savings == 100e6 - 1 ? bytes4(keccak256("InvalidAmount()")) : GooseGuard.NothingToMove.selector;
        _refused(a, SAVE, _a1(1_000e6), want);
    }

    /// EUR/USD older than its heartbeat plus an hour, or not positive: EURC is refused (StaleFeed). Exactly 2 hours
    /// old still converts.
    function test_a_conversion_on_a_stale_eur_usd_feed_is_refused() public {
        address a = _newJawAccount("eurc");
        _entryOn(a);
        deal(EURC, a, 100e6);
        (, int256 answer,,,) = IFeedLike(EUR_USD).latestRoundData();
        uint256 now_ = vm.getBlockTimestamp();
        uint256 snap = vm.snapshotState();
        vm.mockCall(EUR_USD, IFeedLike.latestRoundData.selector, abi.encode(1, answer, 0, now_ - 2 hours - 1, 1));
        _refused(a, CONVERT, _a2(4, 100e6), GooseGuard.StaleFeed.selector);
        vm.mockCall(EUR_USD, IFeedLike.latestRoundData.selector, abi.encode(1, int256(0), 0, now_, 1));
        _refused(a, CONVERT, _a2(4, 100e6), GooseGuard.StaleFeed.selector);
        vm.revertToState(snap);
        vm.mockCall(EUR_USD, IFeedLike.latestRoundData.selector, abi.encode(1, answer, 0, now_ - 2 hours, 1));
        assertEq(_send(a, CONVERT, _a2(4, 100e6)), bytes4(0), "a feed exactly 2 hours old was refused");
    }

    /// $50,000 of DAI through its shallow Uniswap pool can't fill at 99.5%: refused inside the batch. Uniswap's router
    /// gives no reason, so the refusal stays the account's ExecuteError.
    function test_a_conversion_below_the_floor_is_refused() public {
        address a = _newJawAccount("dai");
        _entryOn(a);
        deal(DAI, a, 50_000e18);
        _refused(a, CONVERT, _a2(3, 50_000e18), EXECUTE_ERROR);
    }

    // ================================================================== pacing

    /// A hacked runner churns Rebalance every block (2 s) for a day while Aave's NVDAc price swings ±0.3% each block,
    /// so there is always drift to trade one way or the other. Sales run only in the session the first sale opens
    /// (1 hour) and in the one that opens 20 hours later; every other block is refused, and what the user can lose is
    /// bounded by those two hours. Gas metering is paused: 43,200 performs don't fit a test's gas.
    function test_a_day_of_every_block_churn_is_paced() public {
        address a = _newJawAccount("churn");
        _rebalanceOn(a);
        uint16[7] memory w;
        w[AAPL] = 5000;
        w[NVDA] = 5000;
        vm.prank(a);
        g.setMix(_pack(w));
        deal(STOCKS[AAPL], a, _sharesFor(AAPL, 20_000e6));
        deal(NVDAC, a, _sharesFor(NVDA, 20_000e6));
        uint256 p0 = _price(NVDA);
        uint256 pa = _price(AAPL);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 t0 = vm.getBlockTimestamp();
        uint256 worth0 = _worth(a, p0, pa);

        vm.pauseGasMetering();
        uint256 ran;
        uint256 paced;
        uint256 firstOutside;
        uint256 lastRun;
        for (uint256 b; b < 43_200; ++b) {
            // Each block in its own call frame, so the test's memory doesn't grow with the day.
            (bool sent, bytes4 reason) = this.churnBlock(a, t0 + 2 * b, b % 2 == 0 ? p0 * 1003 / 1000 : p0 * 997 / 1000, pa);
            if (!sent) continue;
            uint256 since = 2 * b;
            bool inSession = since < 1 hours || (since >= 20 hours && since < 21 hours);
            if (reason == bytes4(0)) {
                ++ran;
                lastRun = since;
                if (!inSession && firstOutside == 0) firstOutside = since;
            } else if (reason == GooseGuard.Paced.selector) {
                ++paced;
                assertFalse(since < 1 hours, "paced inside the first session");
            }
        }
        vm.resumeGasMetering();
        console2.log("blocks", 43_200, "sales that ran", ran);
        console2.log("refused Paced", paced, "last sale (s after start)", lastRun);
        vm.clearMockedCalls();
        uint256 worth1 = _worth(a, p0, pa);
        console2.log("the account's worth at the day's start prices, before and after (USDC units)", worth0, worth1);
        assertEq(firstOutside, 0, "a sale ran outside the two sessions");
        assertGt(ran, 0, "nothing ran");
        assertGe(paced, 39_000, "pacing didn't hold the rest back");
    }

    function _worth(address a, uint256 pn, uint256 pa) internal view returns (uint256) {
        return _bal(address(USDC), a) + _bal(STOCKS[AAPL], a) * pa / 1e10 + _bal(NVDAC, a) * pn / 1e10;
    }

    /// One block of the churn: Aave's NVDAc price is `p`, and the runner sells a twentieth of whichever stock is over
    /// its target. Returns whether a move was sent and its refusal reason.
    function churnBlock(address a, uint256 t, uint256 p, uint256 pa) external returns (bool sent, bytes4 reason) {
        vm.warp(t);
        vm.roll(block.number + 1);
        _mockPrice(NVDA, p);
        uint256 vA = _bal(STOCKS[AAPL], a) * pa / 1e10;
        uint256 vN = _bal(NVDAC, a) * p / 1e10;
        uint256 leg = vN > vA ? _leg(NVDA, (vN - vA) / 20 * 1e10 / p) : _leg(AAPL, (vA - vN) / 20 * 1e10 / pa);
        if (uint128(leg) == 0) return (false, 0);
        (, Vm.Log[] memory logs) = _perform(_one(a, TRADE, _a2(0, leg)));
        return (true, _reason(logs, a));
    }
}

interface IERC20Like {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IFeedLike {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
