// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IAeroRouter, IERC20} from "../src/IProtocols.sol";
import {NyCalendar} from "../src/NyCalendar.sol";
import {Trade} from "../src/RebalanceRules.sol";
import {RebalanceJob} from "../src/jobs/RebalanceJob.sol";
import {SellForkBase} from "./ProtectSellFork.t.sol";
import {IJustaPermissionManager as PM} from "./IJustaPermissionManager.sol";

/// Fixtures for the Rebalancer's fork suites: Protect · sell's (every stock a StockDouble holding the hub's and its
/// Aerodrome pool's real balances), Aave's price set to each pool's own, and the clock 30 minutes after a weekday open.
abstract contract RebalanceForkBase is SellForkBase {
    uint256 constant AMZN = 1;

    function _setUpRebalance() internal {
        _setUpSell();
        for (uint256 r; r < 7; ++r) {
            _priceAt(r, 10_000); // Aave's price = the pool's, so a test sets the gap it wants
        }
        vm.warp(_tuesdayAt(vm.getBlockTimestamp(), 10 hours + 5 minutes));
    }

    /// A fresh JAW account holding free stock worth `usd` (USDC units, at Aave's price) of each stock in `stocks`, with
    /// the mix `weights` and the Rebalancer on: a $1,000 weekly USDC limit, and a weekly limit worth $1,500 for each.
    function _holder(string memory name, uint256[] memory stocks, uint256[] memory usd, uint16[7] memory weights)
        internal
        returns (address a, PM.Permission memory p)
    {
        a = _newJawAccount(name);
        uint256 t;
        for (uint256 i; i < stocks.length; ++i) {
            uint256 r = stocks[i];
            deal(STOCKS[r], a, usd[i] * 1e10 / _price(r));
            t |= 1_500e6 * 1e10 / _price(r) / 1e4 << (32 * r);
        }
        vm.prank(a);
        x.setMix(weights);
        p = _rebalanceOn(a, t);
    }

    function _rebalanceOn(address a, uint256 t) internal returns (PM.Permission memory p) {
        uint48 start = uint48(vm.getBlockTimestamp());
        p = x.permissionFor(
            GooseExecutor.Job.Rebalance,
            a,
            GooseExecutor.Grant(start, start + 365 days, 1_000e6),
            uint256(keccak256(abi.encode(++salts))),
            t
        );
        _grantThroughAccount(p);
        x.register(GooseExecutor.Job.Rebalance, a, p.start, p.end, p.salt, 1_000e6, t);
    }

    /// The account's free stock in `r`, in USDC units at Aave's price.
    function _value(address a, uint256 r) internal view returns (uint256) {
        return IERC20(STOCKS[r]).balanceOf(a) * _price(r) / 1e10;
    }

    /// `nyTime` seconds past midnight New York time, on the next Tuesday after `ts`.
    function _tuesdayAt(uint256 ts, uint256 nyTime) internal pure returns (uint256) {
        uint256 utc = _nextTuesday(ts);
        return utc / 1 days * 1 days + nyTime + NyCalendar.offset(utc);
    }

    function _list(uint256 a, uint256 b) internal pure returns (uint256[] memory l) {
        l = new uint256[](2);
        (l[0], l[1]) = (a, b);
    }

    function _rebalanced(Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(x) && logs[i].topics[0] == GooseExecutor.Rebalanced.selector) return true;
        }
        return false;
    }
}

