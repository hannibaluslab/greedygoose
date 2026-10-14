// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IAeroFactory, IAeroRouter, IERC20} from "../src/IProtocols.sol";
import {NyCalendar} from "../src/NyCalendar.sol";
import {JobBase} from "../src/jobs/JobBase.sol";
import {SellJob} from "../src/jobs/SellJob.sol";
import {ExecutorForkBase} from "./GooseExecutorFork.t.sol";
import {IJustaPermissionManager as PM} from "./IJustaPermissionManager.sol";

/// Fixtures for the Protect · sell fork suites.
abstract contract SellForkBase is ExecutorForkBase {
    IAeroFactory constant AERO_FACTORY = IAeroFactory(0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef);
    IAeroRouter constant ROUTER = IAeroRouter(0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F);
    uint256 constant AAPL = 0;
    uint256 constant NVDA = 5;
    uint256 constant TSLA = 6;
    bytes4 constant UNAUTHORIZED_CALL = bytes4(keccak256("JustaPermissionManager_UnauthorizedCall(address,bytes4)"));
    bytes4 constant EXCEEDED_SPEND = bytes4(keccak256("JustaPermissionManager_ExceededSpendLimit(uint256,uint256)"));

    /// Every stock a StockDouble with the hub's and its Aerodrome pool's real balances, an executor, and a weekday.
    function _setUpSell() internal {
        _fork();
        for (uint256 r; r < STOCKS.length; ++r) {
            if (STOCKS[r] != NVDAC) _useStockDouble(STOCKS[r]);
            address pool = AERO_FACTORY.getPool(STOCKS[r], address(USDC), 10);
            deal(STOCKS[r], pool, _realBalance(STOCKS[r], pool));
        }
        x = _deploy(_config());
        vm.warp(_nextTuesday(vm.getBlockTimestamp())); // a weekday with prices live, whenever this runs
    }

    // ================================================================== helpers

    /// Runs `calls` through the manager as the executor, with `account`'s Protect · sell permission, under the sale's
    /// post-checks, so tests can show what they catch. `sold` is what the batch claims to sell, by reserve id.
    function sellWith(address account, uint256[7] calldata sold, PM.Call[] calldata calls) external {
        PM.Permission memory p = x.permissionOf(account, GooseExecutor.Job.ProtectSell);
        SellJob.Before memory b =
            SellJob.snapshot(x.env(), account, sold, SPOKE.getUserAccountData(account).healthFactor);
        vm.prank(address(x));
        MANAGER.executeBatch(p, calls);
        SellJob.check(x.env(), account, b);
    }

    /// A fresh JAW account backing a credit line with `sharesRaw` of stock `r`, drawn to health `hf`.
    function _owing(string memory name, uint256 r, uint256 sharesRaw, uint256 hf) internal returns (address a) {
        a = _newJawAccount(name);
        _backWith(a, r, sharesRaw);
        _drawTo(a, hf);
    }

    /// Protect · sell switched on the way JAW's screen grants it, with a $1,000 USDC limit.
    function _sellOn(address a, uint256 t) internal returns (PM.Permission memory p) {
        p = _sellPermission(a, t);
        _grantThroughAccount(p);
        x.register(GooseExecutor.Job.ProtectSell, a, p.start, p.end, p.salt, 1_000e6, t);
    }

    function _sellPermission(address a, uint256 t) internal returns (PM.Permission memory) {
        uint48 start = uint48(vm.getBlockTimestamp());
        return x.permissionFor(
            GooseExecutor.Job.ProtectSell,
            a,
            GooseExecutor.Grant(start, start + 365 days, 1_000e6),
            uint256(keccak256(abi.encode(++salts))),
            t
        );
    }

    /// The terms for a daily limit of `sharesRaw` on stock `r`.
    function _limits(uint256 r, uint256 sharesRaw) internal pure returns (uint256) {
        return sharesRaw / 1e4 << (32 * r);
    }

    /// A run, logging its slices (withdrawals) and gas. Returns the slices.
    function _runLogged(string memory what, address[] memory work) internal returns (uint256 slices) {
        vm.recordLogs();
        uint256 before = gasleft();
        _run(work);
        uint256 gas = before - gasleft();
        slices = _withdrawals(vm.getRecordedLogs());
        console.log(string.concat(what, ": slices, gas"), slices, gas);
    }

    function _assertBackTo1_4(address a) internal view {
        assertApproxEqAbs(SPOKE.getUserAccountData(a).healthFactor, 1.4e18, 0.005e18, "back to 1.4");
        assertGe(SPOKE.getUserAccountData(a).healthFactor, 1.399e18);
    }

    function _headsUpAt(address a) internal view returns (uint48 at) {
        (,,,,,, at,,) = x.accounts(a);
    }

    function _price(uint256 r) internal view returns (uint256) {
        return x.ORACLE().getReservePrice(r);
    }

    /// Aave's price for stock `r`: its Aerodrome pool's, times `bps` / 10,000.
    function _priceAt(uint256 r, uint256 bps) internal {
        uint256 price = JobBase.poolPrice(x.env(), r) * bps / 10_000;
        vm.mockCall(address(x.ORACLE()), abi.encodeWithSignature("getReservePrice(uint256)", r), abi.encode(price));
    }

    function _withdrawals(Vm.Log[] memory logs) internal pure returns (uint256 n) {
        bytes32 withdraw = keccak256("Withdraw(uint256,address,address,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(SPOKE) && logs[i].topics[0] == withdraw) ++n;
        }
    }

    function _withdraw(address a, uint256 sharesRaw) internal pure returns (PM.Call memory) {
        return
            PM.Call(address(SPOKE), 0, abi.encodeWithSignature("withdraw(uint256,uint256,address)", NVDA, sharesRaw, a));
    }

    /// The account sells `sharesRaw` of NVIDIA on Aerodrome; `to` gets the USDC.
    function _swap(uint256 sharesRaw, uint256 minOut, address to) internal view returns (PM.Call memory) {
        return PM.Call(
            address(ROUTER),
            0,
            abi.encodeCall(
                IAeroRouter.exactInputSingle,
                (IAeroRouter.ExactInputSingleParams(
                        NVDAC, address(USDC), 10, to, block.timestamp, sharesRaw, minOut, 0
                    ))
            )
        );
    }

    function _repay(address a, uint256 amount) internal pure returns (PM.Call memory) {
        return
            PM.Call(
                address(SPOKE), 0, abi.encodeWithSignature("repay(uint256,uint256,address)", USDC_RESERVE, amount, a)
            );
    }

    /// 15:00 UTC on the next Tuesday after `ts`: 10:00 or 11:00 in New York, prices live.
    function _nextTuesday(uint256 ts) internal pure returns (uint256) {
        uint256 d = ts / 1 days + 1;
        return (d + (12 - d % 7) % 7) * 1 days + 15 hours; // day 5 (1970-01-06) was a Tuesday
    }

    /// `nyTime` seconds past midnight New York time, on the next Tuesday after `ts`.
    function _tuesdayAt(uint256 ts, uint256 nyTime) internal pure returns (uint256) {
        uint256 utc = _nextTuesday(ts);
        return utc / 1 days * 1 days + nyTime + NyCalendar.offset(utc);
    }

    /// The sale time the run's SellHeadsUp gave.
    function _sellAfter(Vm.Log[] memory logs) internal view returns (uint256) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(x) && logs[i].topics[0] == GooseExecutor.SellHeadsUp.selector) {
                (,, uint48 sellAfter) = abi.decode(logs[i].data, (uint256, uint256, uint48));
                return sellAfter;
            }
        }
        revert("no SellHeadsUp");
    }
}

