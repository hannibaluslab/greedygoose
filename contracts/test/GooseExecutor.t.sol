// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Log} from "chainlink/automation/interfaces/ILogAutomation.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../src/IJustaPermissionManager.sol";
import {IAaveOracle, IAaveV3Pool, IERC20, ISpoke} from "../src/IProtocols.sol";
import {Amounts, Thresholds} from "../src/CashRules.sol";
import {SellLimits} from "../src/SellRules.sol";
import {NyCalendar} from "../src/NyCalendar.sol";
import {DeployExecutor} from "../script/DeployExecutor.s.sol";
import {ExecutorHarness} from "./ExecutorHarness.sol";

/// No fork: construction, admin (product decision 2: pause at once, everything else behind a 7-day public delay),
/// who may run, and the log trigger's filter. Runs and registration against the real manager are in
/// GooseExecutorFork.t.sol.
contract GooseExecutorTest is Test {
    ExecutorHarness x;
    DeployExecutor deploy = new DeployExecutor();
    address owner = makeAddr("owner");
    address forwarder = makeAddr("forwarder");
    address stranger = makeAddr("stranger");
    address manager = makeAddr("manager");
    address account = makeAddr("account");

    function setUp() public {
        vm.warp(1_792_000_000); // Wed 2026-10-14
        x = new ExecutorHarness(_config());
    }

    // ------------------------------------------------------------------ construction

    function test_constructor_refuses_zero_addresses_and_out_of_bounds_numbers() public {
        GooseExecutor.Config memory c = _config();
        c.owner = address(0);
        vm.expectRevert(GooseExecutor.ZeroValue.selector);
        new GooseExecutor(c);

        c = _config();
        c.pageSize = 0;
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        new GooseExecutor(c);

        c = _config();
        c.capMax = 0;
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        new GooseExecutor(c);

        c = _config();
        c.thresholds.targetHf = c.thresholds.triggerHf; // no headroom
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        new GooseExecutor(c);

        c = _config();
        c.amounts.keepBack = 5e6 + 1;
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        new GooseExecutor(c);

        c = _config();
        c.sellLimits.targetHf = c.sellLimits.headsUpHf; // a sale would stop at the heads-up line
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        new GooseExecutor(c);

        c = _config();
        c.stocks[3] = address(0);
        vm.expectRevert(GooseExecutor.ZeroValue.selector);
        new GooseExecutor(c);

        c = _config();
        c.router = address(0);
        vm.expectRevert(GooseExecutor.ZeroValue.selector);
        new GooseExecutor(c);
    }

    function test_starts_with_the_deploy_defaults_and_no_forwarder() public view {
        (uint64 trigger, uint64 target, uint64 drop, uint64 floor) = x.thresholds();
        assertEq(abi.encode(trigger, target, drop, floor), abi.encode(deploy.thresholds()));
        (uint64 minRepay, uint64 minSave, uint64 keepBack, uint32 window, uint8 maxSaves) = x.amounts();
        assertEq(abi.encode(minRepay, minSave, keepBack, window, maxSaves), abi.encode(deploy.amounts()));
        assertEq(x.owner(), owner);
        assertFalse(x.isForwarder(forwarder));
        assertFalse(x.bootstrapped());
    }

    /// With the deploy defaults (trigger 1.50, drop 15%, floor 1.10) any loan Weekend Shield would trim is already in
    /// Watch: 1.10 / 0.85 = 1.29 < 1.50. These are Leo's numbers (plan.ts); calibration is plan item 6 step 9.
    function test_with_the_defaults_weekend_shield_never_acts_before_watch() public view {
        Thresholds memory t = deploy.thresholds();
        assertLt(uint256(t.stressFloorHf) * 1e18 / (1e18 - t.stressDrop), t.triggerHf);
    }

    // ------------------------------------------------------------------ who may run

    function test_only_forwarders_may_perform_and_only_the_executor_may_run_an_account() public {
        bytes memory run = abi.encode(GooseExecutor.Mode.Run, abi.encode(new address[](0)));
        vm.prank(stranger);
        vm.expectRevert(GooseExecutor.NotForwarder.selector);
        x.performUpkeep(run);

        vm.prank(owner);
        vm.expectRevert(GooseExecutor.NotForwarder.selector);
        x.performUpkeep(run);

        vm.prank(stranger);
        vm.expectRevert(GooseExecutor.OnlySelf.selector);
        x.runAccount(account, false, false);

        _bootstrap();
        vm.prank(forwarder);
        x.performUpkeep(run);
        vm.prank(forwarder);
        vm.expectRevert(GooseExecutor.TooMuchWork.selector);
        x.performUpkeep(abi.encode(GooseExecutor.Mode.Run, abi.encode(new address[](9))));
    }

    function test_pause_is_immediate_and_stops_runs_and_checks() public {
        _bootstrap();
        vm.prank(stranger);
        vm.expectRevert(GooseExecutor.NotOwner.selector);
        x.pause();

        vm.prank(owner);
        x.pause();
        vm.prank(forwarder);
        vm.expectRevert(GooseExecutor.RunsPaused.selector);
        x.performUpkeep(abi.encode(GooseExecutor.Mode.Run, abi.encode(new address[](0))));
        (bool needed,) = x.checkUpkeep(abi.encode(uint256(0), uint256(1)));
        assertFalse(needed);

        vm.prank(owner);
        x.unpause();
        vm.prank(forwarder);
        x.performUpkeep(abi.encode(GooseExecutor.Mode.Run, abi.encode(new address[](0))));
    }

    function test_bootstrap_works_once() public {
        _bootstrap();
        address[] memory more = new address[](1);
        more[0] = stranger;
        vm.prank(owner);
        vm.expectRevert(GooseExecutor.AlreadyBootstrapped.selector);
        x.bootstrap(more);
        assertFalse(x.isForwarder(stranger));
    }

    function test_removing_a_forwarder_is_immediate() public {
        _bootstrap();
        vm.prank(owner);
        x.removeForwarder(forwarder);
        vm.prank(forwarder);
        vm.expectRevert(GooseExecutor.NotForwarder.selector);
        x.performUpkeep(abi.encode(GooseExecutor.Mode.Run, abi.encode(new address[](0))));
    }

    // ------------------------------------------------------------------ the 7-day delay

    function test_a_new_forwarder_waits_seven_days() public {
        bytes memory value = abi.encode(stranger);
        vm.prank(owner);
        (bytes32 id, uint48 eta) = x.queueChange(GooseExecutor.Change.AddForwarder, value);
        assertEq(eta, vm.getBlockTimestamp() + 7 days);
        assertEq(x.queued(id), eta);

        vm.warp(eta - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GooseExecutor.TooEarly.selector, eta));
        x.applyChange(GooseExecutor.Change.AddForwarder, value, 0);

        vm.warp(eta);
        vm.prank(stranger);
        vm.expectRevert(GooseExecutor.NotOwner.selector);
        x.applyChange(GooseExecutor.Change.AddForwarder, value, 0);

        vm.prank(owner);
        x.applyChange(GooseExecutor.Change.AddForwarder, value, 0);
        assertTrue(x.isForwarder(stranger));
        assertEq(x.queued(id), 0);

        vm.prank(owner);
        vm.expectRevert(GooseExecutor.NotQueued.selector);
        x.applyChange(GooseExecutor.Change.AddForwarder, value, 0); // once only
    }

    function test_thresholds_amounts_and_owner_change_after_the_delay() public {
        Thresholds memory t = Thresholds(1.4e18, 1.6e18, 0.2e18, 1.05e18);
        Amounts memory a = Amounts(1e6, 2e6, 0, 3 hours, 4);
        address newOwner = makeAddr("new owner");
        vm.startPrank(owner);
        x.queueChange(GooseExecutor.Change.SetThresholds, abi.encode(t));
        x.queueChange(GooseExecutor.Change.SetAmounts, abi.encode(a));
        x.queueChange(GooseExecutor.Change.SetOwner, abi.encode(newOwner));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        x.applyChange(GooseExecutor.Change.SetThresholds, abi.encode(t), 0);
        x.applyChange(GooseExecutor.Change.SetAmounts, abi.encode(a), 1);
        x.applyChange(GooseExecutor.Change.SetOwner, abi.encode(newOwner), 2);
        vm.stopPrank();

        (uint64 trigger,,, uint64 floor) = x.thresholds();
        assertEq(trigger, 1.4e18);
        assertEq(floor, 1.05e18);
        (,, uint64 keepBack, uint32 window,) = x.amounts();
        assertEq(keepBack, 0);
        assertEq(window, 3 hours);
        assertEq(x.owner(), newOwner);
    }

    function test_bounds_are_checked_at_queue() public {
        Thresholds[5] memory bad = [
            Thresholds(1.19e18, 1.65e18, 0.15e18, 1.1e18), // trigger below 1.20
            Thresholds(2.01e18, 2.5e18, 0.15e18, 1.1e18), // trigger above 2.00
            Thresholds(1.5e18, 1.54e18, 0.15e18, 1.1e18), // target less than 0.05 above the trigger
            Thresholds(1.5e18, 1.65e18, 0.31e18, 1.1e18), // stress drop above 30%
            Thresholds(1.5e18, 1.65e18, 0.15e18, 1.51e18) // floor above the trigger
        ];
        vm.startPrank(owner);
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(GooseExecutor.OutOfBounds.selector);
            x.queueChange(GooseExecutor.Change.SetThresholds, abi.encode(bad[i]));
        }
        Amounts[5] memory badAmounts = [
            Amounts(0.04e6, 1e6, 1e6, 6 hours, 6), // repay minimum below 5 cents
            Amounts(0.05e6, 101e6, 1e6, 6 hours, 6), // save minimum above $100
            Amounts(0.05e6, 1e6, 6e6, 6 hours, 6), // keep-back above $5
            Amounts(0.05e6, 1e6, 1e6, 13 hours, 6), // window above 12 h
            Amounts(0.05e6, 1e6, 1e6, 6 hours, 0) // no saves a day
        ];
        for (uint256 i; i < badAmounts.length; ++i) {
            vm.expectRevert(GooseExecutor.OutOfBounds.selector);
            x.queueChange(GooseExecutor.Change.SetAmounts, abi.encode(badAmounts[i]));
        }
        vm.expectRevert(GooseExecutor.ZeroValue.selector);
        x.queueChange(GooseExecutor.Change.AddForwarder, abi.encode(address(0)));
        vm.expectRevert(GooseExecutor.ZeroValue.selector);
        x.queueChange(GooseExecutor.Change.AllowCodehash, abi.encode(bytes32(0)));
        vm.stopPrank();
    }

    /// A holiday queued for a day that has passed by the time the delay ends is refused when it would land.
    function test_holidays_wait_the_delay_and_stay_within_800_days() public {
        uint32 today = uint32(NyCalendar.day(vm.getBlockTimestamp()));
        vm.startPrank(owner);
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetHoliday, abi.encode(today + 801, true));
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetHoliday, abi.encode(today - 1, true));

        x.queueChange(GooseExecutor.Change.SetHoliday, abi.encode(today + 3, true));
        x.queueChange(GooseExecutor.Change.SetHoliday, abi.encode(today + 30, true));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.applyChange(GooseExecutor.Change.SetHoliday, abi.encode(today + 3, true), 0);
        x.applyChange(GooseExecutor.Change.SetHoliday, abi.encode(today + 30, true), 1);
        vm.stopPrank();
        assertTrue(x.holiday(today + 30));
    }

    function test_sell_limits_change_after_the_delay_within_bounds() public {
        SellLimits memory l = deploy.sellLimits();
        l.headsUpDelay = 1 hours;
        l.actFloorBps = 250;
        SellLimits memory bad = deploy.sellLimits();
        bad.actFloorBps = 501; // past Aave's 5.5% liquidation bonus, with room
        vm.startPrank(owner);
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetSellLimits, abi.encode(bad));
        x.queueChange(GooseExecutor.Change.SetSellLimits, abi.encode(l));
        vm.expectRevert(abi.encodeWithSelector(GooseExecutor.TooEarly.selector, vm.getBlockTimestamp() + 7 days));
        x.applyChange(GooseExecutor.Change.SetSellLimits, abi.encode(l), 0);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        x.applyChange(GooseExecutor.Change.SetSellLimits, abi.encode(l), 0);
        vm.stopPrank();
        (,,, uint32 delay,, uint16 actFloor,,) = x.sellLimits();
        assertEq(delay, 1 hours);
        assertEq(actFloor, 250);
    }

    function test_only_the_account_itself_sets_keep_my_mix() public {
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.KeepMixSet(account, true);
        vm.prank(account);
        x.setKeepMix(true);
        (,,,,,,, bool keepMix) = x.accounts(account);
        assertTrue(keepMix);
        vm.prank(stranger);
        x.setKeepMix(false);
        (,,,,,,, keepMix) = x.accounts(account);
        assertTrue(keepMix, "a stranger only sets its own");
    }

    function test_a_queued_change_can_be_cancelled() public {
        vm.startPrank(owner);
        (bytes32 id,) = x.queueChange(GooseExecutor.Change.AddForwarder, abi.encode(stranger));
        x.cancelChange(id);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.expectRevert(GooseExecutor.NotQueued.selector);
        x.applyChange(GooseExecutor.Change.AddForwarder, abi.encode(stranger), 0);
        vm.stopPrank();
    }

    function test_a_codehash_is_allowed_after_the_delay_and_disallowed_at_once() public {
        bytes32 h = keccak256("next JAW account");
        vm.startPrank(owner);
        x.queueChange(GooseExecutor.Change.AllowCodehash, abi.encode(h));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        x.applyChange(GooseExecutor.Change.AllowCodehash, abi.encode(h), 0);
        assertTrue(x.allowedCodehash(h));
        x.disallowCodehash(h);
        vm.stopPrank();
        assertFalse(x.allowedCodehash(h));
    }

    // ------------------------------------------------------------------ log trigger filter

    function test_checkLog_turns_an_exact_grant_into_a_registration() public view {
        for (uint8 j; j < 2; ++j) {
            GooseExecutor.Job job = GooseExecutor.Job(j);
            PM.Permission memory p = _grant(job, 5e6);
            (bool needed, bytes memory performData) = x.checkLog(_log(p), "");
            assertTrue(needed);
            (GooseExecutor.Mode mode, bytes memory data) = abi.decode(performData, (GooseExecutor.Mode, bytes));
            assertEq(uint8(mode), uint8(GooseExecutor.Mode.Register));
            assertEq(data, abi.encode(job, account, p.start, p.end, p.salt, uint160(5e6), uint256(0)));
            assertLe(performData.length, 2000);
        }
    }

    /// Protect · sell's grant: NVIDIA and Tesla for sale with their own daily limits, the other five never.
    function test_checkLog_turns_an_exact_sell_grant_into_a_registration() public {
        _mockPrices(200e8);
        uint256 t = _terms(0.02e8, 0.03e8); // $4 and $6 a day at $200: within two $5 caps
        PM.Permission memory p = _sellGrant(5e6, t);
        assertEq(p.calls.length, 6, "withdraw, two approves, swap, approve, repay");
        assertEq(p.spends.length, 4, "USDC, aUSDC and the two stocks");
        (bool needed, bytes memory performData) = x.checkLog(_log(p), "");
        assertTrue(needed);
        (, bytes memory data) = abi.decode(performData, (GooseExecutor.Mode, bytes));
        assertEq(data, abi.encode(GooseExecutor.Job.ProtectSell, account, p.start, p.end, p.salt, uint160(5e6), t));
        assertLe(performData.length, 2000);
    }

    function test_checkLog_ignores_a_sell_grant_it_would_not_register() public {
        _mockPrices(200e8);
        _ignored(_log(_sellGrant(5e6, _terms(0.06e8, 0.03e8))), "a stock limit worth $12, over two $5 caps");

        PM.Permission memory p = _sellGrant(5e6, _terms(0.02e8, 0.03e8));
        (p.spends[2], p.spends[3]) = (p.spends[3], p.spends[2]);
        _ignored(_log(p), "stock limits out of reserve order");

        p = _sellGrant(5e6, _terms(0.02e8, 0.03e8));
        p.spends[2].allowance += 1;
        _ignored(_log(p), "a stock limit that isn't whole units of 1e-4 share");

        p = _sellGrant(5e6, _terms(0.02e8, 0.03e8));
        p.calls[1].target = x.stocks()[0];
        _ignored(_log(p), "an approve for a stock with no limit");
    }

    function test_checkLog_ignores_everything_else() public view {
        PM.Permission memory p = _grant(GooseExecutor.Job.Protect, 5e6);

        Log memory l = _log(p);
        l.source = stranger;
        _ignored(l, "another emitter");

        l = _log(p);
        l.topics[0] = keccak256("PermissionRevoked(bytes32)");
        _ignored(l, "another event");

        p.spender = stranger;
        _ignored(_log(p), "another spender");

        p = _grant(GooseExecutor.Job.Protect, 5e6);
        p.calls[2].checker = stranger;
        _ignored(_log(p), "a checker");

        p = _grant(GooseExecutor.Job.Protect, 5e6);
        p.spends[1].allowance = 4e6;
        _ignored(_log(p), "Protect's two limits differ");

        p = _grant(GooseExecutor.Job.Save, 5e6);
        p.calls[1].target = stranger;
        _ignored(_log(p), "another target");

        p = _grant(GooseExecutor.Job.Save, 5e6);
        p.spends[0].unit = PM.PeriodUnit.Week;
        _ignored(_log(p), "another period");

        _ignored(_log(_grant(GooseExecutor.Job.Save, 5e6 + 1)), "a limit above CAP_MAX");

        p = _grant(GooseExecutor.Job.Save, 5e6);
        p.start = uint48(vm.getBlockTimestamp() - 30 days);
        p.end = uint48(vm.getBlockTimestamp() - 1);
        _ignored(_log(p), "an expired grant");
    }

    // ------------------------------------------------------------------ helpers

    function _config() internal returns (GooseExecutor.Config memory c) {
        c = deploy.config(8453, owner);
        c.manager = PM(manager);
        c.aaveV3Pool = IAaveV3Pool(makeAddr("pool"));
        c.spoke = ISpoke(makeAddr("spoke"));
        c.usdc = IERC20(makeAddr("usdc"));
        c.aUsdc = IERC20(makeAddr("ausdc"));
    }

    /// Daily limits in raw shares for NVIDIA (reserve 5) and Tesla (6), packed as the executor's terms.
    function _terms(uint256 nvda, uint256 tsla) internal pure returns (uint256) {
        return nvda / 1e4 << 160 | tsla / 1e4 << 192;
    }

    function _sellGrant(uint160 cap, uint256 t) internal view returns (PM.Permission memory) {
        uint48 start = uint48(vm.getBlockTimestamp());
        return x.permissionFor(
            GooseExecutor.Job.ProtectSell,
            account,
            GooseExecutor.Grant(start, start + 365 days, cap),
            uint256(keccak256("salt")),
            t
        );
    }

    function _mockPrices(uint256 price) internal {
        vm.mockCall(
            address(x.ORACLE()), abi.encodeWithSelector(IAaveOracle.getReservePrice.selector), abi.encode(price)
        );
    }

    function _bootstrap() internal {
        address[] memory f = new address[](1);
        f[0] = forwarder;
        vm.prank(owner);
        x.bootstrap(f);
    }

    function _grant(GooseExecutor.Job job, uint160 cap) internal view returns (PM.Permission memory) {
        uint48 start = uint48(vm.getBlockTimestamp());
        return
            x.permissionFor(
                job, account, GooseExecutor.Grant(start, start + 365 days, cap), uint256(keccak256("salt")), 0
            );
    }

    function _log(PM.Permission memory p) internal view returns (Log memory l) {
        l.source = manager;
        l.topics = new bytes32[](2);
        l.topics[0] = PM.PermissionApproved.selector;
        l.topics[1] = keccak256(abi.encode(p));
        l.data = abi.encode(p);
    }

    function _ignored(Log memory l, string memory what) internal view {
        (bool needed, bytes memory performData) = x.checkLog(l, "");
        assertFalse(needed, what);
        assertEq(performData.length, 0, what);
    }
}