/// The Rebalancer against the real JAW manager and Aerodrome's stock pools on a Base fork, with fresh JAW accounts
/// granted the way JAW's screen grants. Plan item 9 steps 2-3: the plan's 50/50 mix drifted to 56/44 comes back to
/// about 52.5/47.5 in one batch with the USDC netting to zero; once a market day, 30 to 60 minutes after the open;
/// never while the credit isn't Safe, nor with a pool off Aave's price; and the post-checks and the manager catch a buy
/// for someone else, a batch that spends cash, a sale to someone else and a stock out of the grant.
contract RebalanceForkTest is RebalanceForkBase {
    uint16[7] fiftyFifty = [uint16(5_000), 0, 0, 0, 0, 5_000, 0]; // Apple and NVIDIA

    function setUp() public {
        _setUpRebalance();
    }

    function test_a_50_50_mix_drifted_to_56_44_comes_back_in_one_batch() public {
        (address a,) = _holder("a", _list(NVDA, AAPL), _list(5_600e6, 4_400e6), fiftyFifty);
        deal(address(USDC), a, 7e6); // some cash, which it must not spend
        GooseExecutor.Plan memory plan = x.planOf(a);
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Rebalance));

        vm.recordLogs();
        uint256 before = gasleft();
        _run(_check());
        console.log("50/50 from 56/44: run gas", before - gasleft());
        assertTrue(_rebalanced(vm.getRecordedLogs()));
        uint256 nvda = _value(a, NVDA);
        uint256 total = nvda + _value(a, AAPL);
        assertApproxEqAbs(nvda * 1e4 / total, 5_250, 5, "back to about 52.5/47.5");
        assertGe(USDC.balanceOf(a), 7e6, "the wallet's USDC never goes down");
        assertLe(USDC.balanceOf(a), 7e6 + 3e6, "and nets to about zero: the floor's margin, about 0.5% of $350");
        assertEq(AUSDC.balanceOf(a), 0, "savings untouched");
        _assertHoldsNothing();
        assertEq(IERC20(STOCKS[NVDA]).balanceOf(address(x)) + IERC20(STOCKS[AAPL]).balanceOf(address(x)), 0);
        assertEq(_check().length, 0, "once a day");
    }

    function test_only_30_to_60_minutes_after_the_open_on_a_market_day() public {
        _holder("a", _list(NVDA, AAPL), _list(5_600e6, 4_400e6), fiftyFifty);
        uint256 open = vm.getBlockTimestamp() - 5 minutes; // Tuesday 10:00 in New York
        vm.warp(open + 30 minutes - 1);
        assertEq(_check().length, 1, "10:29:59");
        vm.warp(open + 30 minutes);
        assertEq(_check().length, 0, "10:30");
        vm.warp(open + 1 days - 1);
        assertEq(_check().length, 0, "Wednesday 9:59:59");
        vm.warp(open + 1 days);
        assertEq(_check().length, 1, "Wednesday 10:00");
        vm.warp(open + 4 days);
        assertTrue(x.frozen(vm.getBlockTimestamp()), "a Saturday");
        assertEq(_check().length, 0, "not while prices are held");
    }

    /// Protect first: free stock drifted, but the credit isn't Safe, so the Rebalancer waits.
    function test_it_waits_while_the_credit_is_not_safe() public {
        (address a,) = _holder("a", _list(NVDA, AAPL), _list(5_600e6, 4_400e6), fiftyFifty);
        _backWith(a, TSLA, 5e8);
        _drawTo(a, 1.45e18);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None));
        _backWith(a, TSLA, 1e8); // the account adds backing: Safe again
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Rebalance));
    }

    /// NVIDIA's pool 0.6% off Aave's price holds the day; at 0.4% it trades.
    function test_a_pool_off_aave_price_holds_the_rebalance() public {
        _holder("a", _list(NVDA, AAPL), _list(5_600e6, 4_400e6), fiftyFifty);
        _priceAt(NVDA, 10_060);
        assertEq(_check().length, 0);
        _priceAt(NVDA, 9_960);
        assertEq(_check().length, 1);
    }

    /// The pool is in line (0.48% under Aave's price), but a sale there can't get Aave's price less 0.5% once the pool
    /// takes its fee: the batch moves nothing and the day is skipped, without counting as a failure.
    function test_a_batch_below_its_floor_skips_the_day() public {
        (address a,) = _holder("a", _list(NVDA, AAPL), _list(5_600e6, 4_400e6), fiftyFifty);
        _priceAt(NVDA, 10_048);
        uint256 nvda = IERC20(STOCKS[NVDA]).balanceOf(a);
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.RebalanceSkipped(a);
        _run(_check());
        assertEq(IERC20(STOCKS[NVDA]).balanceOf(a), nvda, "nothing moved");
        (,, uint8 fails,,,,,, uint32 day) = x.accounts(a);
        assertEq(fails, 0, "not a failure");
        assertGt(day, 0, "done for the day");
        assertEq(_check().length, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _priceAt(NVDA, 10_000);
        assertEq(_check().length, 1, "the next market day");
    }

    /// NVIDIA's weekly limit is used up: it can't be sold, and Apple isn't over its band, so nothing trades.
    function test_a_used_up_weekly_limit_skips() public {
        address a = _newJawAccount("a");
        deal(STOCKS[NVDA], a, 5_600e6 * 1e10 / _price(NVDA));
        deal(STOCKS[AAPL], a, 4_400e6 * 1e10 / _price(AAPL));
        vm.prank(a);
        x.setMix(fiftyFifty);
        _rebalanceOn(a, _limits(AAPL, 1e8) | _limits(NVDA, 1e4)); // a ten-thousandth of a share of NVIDIA
        assertEq(_check().length, 0);
    }

    /// The costliest batch: a seven-stock mix with three stocks over and four under, cold.
    function test_seven_stocks_in_one_batch() public {
        uint256[] memory stocks = new uint256[](7);
        uint256[] memory usd = new uint256[](7);
        uint16[7] memory weights;
        for (uint256 r; r < 7; ++r) {
            stocks[r] = r;
            weights[r] = r < 6 ? 1_430 : 1_420;
            usd[r] = r < 3 ? 1_800e6 : 1_100e6; // 17.8% vs 14.3%, and 10.9%
        }
        (address a,) = _holder("a", stocks, usd, weights);
        assertEq(x.planOf(a).amount > 0, true);
        vm.recordLogs();
        uint256 before = gasleft();
        _run(_check());
        console.log("seven stocks: run gas", before - gasleft());
        assertTrue(_rebalanced(vm.getRecordedLogs()));
        uint256 total;
        for (uint256 r; r < 7; ++r) {
            total += _value(a, r);
        }
        for (uint256 r; r < 7; ++r) {
            uint256 w = _value(a, r) * 1e4 / total;
            assertGt(w, r < 3 ? 1_430 + 143 : 1_200, "the three that grew are back inside their band");
            assertLt(w, r < 3 ? 1_430 + 286 : 1_430 - 143, "and the four that fell short too");
        }
    }

    // ================================================================== what the post-checks and the manager catch

    function test_a_buy_for_someone_else_reverts() public {
        (address a,) = _holder("a", _list(NVDA, AAPL), _list(5_600e6, 4_400e6), fiftyFifty);
        (Trade[] memory t, PM.Call[] memory calls) = _plannedBatch(a);
        calls[calls.length - 1] = _swap(STOCKS[AAPL], address(USDC), t[1].amountIn, attacker, true);
        vm.expectRevert(GooseExecutor.StockMoved.selector);
        this.rebalanceWith(a, t, calls);
    }

    function test_a_sale_for_someone_else_or_a_buy_with_cash_reverts() public {
        (address a,) = _holder("a", _list(NVDA, AAPL), _list(5_600e6, 4_400e6), fiftyFifty);
        deal(address(USDC), a, 1_000e6);
        (Trade[] memory t, PM.Call[] memory calls) = _plannedBatch(a);
        calls[2] = _swap(STOCKS[NVDA], address(USDC), t[0].amountIn, attacker, false); // the sale's USDC elsewhere
        vm.expectRevert(GooseExecutor.CashLower.selector);
        this.rebalanceWith(a, t, calls);

        // A buy with no sale: the wallet's own cash.
        Trade[] memory buyOnly = new Trade[](1);
        buyOnly[0] = Trade(uint8(AAPL), true, 300e6, 0);
        PM.Call[] memory spend = new PM.Call[](2);
        spend[0] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(ROUTER), 300e6)));
        spend[1] = _swap(STOCKS[AAPL], address(USDC), 300e6, a, true);
        vm.expectRevert(GooseExecutor.CashLower.selector);
        this.rebalanceWith(a, buyOnly, spend);
    }

    /// Buying a stock outside the plan (Tesla) moves a balance the plan didn't, and selling a stock the grant doesn't
    /// list (Tesla again) has no approve: the manager refuses it.
    function test_a_stock_off_the_plan_or_out_of_the_grant_reverts() public {
        (address a,) = _holder("a", _list(NVDA, AAPL), _list(5_600e6, 4_400e6), fiftyFifty);
        (Trade[] memory t, PM.Call[] memory calls) = _plannedBatch(a);
        calls[calls.length - 1] = _swap(STOCKS[TSLA], address(USDC), t[1].amountIn, a, true);
        vm.expectRevert(GooseExecutor.StockMoved.selector);
        this.rebalanceWith(a, t, calls);

        deal(STOCKS[TSLA], a, 1e8);
        PM.Call[] memory sell = new PM.Call[](1);
        sell[0] = PM.Call(STOCKS[TSLA], 0, abi.encodeCall(IERC20.approve, (address(ROUTER), 1e8)));
        vm.expectPartialRevert(UNAUTHORIZED_CALL);
        this.rebalanceWith(a, new Trade[](0), sell);
    }

    // ================================================================== helpers

    /// Runs `calls` through the manager as the executor, with `account`'s Rebalancer permission, under a rebalance's
    /// post-checks for `trades`.
    function rebalanceWith(address account, Trade[] calldata trades, PM.Call[] calldata calls) external {
        PM.Permission memory p = x.permissionOf(account, GooseExecutor.Job.Rebalance);
        RebalanceJob.Before memory b = RebalanceJob.snapshot(x.env(), account, trades);
        vm.prank(address(x));
        MANAGER.executeBatch(p, calls);
        RebalanceJob.check(x.env(), account, b);
    }

    /// The plan's 56/44 batch, built by hand the way the executor builds it: approve NVIDIA, approve USDC, sell NVIDIA,
    /// buy Apple with exactly the sale's minimum.
    function _plannedBatch(address a) internal view returns (Trade[] memory t, PM.Call[] memory calls) {
        t = new Trade[](2);
        uint256 shares = 350e6 * 1e10 / _price(NVDA);
        uint256 minOut = shares * _price(NVDA) * 9_950 / 1e14;
        t[0] = Trade(uint8(NVDA), false, shares, minOut);
        t[1] = Trade(uint8(AAPL), true, minOut, minOut * 1e10 * 9_950 / (_price(AAPL) * 1e4));
        calls = new PM.Call[](4);
        calls[0] = PM.Call(STOCKS[NVDA], 0, abi.encodeCall(IERC20.approve, (address(ROUTER), shares)));
        calls[1] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(ROUTER), minOut)));
        calls[2] = _swap(STOCKS[NVDA], address(USDC), shares, a, false);
        calls[3] = _swap(STOCKS[AAPL], address(USDC), minOut, a, true);
    }

    function _swap(address stock, address usdc, uint256 amountIn, address to, bool buy)
        internal
        view
        returns (PM.Call memory)
    {
        return PM.Call(
            address(ROUTER),
            0,
            abi.encodeCall(
                IAeroRouter.exactInputSingle,
                (IAeroRouter.ExactInputSingleParams(
                        buy ? usdc : stock, buy ? stock : usdc, 10, to, block.timestamp, amountIn, 0, 0
                    ))
            )
        );
    }
}