/// Protect · sell against the real JAW manager, the Aave V4 Equities Hub and Aerodrome's stock pools on a Base fork,
/// with fresh JAW accounts granted the way JAW's screen grants. Every stock is a StockDouble holding the balances the
/// hub and the pools really hold (ForkBase), so the swaps run against the pools' real liquidity and prices. Plan item 1
/// step 12: sales from health 1.25, 1.10, 1.05 and 1.01, each ending at 1.4 or failing for a stated reason.
contract ProtectSellForkTest is SellForkBase {
    function setUp() public {
        _setUpSell();
    }

    // ================================================================== the four starting healths

    /// Just under 1.25 on a weekday: a heads-up, nothing sold, then 30 minutes later the sale, back to 1.4.
    function test_at_1_25_a_heads_up_then_the_sale_30_minutes_later() public {
        address a = _owing("a", NVDA, 10e8, 1.249e18);
        PM.Permission memory p = _sellOn(a, _limits(NVDA, 5e8));
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);

        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.HeadsUp));
        vm.recordLogs();
        _run(_check());
        assertEq(_sellAfter(vm.getRecordedLogs()), vm.getBlockTimestamp() + 30 minutes, "the heads-up says when");
        assertEq(SPOKE.getUserSuppliedAssets(NVDA, a), backing, "nothing sold yet");
        assertEq(_headsUpAt(a), vm.getBlockTimestamp());
        assertEq(_check().length, 0, "waiting");

        vm.warp(vm.getBlockTimestamp() + 30 minutes - 1);
        assertEq(_check().length, 0, "still waiting");
        vm.warp(vm.getBlockTimestamp() + 1);
        GooseExecutor.Plan memory plan = x.planOf(a);
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Sell));
        assertEq(plan.reason, 0, "after the heads-up, at the normal floor");
        _runLogged("from 1.25", _check());

        _assertBackTo1_4(a);
        uint256 sold = backing - SPOKE.getUserSuppliedAssets(NVDA, a);
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[2]).spend, sold, "the stock's limit is charged what was sold");
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[0]).spend, plan.amount, "USDC's limit is charged the repay");
        assertEq(_headsUpAt(a), 0, "cleared by the sale");
        (, uint208 used) = x.pools(NVDA);
        assertApproxEqAbs(used, sold * _price(NVDA) / 1e10, 1, "counted against the pool's window");
        _assertHoldsNothing();
        assertEq(_check().length, 0, "Safe enough again");
    }

    /// Below 1.10 (Act) it sells at once, at the wider floor.
    function test_at_1_10_it_sells_at_once() public {
        address a = _owing("a", NVDA, 10e8, 1.099e18);
        _sellOn(a, _limits(NVDA, 5e8));
        GooseExecutor.Plan memory plan = x.planOf(a);
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Sell));
        assertEq(plan.reason, 1, "at once");
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.ProtectSold(a, [uint256(0), 0, 0, 0, 0, 0, 0], 0, 0, 0, true);
        _runLogged("from 1.10", _check());
        _assertBackTo1_4(a);
        _assertHoldsNothing();
    }

    function test_at_1_05_it_sells_at_once_in_slices() public {
        address a = _owing("a", NVDA, 10e8, 1.05e18);
        _sellOn(a, _limits(NVDA, 5e8));
        assertGt(_runLogged("from 1.05", _check()), 1, "more than one withdrawal: Aave checks health after each");
        _assertBackTo1_4(a);
    }

    /// From 1.01 the sale needs more slices than a run makes (about nine): the first run leaves it still in Act, and
    /// the next block's run finishes the job.
    function test_at_1_01_it_takes_two_runs() public {
        address a = _owing("a", NVDA, 10e8, 1.01e18);
        _sellOn(a, _limits(NVDA, 5e8));
        assertEq(_runLogged("from 1.01, first run", _check()), 6);
        uint256 hf = SPOKE.getUserAccountData(a).healthFactor;
        assertGt(hf, 1.05e18, "the first run helps");
        assertLt(hf, 1.4e18, "but a run makes six slices");
        vm.roll(vm.getBlockNumber() + 1);
        _runLogged("from 1.01, second run", _check());
        _assertBackTo1_4(a);
    }

    // ================================================================== when it doesn't sell

    function test_never_on_a_weekend() public {
        address a = _owing("a", NVDA, 10e8, 1.05e18);
        _sellOn(a, _limits(NVDA, 5e8));
        vm.warp(vm.getBlockTimestamp() + 4 days); // Saturday
        assertTrue(x.frozen(vm.getBlockTimestamp()));
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None));
        assertEq(_check().length, 0);
        vm.warp(vm.getBlockTimestamp() + 2 days); // Monday: prices live again
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Sell));
    }

    /// A heads-up just before the Friday freeze goes out on time. Its 30 minutes end while prices are held, so it gives
    /// Sunday 20:00 New York as the sale time, and the sale waits for it: nothing on Friday night or over the
    /// weekend, then the sale at the reopen, the health still below the line.
    function test_a_heads_up_before_the_friday_freeze_sells_when_prices_reopen() public {
        uint256 friday = _tuesdayAt(vm.getBlockTimestamp(), 19 hours + 45 minutes) + 3 days;
        vm.warp(friday);
        address a = _owing("a", NVDA, 10e8, 1.2e18);
        _sellOn(a, _limits(NVDA, 5e8));
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);
        vm.recordLogs();
        _run(_check());
        // Sunday 20:00 in New York: two days and 15 minutes on, give or take a time-zone switch that weekend.
        uint256 reopen = friday + 2 days + 15 minutes + NyCalendar.offset(friday + 2 days) - NyCalendar.offset(friday);
        assertEq(_sellAfter(vm.getRecordedLogs()), reopen, "the sale time is the reopen");
        assertTrue(x.frozen(reopen - 1));
        assertFalse(x.frozen(reopen));

        vm.warp(friday + 30 minutes);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "Friday 20:15: prices are held");
        vm.warp(reopen - 1);
        assertEq(_check().length, 0, "nor over the weekend");
        assertEq(SPOKE.getUserSuppliedAssets(NVDA, a), backing);
        vm.warp(reopen);
        GooseExecutor.Plan memory plan = x.planOf(a);
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Sell), "the reopen: still below the line");
        assertEq(plan.reason, 0, "after the heads-up, at the normal floor");
        _run(_check());
        _assertBackTo1_4(a);
    }

    /// The same heads-up, answered over the weekend (the account adds backing): it is cleared while prices are held,
    /// and nothing sells at the reopen.
    function test_a_heads_up_answered_over_the_weekend_sells_nothing_at_the_reopen() public {
        uint256 friday = _tuesdayAt(vm.getBlockTimestamp(), 19 hours + 45 minutes) + 3 days;
        vm.warp(friday);
        address a = _owing("a", NVDA, 10e8, 1.2e18);
        _sellOn(a, _limits(NVDA, 5e8));
        vm.recordLogs();
        _run(_check());
        uint256 reopen = _sellAfter(vm.getRecordedLogs());
        vm.warp(friday + 1 days); // Saturday
        _backWith(a, NVDA, 3e8);
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.SellHeadsUpCleared(a, 0);
        _run(_check());
        assertEq(_headsUpAt(a), 0);
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);
        vm.warp(reopen);
        assertEq(_check().length, 0, "back above the line: no sale");
        assertEq(SPOKE.getUserSuppliedAssets(NVDA, a), backing);
    }

    /// A heads-up that the account answers (it adds backing) is cleared, so a later fall gets a new one.
    function test_a_heads_up_clears_when_the_health_is_back() public {
        address a = _owing("a", NVDA, 10e8, 1.2e18);
        _sellOn(a, _limits(NVDA, 5e8));
        _run(_check());
        assertGt(_headsUpAt(a), 0);
        _backWith(a, NVDA, 3e8);
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.SellHeadsUpCleared(a, 0);
        _run(_check());
        assertEq(_headsUpAt(a), 0);
    }

    /// NVIDIA's pool trades 3.8% under Aave's price, more than even the Act floor: its swap couldn't meet its minimum,
    /// so NVIDIA isn't for sale. With nothing else to sell there is nothing to do, and a run that lists the account
    /// anyway moves nothing and doesn't count as a failure. (Aerodrome's NVIDIA pool is deep: $230k sold into it moves
    /// it 0.2%, so the test sets Aave's price 4% above the pool's instead, which is the same gap.)
    function test_a_stock_whose_pool_cannot_fill_is_skipped_and_the_run_does_not_fail() public {
        _priceAt(NVDA, 10_400);
        address a = _owing("a", NVDA, 10e8, 1.05e18);
        _sellOn(a, _limits(NVDA, 5e8));
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, a);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None));
        assertEq(_check().length, 0);
        address[] memory work = new address[](1);
        work[0] = a;
        _run(work);
        (,, uint8 fails, uint48 cooldownUntil,,,,,) = x.accounts(a);
        assertEq(fails, 0, "no RunFailed");
        assertEq(cooldownUntil, 0);
        assertEq(SPOKE.getUserSuppliedAssets(NVDA, a), backing);
        assertEq(SPOKE.getUserTotalDebt(USDC_RESERVE, a), debt);

        vm.clearMockedCalls(); // the pool is back in line with Aave's price
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Sell));
    }

    /// Tesla (65%) would go first, but its pool can't fill: the sale moves on to NVIDIA, back to 1.4, in the same run.
    function test_the_sale_moves_on_to_the_next_stock_when_a_pool_cannot_fill() public {
        _priceAt(TSLA, 10_400);
        address a = _newJawAccount("a");
        _backWith(a, TSLA, 3e8);
        _backWith(a, NVDA, 6e8);
        _drawTo(a, 1.05e18);
        _sellOn(a, _limits(TSLA, 3e8) | _limits(NVDA, 5e8));
        uint256 tesla = SPOKE.getUserSuppliedAssets(TSLA, a);
        uint256 nvidia = SPOKE.getUserSuppliedAssets(NVDA, a);
        _run(_check());
        assertEq(SPOKE.getUserSuppliedAssets(TSLA, a), tesla, "Tesla's pool can't fill: not sold");
        assertLt(SPOKE.getUserSuppliedAssets(NVDA, a), nvidia, "NVIDIA instead");
        (,, uint8 fails,,,,,,) = x.accounts(a);
        assertEq(fails, 0);
        _assertBackTo1_4(a);
        _assertHoldsNothing();
    }

    /// The room a pool gets follows the floor: 1.5% under Aave's price is too far for a sale after a heads-up (1%),
    /// so at 1.20 there is no heads-up, but within an Act sale's 3%, so at 1.08 it sells at once.
    function test_a_pool_too_far_for_the_normal_floor_still_fills_an_act_sale() public {
        _priceAt(NVDA, 10_150);
        address watch = _owing("watch", NVDA, 10e8, 1.2e18);
        _sellOn(watch, _limits(NVDA, 5e8));
        assertEq(uint8(x.planOf(watch).action), uint8(GooseExecutor.Action.None), "no heads-up: nothing it may sell");
        address act = _owing("act", NVDA, 10e8, 1.08e18);
        _sellOn(act, _limits(NVDA, 5e8));
        GooseExecutor.Plan memory plan = x.planOf(act);
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Sell));
        assertEq(plan.reason, 1, "at once, at the Act floor");
        address[] memory work = _check();
        assertEq(work.length, 1);
        assertEq(work[0], act);
        _run(work);
        _assertBackTo1_4(act);
    }

    /// The room at its edge, on Aerodrome's real NVIDIA pool: a pool 0.75% under Aave's price (the 1% floor less the
    /// 0.25% room) is still for sale and its swaps meet their minimum, fee and price impact included; a hair further
    /// and there is no heads-up. So the room is enough for what a sale really costs in the pool.
    function test_a_pool_at_the_edge_of_the_heads_up_room_still_fills() public {
        _priceAt(NVDA, 10_077); // the pool 0.764% under Aave's price
        address a = _owing("a", NVDA, 10e8, 1.2e18);
        _sellOn(a, _limits(NVDA, 5e8));
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "just outside: no heads-up");
        _priceAt(NVDA, 10_075); // 0.744% under: just inside
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.HeadsUp));
        _run(_check());
        vm.warp(vm.getBlockTimestamp() + 30 minutes);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Sell));
        _run(_check());
        (,, uint8 fails,,,,,,) = x.accounts(a);
        assertEq(fails, 0, "the swap met its minimum");
        _assertBackTo1_4(a);
        _assertHoldsNothing();
    }

    /// The same at the Act floor's edge (3% less the room), with a sale in several slices into the one pool.
    function test_a_pool_at_the_edge_of_the_act_room_still_fills_in_slices() public {
        _priceAt(NVDA, 10_284); // 2.76% under Aave's price
        address a = _owing("a", NVDA, 10e8, 1.05e18);
        _sellOn(a, _limits(NVDA, 5e8));
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "just outside");
        _priceAt(NVDA, 10_282); // 2.74% under: just inside
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Sell));
        assertGt(_runLogged("Act room's edge", _check()), 1, "several slices");
        (,, uint8 fails,,,,,,) = x.accounts(a);
        assertEq(fails, 0, "every swap met its minimum");
        _assertBackTo1_4(a);
    }

    // ================================================================== which stock, how much

    function test_a_never_sell_stock_is_untouched() public {
        address a = _newJawAccount("a");
        _backWith(a, AAPL, 3e8);
        _backWith(a, NVDA, 6e8);
        _drawTo(a, 1.05e18);
        _sellOn(a, _limits(NVDA, 5e8)); // Apple: never sell
        uint256 apple = SPOKE.getUserSuppliedAssets(AAPL, a);
        _run(_check());
        assertEq(SPOKE.getUserSuppliedAssets(AAPL, a), apple);
        _assertBackTo1_4(a);
    }

    /// Tesla's factor (65%) is the lowest, so it goes first, up to its daily limit; NVIDIA (70%) covers the rest.
    function test_lowest_factor_first_then_spill_over_at_its_daily_limit() public {
        address a = _newJawAccount("a");
        _backWith(a, TSLA, 3e8);
        _backWith(a, NVDA, 6e8);
        _drawTo(a, 1.05e18);
        PM.Permission memory p = _sellOn(a, _limits(TSLA, 0.2e8) | _limits(NVDA, 5e8));
        uint256 tesla = SPOKE.getUserSuppliedAssets(TSLA, a);
        _run(_check());
        assertEq(tesla - SPOKE.getUserSuppliedAssets(TSLA, a), 0.2e8, "Tesla up to its limit");
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[3]).spend, 0.2e8, "Tesla's limit: spends follow reserve order");
        _assertBackTo1_4(a);
    }

    function test_keep_my_mix_sells_the_same_share_of_each() public {
        address a = _newJawAccount("a");
        _backWith(a, TSLA, 3e8);
        _backWith(a, NVDA, 6e8);
        _drawTo(a, 1.05e18);
        _sellOn(a, _limits(TSLA, 3e8) | _limits(NVDA, 5e8));
        vm.prank(a);
        x.setKeepMix(true);
        _run(_check());
        uint256 teslaLeft = SPOKE.getUserSuppliedAssets(TSLA, a);
        uint256 nvidiaLeft = SPOKE.getUserSuppliedAssets(NVDA, a);
        assertApproxEqRel(teslaLeft * 1e18 / 3e8, nvidiaLeft * 1e18 / 6e8, 0.001e18, "the same share left of each");
        _assertBackTo1_4(a);
    }

    /// The app-wide cap: with $1,000 per pool per 10 minutes, one account's sale fills NVIDIA's window, the next
    /// sale waits for the window to roll, and the lowest health is listed first.
    function test_the_pool_cap_holds_every_account_and_the_lowest_health_goes_first() public {
        GooseExecutor.Config memory c = _config();
        c.sellLimits.poolCap = 1_000e6;
        x = _deploy(c);
        address big = _owing("big", NVDA, 30e8, 1.08e18);
        _sellOn(big, _limits(NVDA, 8e8));
        address worse = _owing("worse", NVDA, 4e8, 1.05e18);
        _sellOn(worse, _limits(NVDA, 4e8));

        address[] memory work = _check();
        assertEq(work[0], worse, "the lowest health first");
        assertEq(work[1], big);
        _run(work);
        (, uint208 used) = x.pools(NVDA);
        assertLe(used, 1_000e6, "never past the cap");
        assertGt(used, 900e6);
        uint256 hf = SPOKE.getUserAccountData(big).healthFactor;
        assertGt(hf, 1.1e18, "big is out of Act");
        assertLt(hf, 1.4e18, "but waits for room");
        assertEq(_check().length, 0, "the window is full");
        // Out of Act now, but its sale was cut short: the rest goes on in the next window without a new wait.
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        _run(_check());
        assertGt(SPOKE.getUserAccountData(big).healthFactor, hf + 0.02e18, "and sells more");
    }

    // ================================================================== what the post-checks and the manager catch

    function test_a_batch_that_sells_free_stock_reverts() public {
        address a = _owing("a", NVDA, 10e8, 1.05e18);
        _sellOn(a, _limits(NVDA, 5e8));
        deal(NVDAC, a, 1e8); // a free share in the wallet
        uint256 minOut = 200e6;
        PM.Call[] memory calls = new PM.Call[](4);
        calls[0] = PM.Call(NVDAC, 0, abi.encodeCall(IERC20.approve, (address(ROUTER), 1e8)));
        calls[1] = _swap(1e8, minOut, a);
        calls[2] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(SPOKE), minOut)));
        calls[3] = _repay(a, minOut);
        vm.expectRevert(GooseExecutor.StockMoved.selector);
        this.sellWith(a, [uint256(0), 0, 0, 0, 0, 0, 0], calls);
    }

    function test_a_sale_to_someone_else_reverts() public {
        address a = _owing("a", NVDA, 10e8, 1.2e18); // the credit drawn sits in the wallet
        _sellOn(a, _limits(NVDA, 5e8));
        uint256 minOut = 200e6;
        PM.Call[] memory calls = new PM.Call[](5);
        calls[0] = _withdraw(a, 1e8);
        calls[1] = PM.Call(NVDAC, 0, abi.encodeCall(IERC20.approve, (address(ROUTER), 1e8)));
        calls[2] = _swap(1e8, minOut, attacker);
        calls[3] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(SPOKE), minOut)));
        calls[4] = _repay(a, minOut); // paid from the wallet's cash instead
        vm.expectRevert(GooseExecutor.CashLower.selector);
        this.sellWith(a, [uint256(0), 0, 0, 0, 0, 1e8, 0], calls);
    }

    function test_backing_taken_out_and_left_unsold_reverts() public {
        address a = _owing("a", NVDA, 10e8, 1.2e18);
        _sellOn(a, _limits(NVDA, 5e8));
        PM.Call[] memory calls = new PM.Call[](1);
        calls[0] = _withdraw(a, 0.5e8);
        vm.expectRevert(GooseExecutor.DebtNotLower.selector);
        this.sellWith(a, [uint256(0), 0, 0, 0, 0, 0.5e8, 0], calls);
    }

    function test_the_manager_refuses_to_sell_a_never_sell_stock_or_past_a_stocks_limit() public {
        address a = _newJawAccount("a");
        _backWith(a, AAPL, 3e8);
        _backWith(a, NVDA, 6e8);
        _drawTo(a, 1.05e18);
        _sellOn(a, _limits(NVDA, 0.5e8));
        PM.Call[] memory calls = new PM.Call[](1);
        calls[0] = PM.Call(STOCKS[AAPL], 0, abi.encodeCall(IERC20.approve, (address(ROUTER), 1)));
        vm.expectPartialRevert(UNAUTHORIZED_CALL);
        this.sellWith(a, [uint256(0), 0, 0, 0, 0, 0, 0], calls);

        calls[0] = PM.Call(NVDAC, 0, abi.encodeCall(IERC20.approve, (address(ROUTER), 0.5e8 + 1)));
        vm.expectPartialRevert(EXCEEDED_SPEND);
        this.sellWith(a, [uint256(0), 0, 0, 0, 0, 0, 0], calls);
    }

    // ================================================================== registration

    function test_registration_checks_the_stock_limits() public {
        address a = _newJawAccount("a");
        PM.Permission memory p = _sellPermission(a, _limits(NVDA, 5e8));
        _grantThroughAccount(p);
        vm.expectRevert(GooseExecutor.BadTerms.selector);
        x.register(GooseExecutor.Job.ProtectSell, a, p.start, p.end, p.salt, 1_000e6, 0);
        vm.expectRevert(GooseExecutor.BadTerms.selector);
        x.register(GooseExecutor.Job.Protect, a, p.start, p.end, p.salt, 1_000e6, _limits(NVDA, 5e8));

        // $2,290 of NVIDIA a day: more than two $1,000 caps at Aave's price.
        PM.Permission memory big = _sellPermission(a, _limits(NVDA, 10e8));
        _grantThroughAccount(big);
        vm.expectRevert(GooseExecutor.BadTerms.selector);
        x.register(GooseExecutor.Job.ProtectSell, a, big.start, big.end, big.salt, 1_000e6, _limits(NVDA, 10e8));

        vm.recordLogs();
        _grantThroughAccount(_sellPermission(a, _limits(NVDA, 4e8)));
        (bool needed, bytes memory performData) = x.checkLog(_chainlinkLog(vm.getRecordedLogs()[0]), "");
        assertTrue(needed, "a JAW grant of the sell template registers through the log trigger");
        vm.prank(forwarder);
        x.performUpkeep(performData);
        (uint8 jobs,,,,,,,,) = x.accounts(a);
        assertEq(jobs, 4);
    }
}

