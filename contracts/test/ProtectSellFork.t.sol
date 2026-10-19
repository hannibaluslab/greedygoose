// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IAeroFactory, IAeroPool, IAeroRouter, IERC20} from "../src/IProtocols.sol";
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
    /// Protect's target (config/risk.ts CASH_AGENT, the deploy default).
    uint256 constant TARGET = 1.12e18;
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
        SellJob.check(x.env(), account, b, TARGET);
    }

    /// A fresh JAW account backing a credit line with `sharesRaw` of stock `r`, drawn to health `hf`.
    function _owing(string memory name, uint256 r, uint256 sharesRaw, uint256 hf) internal returns (address a) {
        a = _newJawAccount(name);
        _backWith(a, r, sharesRaw);
        _drawTo(a, hf);
    }

    /// Protect · sell switched on the way JAW's screen grants it, with a $1,000 USDC limit.
    function _sellOn(address a, uint256 t) internal returns (PM.Permission memory) {
        return _sellOn(a, t, 1_000e6);
    }

    function _sellOn(address a, uint256 t, uint160 cap) internal returns (PM.Permission memory p) {
        p = _sellPermission(a, t, cap);
        _grantThroughAccount(p);
        x.register(GooseExecutor.Job.ProtectSell, a, p.start, p.end, p.salt, cap, t);
    }

    function _sellPermission(address a, uint256 t) internal returns (PM.Permission memory) {
        return _sellPermission(a, t, 1_000e6);
    }

    function _sellPermission(address a, uint256 t, uint160 cap) internal returns (PM.Permission memory) {
        uint48 start = uint48(vm.getBlockTimestamp());
        return x.permissionFor(
            GooseExecutor.Job.ProtectSell,
            a,
            GooseExecutor.Grant(start, start + 365 days, cap),
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

    /// Back at the target, 1.12, no further, and the rescue over (Adrian, 2026-10-19).
    function _assertBackTo1_12(address a) internal view {
        uint256 hf = SPOKE.getUserAccountData(a).healthFactor;
        assertApproxEqAbs(hf, TARGET, 0.005e18, "back to 1.12");
        assertGe(hf, 1.119e18);
        assertEq(_rescueAt(a), 0, "the rescue is over");
    }

    function _price(uint256 r) internal view returns (uint256) {
        return x.ORACLE().getReservePrice(r);
    }

    /// Aave's price for stock `r`: its Aerodrome pool's, times `bps` / 10,000.
    function _priceAt(uint256 r, uint256 bps) internal {
        uint256 price = JobBase.poolPrice(x.env(), r) * bps / 10_000;
        vm.mockCall(address(x.ORACLE()), abi.encodeWithSignature("getReservePrice(uint256)", r), abi.encode(price));
    }

    /// Stock `r`'s Aerodrome pool reads `bps` / 10,000 of its real price, for the executor's fill check only: the swaps
    /// themselves still run against the pool's real state. Aave's price, and so the health, doesn't move.
    function _poolReadsAt(uint256 r, uint256 bps) internal {
        address pool = AERO_FACTORY.getPool(STOCKS[r], address(USDC), 10);
        (uint160 sqrtPrice, int24 tick, uint16 i, uint16 n, uint16 next, bool unlocked) = IAeroPool(pool).slot0();
        uint256 root = _sqrt(bps * 1e32); // √(bps / 10,000) × 1e18
        // The price in USDC a share goes with the square root when USDC is token1, and against it when it is token0.
        uint256 moved = address(USDC) < STOCKS[r] ? uint256(sqrtPrice) * 1e18 / root : uint256(sqrtPrice) * root / 1e18;
        vm.mockCall(
            pool,
            abi.encodeWithSelector(IAeroPool.slot0.selector),
            abi.encode(uint160(moved), tick, i, n, next, unlocked)
        );
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

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 v = y / 2 + 1;
            while (v < z) {
                z = v;
                v = (y / v + v) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}

/// Protect · sell against the real JAW manager, the Aave V4 Equities Hub and Aerodrome's stock pools on a Base fork,
/// with fresh JAW accounts granted the way JAW's screen grants. Every stock is a StockDouble holding the balances the
/// hub and the pools really hold (ForkBase), so the swaps run against the pools' real liquidity and prices. Protect's
/// line (Adrian, 2026-10-19): sales at once from under 1.03, each ending at 1.12 or failing for a stated reason, a
/// rescue savings couldn't finish going on above the line, and nothing from above it.
contract ProtectSellForkTest is SellForkBase {
    function setUp() public {
        _setUpSell();
    }

    // ================================================================== from under the line

    /// Under Protect's line (1.025) on a weekday: a sale at once, with no heads-up, back to 1.12.
    function test_under_the_line_it_sells_at_once_back_to_1_12() public {
        address a = _owing("a", NVDA, 10e8, 1.025e18);
        PM.Permission memory p = _sellOn(a, _limits(NVDA, 5e8));
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);

        GooseExecutor.Plan memory plan = x.planOf(a);
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Sell));
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.ProtectSold(a, [uint256(0), 0, 0, 0, 0, 0, 0], 0, 0, 0);
        _runLogged("from 1.025", _check());

        _assertBackTo1_12(a);
        uint256 sold = backing - SPOKE.getUserSuppliedAssets(NVDA, a);
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[2]).spend, sold, "the stock's limit is charged what was sold");
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[0]).spend, plan.amount, "USDC's limit is charged the repay");
        (, uint208 used) = x.pools(NVDA);
        assertApproxEqAbs(used, sold * _price(NVDA) / 1e10, 1, "counted against the pool's window");
        _assertHoldsNothing();
        assertEq(_check().length, 0, "at the target: nothing more");
    }

    function test_at_1_02_it_sells_in_slices() public {
        address a = _owing("a", NVDA, 10e8, 1.02e18);
        _sellOn(a, _limits(NVDA, 5e8));
        assertGt(_runLogged("from 1.02", _check()), 1, "more than one withdrawal: Aave checks health after each");
        _assertBackTo1_12(a);
    }

    /// From 1.01 a run's six slices may not reach 1.12: the rescue then goes on in the next runs, above the line too,
    /// until it does.
    function test_from_1_01_the_rescue_goes_on_until_1_12() public {
        address a = _owing("a", NVDA, 10e8, 1.01e18);
        _sellOn(a, _limits(NVDA, 5e8));
        assertEq(_runLogged("from 1.01, first run", _check()), 6);
        for (uint256 run = 2; SPOKE.getUserAccountData(a).healthFactor < TARGET - 0.005e18; ++run) {
            assertLt(run, 5, "a few runs at most");
            assertEq(_rescueAt(a), vm.getBlockTimestamp(), "the rescue goes on");
            assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Sell), "on, wherever the health is now");
            vm.roll(vm.getBlockNumber() + 1);
            _runLogged("from 1.01, a later run", _check());
        }
        _assertBackTo1_12(a);
    }

    // ================================================================== above the line; cash before stock

    /// Above Protect's line nothing sells, in Watch (1.30) or in Act (1.08, a warning only), with Protect from cash and
    /// selling both on and stock to sell; just under it, cash goes first.
    function test_above_the_line_nothing_and_under_it_cash_first() public {
        address a = _owing("a", NVDA, 10e8, 1.3e18);
        _withSavings(a, 100e6);
        _turnOn(a, GooseExecutor.Job.Protect, 1_000e6);
        _sellOn(a, _limits(NVDA, 5e8));
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "1.30");
        _drawMoreTo(a, 1.08e18);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "1.08: Act only warns");
        _drawMoreTo(a, 1.031e18);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "1.031: still above the line");
        assertEq(_check().length, 0);
        _drawMoreTo(a, 1.029e18);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Repay), "1.029: under it, cash first");
    }

    /// Under the line with enough cash: Protect repays from it back to 1.12 and sells nothing, though selling is on.
    function test_cash_that_reaches_the_target_means_no_sale() public {
        address a = _owing("a", NVDA, 10e8, 1.02e18);
        _withSavings(a, 1_000e6);
        _turnOn(a, GooseExecutor.Job.Protect, 1_000e6);
        _sellOn(a, _limits(NVDA, 5e8));
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Repay), "cash first");
        _run(_check());
        _assertBackTo1_12(a);
        assertEq(_check().length, 0, "at the target: nothing more");
        assertEq(SPOKE.getUserSuppliedAssets(NVDA, a), backing, "nothing sold");
    }

    /// Under the line with too little cash: Protect repays what the cash has, which lifts the credit over the line but
    /// short of 1.12, and the rescue sells the rest, back to 1.12.
    function test_cash_short_of_the_target_then_the_sale() public {
        address a = _owing("a", NVDA, 10e8, 1.02e18);
        _withSavings(a, SPOKE.getUserTotalDebt(USDC_RESERVE, a) / 50); // 2% of what's owed
        _turnOn(a, GooseExecutor.Job.Protect, 1_000e6);
        _sellOn(a, _limits(NVDA, 5e8));
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);
        _run(_check());
        assertLt(AUSDC.balanceOf(a), 2, "the cash went first");
        assertEq(SPOKE.getUserSuppliedAssets(NVDA, a), backing, "nothing sold yet");
        uint256 hf = SPOKE.getUserAccountData(a).healthFactor;
        assertGt(hf, 1.03e18, "over the line now");
        assertLt(hf, TARGET, "but short of the target");
        assertGt(_rescueAt(a), 0, "the rescue goes on");
        GooseExecutor.Plan memory plan = x.planOf(a);
        assertEq(uint8(plan.job), uint8(GooseExecutor.Job.ProtectSell));
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Sell));
        _run(_check());
        assertLt(SPOKE.getUserSuppliedAssets(NVDA, a), backing, "then the sale");
        _assertBackTo1_12(a);
    }

    // ================================================================== when it doesn't sell

    function test_never_on_a_weekend() public {
        address a = _owing("a", NVDA, 10e8, 1.02e18);
        _sellOn(a, _limits(NVDA, 5e8));
        vm.warp(vm.getBlockTimestamp() + 4 days); // Saturday
        assertTrue(x.frozen(vm.getBlockTimestamp()));
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None));
        assertEq(_check().length, 0);
        vm.warp(vm.getBlockTimestamp() + 2 days); // Monday: prices live again
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Sell));
    }

    /// A rescue started just before the Friday freeze (cash short of the target) waits out the weekend, and the sale
    /// finishes it when prices reopen.
    function test_a_rescue_waits_out_the_weekend_and_finishes_at_the_reopen() public {
        uint256 friday = _tuesdayAt(vm.getBlockTimestamp(), 19 hours + 45 minutes) + 3 days;
        vm.warp(friday);
        address a = _owing("a", NVDA, 10e8, 1.02e18);
        _withSavings(a, SPOKE.getUserTotalDebt(USDC_RESERVE, a) / 50);
        _turnOn(a, GooseExecutor.Job.Protect, 1_000e6);
        _sellOn(a, _limits(NVDA, 5e8));
        _run(_check()); // the cash, at 19:45 on Friday
        assertGt(_rescueAt(a), 0);
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);

        vm.warp(friday + 30 minutes);
        assertTrue(x.frozen(vm.getBlockTimestamp()));
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "Friday 20:15: prices are held");
        uint256 reopen = x.nextFreeze(friday) + 2 days; // Sunday 20:00 in New York, give or take a clock change
        while (x.frozen(reopen)) {
            reopen += 1 hours;
        }
        vm.warp(reopen - 1 hours);
        assertEq(_check().length, 0, "nor over the weekend");
        assertEq(SPOKE.getUserSuppliedAssets(NVDA, a), backing);
        vm.warp(reopen);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Sell), "the reopen: the rescue goes on");
        _run(_check());
        _assertBackTo1_12(a);
    }

    /// NVIDIA's pool reads 3.8% under Aave's price, past the 3% floor less the room: its swap couldn't meet its
    /// minimum, so NVIDIA isn't for sale. With nothing else to sell there is nothing to do, and a run that lists the
    /// account anyway moves nothing and doesn't count as a failure. Once the pool is back in line, it sells.
    function test_a_stock_whose_pool_cannot_fill_is_skipped_and_the_run_does_not_fail() public {
        address a = _owing("a", NVDA, 10e8, 1.02e18);
        _sellOn(a, _limits(NVDA, 5e8));
        _poolReadsAt(NVDA, 9_620);
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, a);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None));
        assertEq(_check().length, 0);
        address[] memory work = new address[](1);
        work[0] = a;
        _run(work);
        (,, uint8 fails, uint48 cooldownUntil,,,,,,) = x.accounts(a);
        assertEq(fails, 0, "no RunFailed");
        assertEq(cooldownUntil, 0);
        assertEq(SPOKE.getUserSuppliedAssets(NVDA, a), backing);
        assertEq(SPOKE.getUserTotalDebt(USDC_RESERVE, a), debt);

        vm.clearMockedCalls(); // the pool is back in line with Aave's price
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Sell));
    }

    /// A sale whose batch can't run (here every swap reverts, as one under its floor would after someone moved the
    /// pool) moves nothing and is skipped, not counted as a failure, so it can't add up to switching Protect off
    /// (money-safety review, B1). The next run, the pool back, sells.
    function test_a_sale_batch_that_cannot_run_is_skipped_not_failed() public {
        address a = _owing("a", NVDA, 10e8, 1.02e18);
        _sellOn(a, _limits(NVDA, 5e8));
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);
        vm.mockCallRevert(address(ROUTER), abi.encodeWithSelector(IAeroRouter.exactInputSingle.selector), "too little");
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.SaleSkipped(a);
        _run(_check());
        assertEq(SPOKE.getUserSuppliedAssets(NVDA, a), backing, "nothing moved");
        (,, uint8 fails, uint48 cooldownUntil,,,,,,) = x.accounts(a);
        assertEq(fails, 0, "not a failure");
        assertEq(cooldownUntil, 0);
        vm.clearMockedCalls();
        _run(_check());
        _assertBackTo1_12(a);
    }

    /// A rescue the account finished on its own ends in Protect · sell too, for an account without Protect from cash.
    function test_a_rescue_the_account_finished_ends_in_the_sell_job() public {
        address a = _owing("a", NVDA, 10e8, 1.01e18);
        _sellOn(a, _limits(NVDA, 5e8));
        _run(_check()); // six slices from 1.01
        if (_rescueAt(a) == 0) return; // reached 1.12 in one run on this fork: nothing left to end
        _backWith(a, NVDA, 10e8); // twice the backing: far over the target
        GooseExecutor.Plan memory plan = x.planOf(a);
        assertEq(uint8(plan.job), uint8(GooseExecutor.Job.ProtectSell));
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.EndRescue));
        uint256 backing = SPOKE.getUserSuppliedAssets(NVDA, a);
        _run(_check());
        assertEq(_rescueAt(a), 0, "ended");
        assertEq(SPOKE.getUserSuppliedAssets(NVDA, a), backing, "nothing sold");
    }

    /// Tesla (65%) would go first, but its pool can't fill: the sale moves on to NVIDIA, back to 1.12, in the same run.
    function test_the_sale_moves_on_to_the_next_stock_when_a_pool_cannot_fill() public {
        address a = _newJawAccount("a");
        _backWith(a, TSLA, 3e8);
        _backWith(a, NVDA, 6e8);
        _drawTo(a, 1.02e18);
        _sellOn(a, _limits(TSLA, 3e8) | _limits(NVDA, 5e8));
        _poolReadsAt(TSLA, 9_620);
        uint256 tesla = SPOKE.getUserSuppliedAssets(TSLA, a);
        uint256 nvidia = SPOKE.getUserSuppliedAssets(NVDA, a);
        _run(_check());
        assertEq(SPOKE.getUserSuppliedAssets(TSLA, a), tesla, "Tesla's pool can't fill: not sold");
        assertLt(SPOKE.getUserSuppliedAssets(NVDA, a), nvidia, "NVIDIA instead");
        (,, uint8 fails,,,,,,,) = x.accounts(a);
        assertEq(fails, 0);
        _assertBackTo1_12(a);
        _assertHoldsNothing();
    }

    /// The room at the floor's edge (3% less the 0.25% room), on Aerodrome's real NVIDIA pool, with a sale in several
    /// slices into the one pool: a pool 2.74% under Aave's price is still for sale and its swaps meet their minimum,
    /// fee and price impact included; a hair further and there is nothing to sell.
    function test_a_pool_at_the_edge_of_the_room_still_fills_in_slices() public {
        _priceAt(NVDA, 10_284); // 2.76% under Aave's price
        address a = _owing("a", NVDA, 10e8, 1.02e18);
        _sellOn(a, _limits(NVDA, 5e8));
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "just outside");
        _priceAt(NVDA, 10_282); // 2.74% under: just inside
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Sell));
        assertGt(_runLogged("the room's edge", _check()), 1, "several slices");
        (,, uint8 fails,,,,,,,) = x.accounts(a);
        assertEq(fails, 0, "every swap met its minimum");
        uint256 hf = SPOKE.getUserAccountData(a).healthFactor;
        assertGe(hf, 1.119e18, "back to 1.12");
        assertLe(hf, TARGET + 0.01e18, "and within the overshoot");
    }

    // ================================================================== which stock, how much

    function test_a_never_sell_stock_is_untouched() public {
        address a = _newJawAccount("a");
        _backWith(a, AAPL, 3e8);
        _backWith(a, NVDA, 6e8);
        _drawTo(a, 1.02e18);
        _sellOn(a, _limits(NVDA, 5e8)); // Apple: never sell
        uint256 apple = SPOKE.getUserSuppliedAssets(AAPL, a);
        _run(_check());
        assertEq(SPOKE.getUserSuppliedAssets(AAPL, a), apple);
        _assertBackTo1_12(a);
    }

    /// Tesla's factor (65%) is the lowest, so it goes first, up to its daily limit; NVIDIA (70%) covers the rest.
    function test_lowest_factor_first_then_spill_over_at_its_daily_limit() public {
        address a = _newJawAccount("a");
        _backWith(a, TSLA, 3e8);
        _backWith(a, NVDA, 6e8);
        _drawTo(a, 1.02e18);
        PM.Permission memory p = _sellOn(a, _limits(TSLA, 0.2e8) | _limits(NVDA, 5e8));
        uint256 tesla = SPOKE.getUserSuppliedAssets(TSLA, a);
        _run(_check());
        assertEq(tesla - SPOKE.getUserSuppliedAssets(TSLA, a), 0.2e8, "Tesla up to its limit");
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[3]).spend, 0.2e8, "Tesla's limit: spends follow reserve order");
        _assertBackTo1_12(a);
    }

    function test_keep_my_mix_sells_the_same_share_of_each() public {
        address a = _newJawAccount("a");
        _backWith(a, TSLA, 3e8);
        _backWith(a, NVDA, 6e8);
        _drawTo(a, 1.02e18);
        _sellOn(a, _limits(TSLA, 3e8) | _limits(NVDA, 5e8));
        vm.prank(a);
        x.setKeepMix(true);
        _run(_check());
        uint256 teslaLeft = SPOKE.getUserSuppliedAssets(TSLA, a);
        uint256 nvidiaLeft = SPOKE.getUserSuppliedAssets(NVDA, a);
        assertApproxEqRel(teslaLeft * 1e18 / 3e8, nvidiaLeft * 1e18 / 6e8, 0.001e18, "the same share left of each");
        _assertBackTo1_12(a);
    }

    /// The app-wide cap: with $1,000 per pool per 10 minutes, the lowest health is listed first and the two sales share
    /// NVIDIA's window. The bigger one needs more than the window holds: its rescue goes on run after run, never past
    /// the cap, waits while the window is full, and ends at 1.12 once it has rolled. Deployed as production will be,
    /// with no amount limit, so only the pool's window holds it back.
    function test_the_pool_cap_holds_every_account_and_a_rescue_goes_on_when_the_window_rolls() public {
        GooseExecutor.Config memory c = _config();
        c.sellLimits.poolCap = 1_000e6;
        c.capMax = type(uint160).max;
        x = _deploy(c);
        // Sized in dollars at Aave's price, so the test holds whatever NVIDIA trades at: $8,000 and $900.
        address big = _owing("big", NVDA, 8_000e6 * 1e10 / _price(NVDA), 1.025e18);
        _sellOn(big, _limits(NVDA, 8_000e6 * 1e10 / _price(NVDA) / 1e4 * 1e4), type(uint160).max);
        address worse = _owing("worse", NVDA, 900e6 * 1e10 / _price(NVDA), 1.01e18);
        _sellOn(worse, _limits(NVDA, 4e8));

        address[] memory work = _check();
        assertEq(work[0], worse, "the lowest health first");
        assertEq(work[1], big);
        _run(work);
        assertGt(_rescueAt(big), 0, "big is short of 1.12: its rescue goes on");

        // Runs go on while the window has room (a run's six slices may not finish either rescue), then wait for it.
        uint256 rolled;
        for (uint256 i; _rescueAt(big) != 0 || _rescueAt(worse) != 0; ++i) {
            assertLt(i, 30, "a few rounds");
            (, uint208 used) = x.pools(NVDA);
            assertLe(used, 1_000e6, "never past the cap");
            address[] memory next = _check();
            if (next.length == 0) {
                vm.warp(vm.getBlockTimestamp() + 10 minutes); // the window is full: wait for it to roll
                ++rolled;
            } else {
                _run(next);
            }
            vm.roll(vm.getBlockNumber() + 1);
        }
        assertGt(rolled, 0, "the cap held a rescue back at least once");
        _assertBackTo1_12(worse);
        _assertBackTo1_12(big);
    }

    // ================================================================== what the post-checks and the manager catch

    function test_a_batch_that_sells_free_stock_reverts() public {
        address a = _owing("a", NVDA, 10e8, 1.02e18);
        _sellOn(a, _limits(NVDA, 5e8));
        deal(NVDAC, a, 1e8); // a free share in the wallet
        uint256 minOut = 10e6; // a tenth of a share: small enough to stay under the target, so the stock check speaks
        PM.Call[] memory calls = new PM.Call[](4);
        calls[0] = PM.Call(NVDAC, 0, abi.encodeCall(IERC20.approve, (address(ROUTER), 0.1e8)));
        calls[1] = _swap(0.1e8, minOut, a);
        calls[2] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(SPOKE), minOut)));
        calls[3] = _repay(a, minOut);
        vm.expectRevert(GooseExecutor.StockMoved.selector);
        this.sellWith(a, [uint256(0), 0, 0, 0, 0, 0, 0], calls);
    }

    /// A tenth of a share at 1.05: within Aave's withdrawal check and under the target, so the cash check speaks.
    function test_a_sale_to_someone_else_reverts() public {
        address a = _owing("a", NVDA, 10e8, 1.05e18); // the credit drawn sits in the wallet
        _sellOn(a, _limits(NVDA, 5e8));
        uint256 minOut = 15e6;
        PM.Call[] memory calls = new PM.Call[](5);
        calls[0] = _withdraw(a, 0.1e8);
        calls[1] = PM.Call(NVDAC, 0, abi.encodeCall(IERC20.approve, (address(ROUTER), 0.1e8)));
        calls[2] = _swap(0.1e8, minOut, attacker);
        calls[3] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(SPOKE), minOut)));
        calls[4] = _repay(a, minOut); // paid from the wallet's cash instead
        vm.expectRevert(GooseExecutor.CashLower.selector);
        this.sellWith(a, [uint256(0), 0, 0, 0, 0, 0.1e8, 0], calls);
    }

    /// No amount limit, but never past the target: a batch that takes the credit well past 1.12 reverts (here it repays
    /// a fifth of what's owed, which the post-check catches before anything else).
    function test_a_batch_past_the_target_reverts() public {
        address a = _owing("a", NVDA, 10e8, 1.02e18);
        _sellOn(a, _limits(NVDA, 5e8));
        uint256 fifth = SPOKE.getUserTotalDebt(USDC_RESERVE, a) / 5;
        PM.Call[] memory calls = new PM.Call[](2);
        calls[0] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(SPOKE), fifth)));
        calls[1] = _repay(a, fifth);
        vm.expectRevert(GooseExecutor.Overshoot.selector);
        this.sellWith(a, [uint256(0), 0, 0, 0, 0, 0, 0], calls);
    }

    function test_backing_taken_out_and_left_unsold_reverts() public {
        address a = _owing("a", NVDA, 10e8, 1.1e18);
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
        _drawTo(a, 1.02e18);
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
        bytes memory approved = vm.getRecordedLogs()[0].data;
        (bool ok,,,) = x.registrationOf(approved);
        assertTrue(ok, "a JAW grant of the sell template registers from its event data");
        x.registerApproved(approved);
        (uint8 jobs,,,,,,,,,) = x.accounts(a);
        assertEq(jobs, 4);
        assertEq(x.protectMemberCount(), 1, "on the Protect list");
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
/// its sale costs about 1.4M, so its sale must still find SellJob's 3M after planning inside a run's 5M (with
/// MAX_RUN_GAS at 4.2M it was deferred on every run, and the run stopped there, so no account after it ever ran), and
/// its check must stay under CHECK_RESERVE, so the scan's gas stop keeps a check of any page under Base's 10M.
contract ProtectSellSevenStockGasForkTest is SellForkBase {
    address act; // 1.01: a sale at once
    address cash; // under the line with savings: a Protect repay

    function setUp() public {
        _setUpSell();
        act = _sevenStocks("act", 1.01e18);
        cash = _inAct("cash");
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
        bytes memory performData = abi.encode(one);
        vm.recordLogs();
        vm.prank(forwarder);
        uint256 before = gasleft();
        x.performUpkeep{gas: 5_000_000}(performData);
        uint256 gas = before - gasleft();
        uint256 slices = _withdrawals(vm.getRecordedLogs());
        console.log("seven stocks from 1.01, cold, in a 5M perform: slices, gas", slices, gas);
        assertGt(slices, 0, "sold, not deferred");
        (,, uint8 fails,,,,,,,) = x.accounts(act);
        assertEq(fails, 0);
        assertGt(SPOKE.getUserAccountData(act).healthFactor, 1.05e18);
    }

    /// A sale that can't fit (here a perform given only 4M) is deferred, and the accounts after it still run.
    function test_a_deferred_sale_does_not_hold_up_the_accounts_after_it() public {
        address[] memory two = new address[](2);
        (two[0], two[1]) = (act, cash);
        bytes memory performData = abi.encode(two);
        uint256 backing = SPOKE.getUserAccountData(act).totalCollateralValue;
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.RunDeferred(act);
        vm.prank(forwarder);
        x.performUpkeep{gas: 4_000_000}(performData);
        assertEq(SPOKE.getUserAccountData(act).totalCollateralValue, backing, "the sale waits for the next run");
        (,, uint8 fails,,,,,,,) = x.accounts(act);
        assertEq(fails, 0, "a deferral isn't a failure");
        assertGt(SPOKE.getUserAccountData(cash).healthFactor, 1.11e18, "the next account was repaid in the same run");
    }

    /// A runner that sends too little gas to plan a sale (here the account starts with about 1.65M) defers it rather
    /// than running out of gas mid plan, which would count as a failure (money-safety review, B1).
    function test_a_run_too_short_to_plan_a_sale_defers_it() public {
        address[] memory one = new address[](1);
        one[0] = act;
        uint256 backing = SPOKE.getUserAccountData(act).totalCollateralValue;
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.RunDeferred(act);
        vm.prank(forwarder);
        x.performUpkeep{gas: 2_000_000}(abi.encode(one));
        (,, uint8 fails,,,,,,,) = x.accounts(act);
        assertEq(fails, 0, "a deferral, not a failure");
        assertEq(SPOKE.getUserAccountData(act).totalCollateralValue, backing, "nothing sold yet");
    }

    /// Under CHECK_RESERVE less what the scan's try keeps back (1/64), so the scan can always afford the costliest
    /// account it starts.
    function test_a_cold_seven_stock_sale_plan_stays_under_the_check_reserve() public view {
        uint256 before = gasleft();
        GooseExecutor.Plan memory p = x.planOf(act);
        uint256 gas = before - gasleft();
        console.log("seven stocks at 1.01, cold planOf gas", gas);
        assertEq(uint8(p.action), uint8(GooseExecutor.Action.Sell));
        assertLt(gas, 1_450_000, "under CHECK_RESERVE (1.5M) less 1/64");
    }
}