/// The costliest rebalance, measured cold: the position is built in setUp, which forge runs as its own transaction. A
/// seven-stock mix with three stocks over their band and four under: its check, in the window, and its run, whose
/// batch must fit RebalanceJob's cap, inside MAX_RUN_GAS and Base's 5M.
contract RebalanceGasForkTest is RebalanceForkBase {
    address a;

    function setUp() public {
        _setUpRebalance();
        uint256[] memory stocks = new uint256[](7);
        uint256[] memory usd = new uint256[](7);
        uint16[7] memory weights;
        for (uint256 r; r < 7; ++r) {
            stocks[r] = r;
            weights[r] = r < 6 ? 1_430 : 1_420;
            usd[r] = r < 3 ? 1_800e6 : 1_100e6;
        }
        (a,) = _holder("cold", stocks, usd, weights);
    }

    function test_a_cold_check_of_a_seven_stock_mix_in_the_window() public view {
        uint256 before = gasleft();
        address[] memory work = _check();
        console.log("seven-stock mix, cold check gas", before - gasleft());
        assertEq(work.length, 1);
    }

    function test_a_cold_seven_stock_rebalance_fits() public {
        address[] memory one = new address[](1);
        one[0] = a;
        vm.recordLogs();
        uint256 before = gasleft();
        _run(one);
        console.log("seven-stock rebalance, cold run gas", before - gasleft());
        assertTrue(_rebalanced(vm.getRecordedLogs()), "not deferred, not skipped");
    }
}