/// The costliest sale a run makes, measured cold: the position is built in setUp, which forge runs as its own
/// transaction. Six slices over three stocks must fit SellJob's batch cap and MAX_RUN_GAS, inside Base's 5M.
contract ProtectSellGasForkTest is SellForkBase {
    address a;

    function setUp() public {
        _setUpSell();
        a = _newJawAccount("cold");
        _backWith(a, TSLA, 1e8);
        _backWith(a, AAPL, 1e8);
        _backWith(a, NVDA, 6e8);
        _drawTo(a, 1.01e18);
        _sellOn(a, _limits(TSLA, 1e8) | _limits(AAPL, 1e8) | _limits(NVDA, 4e8));
    }

    function test_a_cold_six_slice_sale_over_three_stocks_fits() public {
        address[] memory one = new address[](1);
        one[0] = a;
        assertEq(_runLogged("cold, three stocks", one), 6, "not deferred");
        assertGt(SPOKE.getUserAccountData(a).healthFactor, 1.05e18);
    }
}

/// The costliest account to plan a sale for, measured cold: backed by all seven stocks, with Protect from savings (a
/// cent of savings, so it reads everything and finds no repay), Protect · sell on every stock and Save on. Planning
/// its sale costs about 1.4M, so its sale must still find SellJob's 3M after planning inside the run upkeep's 5M (with
/// MAX_RUN_GAS at 4.2M it was deferred on every run, and the run stopped there, so no account after it ever ran), and
/// its check must stay under CHECK_RESERVE, so the scan's gas stop keeps a check of any page under Base's 10M.
contract ProtectSellSevenStockGasForkTest is SellForkBase {
    address act; // 1.01: a sale at once
    address watch; // 1.20: a heads-up, which plans the whole sale
    address cash; // in Watch with savings: a Protect repay

    function setUp() public {
        _setUpSell();
        act = _sevenStocks("act", 1.01e18);
        watch = _sevenStocks("watch", 1.2e18);
        cash = _inWatch("cash");
    }

    function _sevenStocks(string memory name, uint256 hf) internal returns (address a) {
        a = _newJawAccount(name);
        _withSavings(a, 0.01e6);
        _backWithAllStocks(a, 1e8);
        _drawTo(a, hf);
        _turnOn(a, GooseExecutor.Job.Protect, 1_000e6);
        _turnOn(a, GooseExecutor.Job.Save, 5e6);
        uint256 t;
        for (uint256 r; r < 7; ++r) {
            t |= _limits(r, 1e8);
        }
        _sellOn(a, t);
    }

    function test_a_cold_seven_stock_sale_fits_a_5M_perform() public {
        address[] memory one = new address[](1);
        one[0] = act;
        bytes memory performData = abi.encode(GooseExecutor.Mode.Run, abi.encode(one));
        vm.recordLogs();
        vm.prank(forwarder);
        uint256 before = gasleft();
        x.performUpkeep{gas: 5_000_000}(performData);
        uint256 gas = before - gasleft();
        uint256 slices = _withdrawals(vm.getRecordedLogs());
        console.log("seven stocks from 1.01, cold, in a 5M perform: slices, gas", slices, gas);
        assertGt(slices, 0, "sold, not deferred");
        (,, uint8 fails,,,,,,) = x.accounts(act);
        assertEq(fails, 0);
        assertGt(SPOKE.getUserAccountData(act).healthFactor, 1.05e18);
    }

    /// A sale that can't fit (here a perform given only 4M) is deferred, and the accounts after it still run.
    function test_a_deferred_sale_does_not_hold_up_the_accounts_after_it() public {
        address[] memory two = new address[](2);
        (two[0], two[1]) = (act, cash);
        bytes memory performData = abi.encode(GooseExecutor.Mode.Run, abi.encode(two));
        uint256 backing = SPOKE.getUserAccountData(act).totalCollateralValue;
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.RunDeferred(act);
        vm.prank(forwarder);
        x.performUpkeep{gas: 4_000_000}(performData);
        assertEq(SPOKE.getUserAccountData(act).totalCollateralValue, backing, "the sale waits for the next run");
        (,, uint8 fails,,,,,,) = x.accounts(act);
        assertEq(fails, 0, "a deferral isn't a failure");
        assertGt(SPOKE.getUserAccountData(cash).healthFactor, 1.6e18, "the next account was repaid in the same run");
    }

    /// Under CHECK_RESERVE less what the scan's try keeps back (1/64), so the scan can always afford the costliest
    /// account it starts.
    function test_a_cold_seven_stock_heads_up_plan_stays_under_the_check_reserve() public view {
        uint256 before = gasleft();
        GooseExecutor.Plan memory p = x.planOf(watch);
        uint256 gas = before - gasleft();
        console.log("seven stocks at 1.20, cold planOf gas", gas);
        assertEq(uint8(p.action), uint8(GooseExecutor.Action.HeadsUp));
        assertLt(gas, 1_450_000, "under CHECK_RESERVE (1.5M) less 1/64");
    }
}
