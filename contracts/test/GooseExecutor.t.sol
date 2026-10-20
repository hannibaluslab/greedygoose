// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../src/IJustaPermissionManager.sol";
import {IAaveOracle, IAaveV3Pool, IERC20, ISpoke} from "../src/IProtocols.sol";
import {Amounts, Thresholds, TopUps} from "../src/CashRules.sol";
import {EntryLimits} from "../src/EntryRules.sol";
import {RebalanceLimits} from "../src/RebalanceRules.sol";
import {SellLimits} from "../src/SellRules.sol";
import {NyCalendar} from "../src/NyCalendar.sol";
import {RebalanceJob} from "../src/jobs/RebalanceJob.sol";
import {DeployExecutor} from "../script/DeployExecutor.s.sol";
import {ExecutorHarness} from "./ExecutorHarness.sol";

/// No fork: construction, admin (product decision 2: pause at once, everything else behind a 7-day public delay),
/// who may run, and which permissions register. Runs and registration against the real manager are in
/// GooseExecutorFork.t.sol.
contract GooseExecutorTest is Test {
    /// `topUps`' storage slot (forge inspect GooseExecutor storageLayout).
    uint256 constant TOP_UPS_SLOT = 6;
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
        c.sellLimits.floorBps = 501; // past Aave's 5.5% liquidation bonus, with room
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        new GooseExecutor(c);

        c = _config();
        c.rebalanceLimits.minTrade = 0; // every dust drift a trade
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        new GooseExecutor(c);

        c = _config();
        c.entryLimits.floorBps = 51; // under 99.5% of face value
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
        (uint16 band, uint16 bandMax, uint16 gap, uint16 floor_, uint64 minTrade, uint64 maxSlice) = x.rebalanceLimits();
        assertEq(abi.encode(band, bandMax, gap, floor_, minTrade, maxSlice), abi.encode(deploy.rebalanceLimits()));
        (uint16 entryFloor, uint64 minEntry, uint64 maxSwap) = x.entryLimits();
        assertEq(abi.encode(entryFloor, minEntry, maxSwap), abi.encode(deploy.entryLimits()));
        (uint16 sellFloor, uint64 poolCap, uint64 sellSlice) = x.sellLimits();
        assertEq(abi.encode(sellFloor, poolCap, sellSlice), abi.encode(deploy.sellLimits()));
        assertEq(x.memberCount(), 0);
        assertEq(x.protectMemberCount(), 0);
        assertEq(x.owner(), owner);
        assertFalse(x.isForwarder(forwarder));
        assertFalse(x.bootstrapped());
    }

    /// Protect's line (Adrian, 2026-10-19): with the deploy defaults Protect acts only below 1.03, savings first, then
    /// selling at 3% under Aave's price at most, back to 1.12; the weekend card warns about Aave's line.
    function test_with_the_defaults_protect_acts_below_1_03_and_back_to_1_12() public view {
        Thresholds memory t = deploy.thresholds();
        assertEq(t.triggerHf, 1.03e18, "acts only below Protect's line");
        assertEq(t.targetHf, 1.12e18, "back to 1.12, the credit cap's line");
        assertEq(t.stressFloorHf, 1e18, "the weekend card tests Aave's line");
        (uint16 floor_,,) = x.sellLimits();
        assertEq(floor_, 300, "every sale is urgent: 3% under Aave's price at most");
    }

    // ------------------------------------------------------------------ who may run

    function test_only_forwarders_may_perform_and_only_the_executor_may_run_an_account() public {
        bytes memory run = abi.encode(new address[](0));
        vm.prank(stranger);
        vm.expectRevert(GooseExecutor.NotForwarder.selector);
        x.performUpkeep(run);

        vm.prank(owner);
        vm.expectRevert(GooseExecutor.NotForwarder.selector);
        x.performUpkeep(run);

        vm.prank(stranger);
        vm.expectRevert(GooseExecutor.OnlySelf.selector);
        x.runAccount(account, false);

        _bootstrap();
        vm.prank(forwarder);
        x.performUpkeep(run);
        vm.prank(forwarder);
        vm.expectRevert(GooseExecutor.TooMuchWork.selector);
        x.performUpkeep(abi.encode(new address[](9)));
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
        x.performUpkeep(abi.encode(new address[](0)));
        (bool needed,) = x.checkUpkeep(abi.encode(uint256(0), uint256(1)));
        assertFalse(needed);
        (needed,) = x.checkProtect(0, 1);
        assertFalse(needed);

        vm.prank(owner);
        x.unpause();
        vm.prank(forwarder);
        x.performUpkeep(abi.encode(new address[](0)));
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
        x.performUpkeep(abi.encode(new address[](0)));
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
        Thresholds memory t = Thresholds(1.03e18, 1.1e18, 0.2e18, 1.02e18);
        Amounts memory a = Amounts(1e6, 2e6, 0.6e6, 3 hours, 4);
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

        (uint64 trigger, uint64 target,, uint64 floor) = x.thresholds();
        assertEq(trigger, 1.03e18);
        assertEq(target, 1.1e18);
        assertEq(floor, 1.02e18);
        (,, uint64 keepBack, uint32 window,) = x.amounts();
        assertEq(keepBack, 0.6e6);
        assertEq(window, 3 hours);
        assertEq(x.owner(), newOwner);
    }

    function test_bounds_are_checked_at_queue() public {
        Thresholds[8] memory bad = [
            Thresholds(1.02e18, 1.12e18, 0.15e18, 1e18), // trigger under Protect's line: closer to Aave's
            Thresholds(1.1e18, 1.2e18, 0.15e18, 1e18), // the old Act-line trigger
            Thresholds(1.5e18, 1.65e18, 0.15e18, 1e18), // the old Safe-line trigger
            Thresholds(1.03e18, 1.07e18, 0.15e18, 1e18), // target less than 0.05 above the trigger
            Thresholds(1.03e18, 1.41e18, 0.15e18, 1e18), // target past Watch toward Safe
            Thresholds(1.03e18, 1.12e18, 0.31e18, 1e18), // stress drop above 30%
            Thresholds(1.03e18, 1.12e18, 0.15e18, 1.04e18), // floor above the trigger
            Thresholds(1.03e18, 1.12e18, 0.15e18, 0.99e18) // floor under Aave's line
        ];
        vm.startPrank(owner);
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(GooseExecutor.OutOfBounds.selector);
            x.queueChange(GooseExecutor.Change.SetThresholds, abi.encode(bad[i]));
        }
        Amounts[6] memory badAmounts = [
            Amounts(0.04e6, 1e6, 1e6, 6 hours, 6), // repay minimum below 5 cents
            Amounts(0.05e6, 101e6, 1e6, 6 hours, 6), // save minimum above $100
            Amounts(0.05e6, 1e6, 0.59e6, 6 hours, 6), // keep-back under the fuel tank and Fill up's margin
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

    /// Protect's line (Adrian, 2026-10-19) is pinned for the repay and the sale alike, which both read it: no deploy and
    /// no change through the delay can move it, so a sale can never start above the cash line.
    function test_protects_line_is_pinned_and_no_change_moves_it() public {
        GooseExecutor.Config memory c = _config();
        c.thresholds.triggerHf = 1.05e18;
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        new GooseExecutor(c);

        vm.startPrank(owner);
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetThresholds, abi.encode(Thresholds(1.05e18, 1.12e18, 0.15e18, 1e18)));
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetThresholds, abi.encode(Thresholds(1.01e18, 1.12e18, 0.15e18, 1e18)));
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
        l.floorBps = 250;
        SellLimits memory bad = deploy.sellLimits();
        bad.floorBps = 501; // past Aave's 5.5% liquidation bonus, with room
        vm.startPrank(owner);
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetSellLimits, abi.encode(bad));
        x.queueChange(GooseExecutor.Change.SetSellLimits, abi.encode(l));
        vm.expectRevert(abi.encodeWithSelector(GooseExecutor.TooEarly.selector, vm.getBlockTimestamp() + 7 days));
        x.applyChange(GooseExecutor.Change.SetSellLimits, abi.encode(l), 0);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        x.applyChange(GooseExecutor.Change.SetSellLimits, abi.encode(l), 0);
        vm.stopPrank();
        (uint16 floor_,,) = x.sellLimits();
        assertEq(floor_, 250);
    }

    function test_rebalance_and_entry_limits_change_after_the_delay_within_bounds() public {
        RebalanceLimits memory r = deploy.rebalanceLimits();
        r.minTrade = 50e6;
        RebalanceLimits memory badR = deploy.rebalanceLimits();
        badR.poolGapBps = 201;
        EntryLimits memory e = EntryLimits(30, 5e6, 25_000e6);
        EntryLimits memory badE = EntryLimits(50, 1e6, 100_001e6);
        vm.startPrank(owner);
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetRebalanceLimits, abi.encode(badR));
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetEntryLimits, abi.encode(badE));
        x.queueChange(GooseExecutor.Change.SetRebalanceLimits, abi.encode(r));
        x.queueChange(GooseExecutor.Change.SetEntryLimits, abi.encode(e));
        vm.expectRevert(abi.encodeWithSelector(GooseExecutor.TooEarly.selector, vm.getBlockTimestamp() + 7 days));
        x.applyChange(GooseExecutor.Change.SetEntryLimits, abi.encode(e), 1);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        x.applyChange(GooseExecutor.Change.SetRebalanceLimits, abi.encode(r), 0);
        x.applyChange(GooseExecutor.Change.SetEntryLimits, abi.encode(e), 1);
        vm.stopPrank();
        (,,,, uint64 minTrade,) = x.rebalanceLimits();
        assertEq(minTrade, 50e6);
        (uint16 floor_,, uint64 maxSwap) = x.entryLimits();
        assertEq(floor_, 30);
        assertEq(maxSwap, 25_000e6);
    }

    /// Bounds may only tighten (decision, 2026-10-14): the Rebalancer's swap floor and pool gap can only get stricter
    /// through the delay, checked when a change is queued and again when it lands; Entry's floor never goes under
    /// 99.5% of face value.
    function test_the_rebalancers_floor_and_pool_gap_only_get_stricter() public {
        RebalanceLimits memory looserFloor = deploy.rebalanceLimits();
        looserFloor.floorBps = 51;
        RebalanceLimits memory looserGap = deploy.rebalanceLimits();
        looserGap.poolGapBps = 51;
        RebalanceLimits memory stricter = deploy.rebalanceLimits();
        (stricter.floorBps, stricter.poolGapBps) = (40, 30);
        RebalanceLimits memory between = deploy.rebalanceLimits();
        (between.floorBps, between.poolGapBps) = (45, 45);
        vm.startPrank(owner);
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetRebalanceLimits, abi.encode(looserFloor));
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetRebalanceLimits, abi.encode(looserGap));
        x.queueChange(GooseExecutor.Change.SetRebalanceLimits, abi.encode(stricter));
        x.queueChange(GooseExecutor.Change.SetRebalanceLimits, abi.encode(between)); // stricter than today's too
        vm.warp(vm.getBlockTimestamp() + 7 days);
        x.applyChange(GooseExecutor.Change.SetRebalanceLimits, abi.encode(stricter), 0);
        (,, uint16 gap, uint16 floor_,,) = x.rebalanceLimits();
        assertEq(abi.encode(floor_, gap), abi.encode(uint16(40), uint16(30)));
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.applyChange(GooseExecutor.Change.SetRebalanceLimits, abi.encode(between), 1); // looser than it is now
        bytes memory backToTheDefaults = abi.encode(deploy.rebalanceLimits());
        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetRebalanceLimits, backToTheDefaults);

        vm.expectRevert(GooseExecutor.OutOfBounds.selector);
        x.queueChange(GooseExecutor.Change.SetEntryLimits, abi.encode(EntryLimits(51, 1e6, 10_000e6)));
        x.queueChange(GooseExecutor.Change.SetEntryLimits, abi.encode(EntryLimits(50, 1e6, 10_000e6)));
        vm.stopPrank();
    }

    /// One Face ID: the account writes its own mix to the registry. It must add up to 100%, or be all 0 to clear it.
    function test_only_the_account_itself_sets_its_mix() public {
        uint16[7] memory mix = [uint16(2_500), 0, 0, 0, 0, 5_000, 2_500];
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.MixSet(account, mix);
        vm.prank(account);
        x.setMix(mix);
        assertEq(x.mixes(account), uint256(2_500) | uint256(5_000) << 80 | uint256(2_500) << 96);
        assertEq(x.mixes(stranger), 0, "a stranger only sets its own");

        mix[0] = 2_499;
        vm.expectRevert(GooseExecutor.BadMix.selector);
        vm.prank(account);
        x.setMix(mix);
        vm.prank(account);
        x.setMix([uint16(0), 0, 0, 0, 0, 0, 0]);
        assertEq(x.mixes(account), 0, "cleared");
    }

    /// Top-ups go into my mix: only the account itself switches them and sets Keep. A new Keep keeps the counts;
    /// switching on or off starts them again from nothing, and the wallet's cash past Save's $1 keep-back when they go
    /// on is marked as not a top-up.
    function test_only_the_account_itself_sets_top_ups_and_keep() public {
        _mockCash(account, 1e6);
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.TopUpsSet(account, true, 500e6);
        vm.prank(account);
        x.setTopUps(true, 500e6);
        assertEq(abi.encode(_topUps(account)), abi.encode(TopUps(true, 0, 500e6, 0, 0, 0, 0)));
        assertEq(abi.encode(_topUps(stranger)), abi.encode(TopUps(false, 0, 0, 0, 0, 0, 0)), "a stranger sets its own");

        // Save counted $300 ready and $200 today, with $3 of the agents' change.
        _storeCounts(account, TopUps(true, 20_400, 500e6, 300e6, 200e6, 1_000e6, 3e6));
        vm.prank(account);
        x.setTopUps(true, 0);
        assertEq(
            abi.encode(_topUps(account)), abi.encode(TopUps(true, 20_400, 0, 300e6, 200e6, 1_000e6, 3e6)), "Keep only"
        );
        vm.prank(account);
        x.setTopUps(false, 0);
        assertEq(abi.encode(_topUps(account)), abi.encode(TopUps(false, 0, 0, 0, 0, 0, 0)), "off: nothing waits");
        _storeCounts(account, TopUps(false, 20_400, 0, 300e6, 200e6, 1_000e6, 3e6));
        _mockCash(account, 501e6);
        vm.prank(account);
        x.setTopUps(true, 700e6);
        assertEq(
            abi.encode(_topUps(account)),
            abi.encode(TopUps(true, 0, 700e6, 0, 0, 0, 500e6)),
            "on: the $500 in the wallet stays as it is, from the next top-up"
        );
    }

    function _mockCash(address a, uint256 cash) internal {
        vm.mockCall(address(x.USDC()), abi.encodeCall(IERC20.balanceOf, (a)), abi.encode(cash));
    }

    function test_only_the_account_itself_sets_keep_my_mix() public {
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.KeepMixSet(account, true);
        vm.prank(account);
        x.setKeepMix(true);
        (,,,,,,, bool keepMix,,) = x.accounts(account);
        assertTrue(keepMix);
        vm.prank(stranger);
        x.setKeepMix(false);
        (,,,,,,, keepMix,,) = x.accounts(account);
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

    // ------------------------------------------------------------------ which permissions register

    function test_registrationOf_names_the_job_of_an_exact_grant() public view {
        for (uint8 j; j < 2; ++j) {
            GooseExecutor.Job job = GooseExecutor.Job(j);
            PM.Permission memory p = _grant(job, 5e6);
            _registers(p, job, 5e6, 0);
        }
    }

    /// Anyone may hand registerApproved a permission: one that isn't an exact grant is refused before anything else,
    /// and one that is goes on to `_register`'s full checks (here an EOA, which isn't a JAW account).
    function test_registerApproved_refuses_what_registrationOf_refuses_and_checks_the_rest() public {
        PM.Permission memory p = _grant(GooseExecutor.Job.Protect, 5e6);
        p.spender = stranger;
        vm.prank(stranger);
        vm.expectRevert(GooseExecutor.NotApproved.selector);
        x.registerApproved(abi.encode(p));

        p = _grant(GooseExecutor.Job.Protect, 5e6);
        vm.prank(stranger);
        vm.expectRevert(GooseExecutor.AccountNotAllowed.selector);
        x.registerApproved(abi.encode(p));
    }

    /// Both entries take the PermissionApproved data as logged, one bytes argument; anything that isn't a permission's
    /// encoding reverts before any check.
    function test_registration_takes_the_events_data_and_refuses_garbage() public {
        PM.Permission memory p = _grant(GooseExecutor.Job.Save, 5e6);
        (bool ok,,,) = x.registrationOf(abi.encode(p));
        assertTrue(ok);
        vm.expectRevert();
        x.registrationOf(hex"00");
        vm.expectRevert();
        x.registerApproved(abi.encode(uint256(1)));
    }

    /// Protect · sell's grant: NVIDIA and Tesla for sale with their own daily limits, the other five never.
    function test_registrationOf_names_an_exact_sell_grant() public {
        _mockPrices(200e8);
        uint256 t = _terms(0.02e8, 0.03e8); // $4 and $6 a day at $200: within two $5 caps
        PM.Permission memory p = _sellGrant(5e6, t);
        assertEq(p.calls.length, 6, "withdraw, two approves, swap, approve, repay");
        assertEq(p.spends.length, 4, "USDC, aUSDC and the two stocks");
        _registers(p, GooseExecutor.Job.ProtectSell, 5e6, t);
    }

    /// The Rebalancer's grant: NVIDIA and Tesla it may sell, each with a weekly limit, and USDC for the buys.
    function test_registrationOf_names_an_exact_rebalance_grant() public {
        _mockPrices(200e8);
        uint256 t = _terms(0.02e8, 0.03e8);
        PM.Permission memory p = _grantWith(GooseExecutor.Job.Rebalance, 5e6, t);
        assertEq(p.calls.length, 4, "two approves, USDC's approve, swap");
        assertEq(p.spends.length, 3, "USDC and the two stocks");
        assertEq(uint8(p.spends[0].unit), uint8(PM.PeriodUnit.Week));
        _registers(p, GooseExecutor.Job.Rebalance, 5e6, t);

        _ignored(_grantWith(GooseExecutor.Job.Rebalance, 5e6, _terms(0.06e8, 0)), "a stock limit over two caps");
        p.spends[0].unit = PM.PeriodUnit.Day;
        _ignored(p, "a daily limit");
    }

    /// The Rebalancer's grant with top-ups: Aave V3's savings withdraw first and an aUSDC limit at the same cap as USDC's,
    /// a week each, then the stocks' limits. Its terms carry TOP_UPS; without the withdraw and aUSDC it's the plain
    /// shape, and a Protect · sell grant, whose spends start the same way, never reads as one, nor the reverse.
    function test_registrationOf_names_an_exact_rebalance_grant_with_top_ups() public {
        _mockPrices(200e8);
        uint256 t = _terms(0.02e8, 0.03e8) | RebalanceJob.TOP_UPS;
        PM.Permission memory p = _grantWith(GooseExecutor.Job.Rebalance, 5e6, t);
        assertEq(p.calls.length, 5, "withdraw, two approves, USDC's approve, swap");
        assertEq(
            abi.encode(p.calls[0]),
            abi.encode(PM.CallPermission(address(x.AAVE_V3_POOL()), IAaveV3Pool.withdraw.selector, address(0)))
        );
        assertEq(p.spends.length, 4, "USDC, aUSDC and the two stocks");
        assertEq(abi.encode(p.spends[1]), abi.encode(PM.SpendLimit(address(x.AUSDC()), 5e6, PM.PeriodUnit.Week, 1)));
        assertEq(p.spends[2].token, x.stocks()[5], "the stocks' limits start at spends[2]");
        _registers(p, GooseExecutor.Job.Rebalance, 5e6, t);
        _registers(
            _grantWith(GooseExecutor.Job.Rebalance, 5e6, _terms(0.02e8, 0.03e8)),
            GooseExecutor.Job.Rebalance,
            5e6,
            _terms(0.02e8, 0.03e8)
        );

        PM.Permission memory q = _grantWith(GooseExecutor.Job.Rebalance, 5e6, t);
        q.spends[1].allowance = 4e6;
        _ignored(q, "an aUSDC limit unlike USDC's");
        q = _grantWith(GooseExecutor.Job.Rebalance, 5e6, t);
        q.calls[0].target = stranger;
        _ignored(q, "a withdraw on another target");
        q = _grantWith(GooseExecutor.Job.Rebalance, 5e6, t);
        q.calls[0].selector = IAaveV3Pool.supply.selector;
        _ignored(q, "another call on the pool");
        q = _grantWith(GooseExecutor.Job.Rebalance, 5e6, t);
        (q.spends[1], q.spends[2], q.spends[3]) = (q.spends[2], q.spends[3], q.spends[1]);
        _ignored(q, "aUSDC's limit out of place");
        q = _grantWith(GooseExecutor.Job.Rebalance, 5e6, t);
        PM.SpendLimit[] memory noAUsdc = new PM.SpendLimit[](3);
        (noAUsdc[0], noAUsdc[1], noAUsdc[2]) = (q.spends[0], q.spends[2], q.spends[3]);
        q.spends = noAUsdc;
        _ignored(q, "the withdraw without aUSDC's limit");
        q = _grantWith(GooseExecutor.Job.Rebalance, 5e6, _terms(0.02e8, 0.03e8));
        PM.SpendLimit[] memory withAUsdc = new PM.SpendLimit[](4);
        (withAUsdc[0], withAUsdc[1], withAUsdc[2], withAUsdc[3]) =
        (q.spends[0], PM.SpendLimit(address(x.AUSDC()), 5e6, PM.PeriodUnit.Week, 1), q.spends[1], q.spends[2]);
        q.spends = withAUsdc;
        _ignored(q, "aUSDC's limit without the withdraw");
        q = _grantWith(GooseExecutor.Job.Rebalance, 5e6, t);
        for (uint256 i; i < q.spends.length; ++i) {
            q.spends[i].unit = PM.PeriodUnit.Day;
        }
        _ignored(q, "daily limits on the Rebalancer's calls");

        // Protect · sell's grant has the same spends' start (USDC, aUSDC, stocks): it still registers as itself.
        PM.Permission memory sell = _sellGrant(5e6, _terms(0.02e8, 0.03e8));
        _registers(sell, GooseExecutor.Job.ProtectSell, 5e6, _terms(0.02e8, 0.03e8));
        for (uint256 i; i < sell.spends.length; ++i) {
            sell.spends[i].unit = PM.PeriodUnit.Week;
        }
        _ignored(sell, "the sell calls with weekly limits");
    }

    /// Entry's grant: four coins, each with a daily limit at the same face value, and the three venues' swaps.
    function test_registrationOf_names_an_exact_entry_grant() public {
        PM.Permission memory p = _grant(GooseExecutor.Job.Entry, 5e6);
        assertEq(p.calls.length, 7, "four approves and three swaps");
        assertEq(p.spends[1].allowance, 5e18, "USDe's limit: $5 at 18 decimals");
        _registers(p, GooseExecutor.Job.Entry, 5e6, 0);

        p.spends[1].allowance = 5e6;
        _ignored(p, "a limit not adjusted for decimals");
        p = _grant(GooseExecutor.Job.Entry, 5e6);
        p.calls[5].target = stranger;
        _ignored(p, "another venue");
    }

    function test_registrationOf_refuses_a_sell_grant_it_would_not_register() public {
        _mockPrices(200e8);
        _ignored(_sellGrant(5e6, _terms(0.06e8, 0.03e8)), "a stock limit worth $12, over two $5 caps");

        PM.Permission memory p = _sellGrant(5e6, _terms(0.02e8, 0.03e8));
        (p.spends[2], p.spends[3]) = (p.spends[3], p.spends[2]);
        _ignored(p, "stock limits out of reserve order");

        p = _sellGrant(5e6, _terms(0.02e8, 0.03e8));
        p.spends[2].allowance += 1;
        _ignored(p, "a stock limit that isn't whole units of 1e-4 share");

        p = _sellGrant(5e6, _terms(0.02e8, 0.03e8));
        p.calls[1].target = x.stocks()[0];
        _ignored(p, "an approve for a stock with no limit");
    }

    function test_registrationOf_refuses_everything_else() public view {
        PM.Permission memory p = _grant(GooseExecutor.Job.Protect, 5e6);
        p.spender = stranger;
        _ignored(p, "another spender");

        p = _grant(GooseExecutor.Job.Protect, 5e6);
        p.calls[2].checker = stranger;
        _ignored(p, "a checker");

        p = _grant(GooseExecutor.Job.Protect, 5e6);
        p.spends[1].allowance = 4e6;
        _ignored(p, "Protect's two limits differ");

        p = _grant(GooseExecutor.Job.Save, 5e6);
        p.calls[1].target = stranger;
        _ignored(p, "another target");

        p = _grant(GooseExecutor.Job.Save, 5e6);
        p.spends[0].unit = PM.PeriodUnit.Week;
        _ignored(p, "another period");

        _ignored(_grant(GooseExecutor.Job.Save, 5e6 + 1), "a limit above CAP_MAX");

        p = _grant(GooseExecutor.Job.Save, 5e6);
        p.start = uint48(vm.getBlockTimestamp() - 30 days);
        p.end = uint48(vm.getBlockTimestamp() - 1);
        _ignored(p, "an expired grant");
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
        return _grantWith(GooseExecutor.Job.ProtectSell, cap, t);
    }

    function _grantWith(GooseExecutor.Job job, uint160 cap, uint256 t) internal view returns (PM.Permission memory) {
        uint48 start = uint48(vm.getBlockTimestamp());
        return
            x.permissionFor(
                job, account, GooseExecutor.Grant(start, start + 365 days, cap), uint256(keccak256("salt")), t
            );
    }

    function _topUps(address a) internal view returns (TopUps memory t) {
        (t.on, t.day, t.keep, t.ready, t.today, t.mark, t.own) = x.topUps(a);
    }

    /// Writes an account's top-ups as Save would leave them: `topUps` sits at slot 6 of its storage.
    function _storeCounts(address a, TopUps memory t) internal {
        bytes32 slot = keccak256(abi.encode(a, uint256(TOP_UPS_SLOT)));
        uint256 first = (t.on ? 1 : 0) | uint256(t.day) << 8 | uint256(t.keep) << 40 | uint256(t.ready) << 88
            | uint256(t.today) << 144 | uint256(t.mark) << 200;
        vm.store(address(x), slot, bytes32(first));
        vm.store(address(x), bytes32(uint256(slot) + 1), bytes32(t.own));
        assertEq(abi.encode(_topUps(a)), abi.encode(t), "the slot layout");
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

    function _registers(PM.Permission memory p, GooseExecutor.Job job, uint160 cap, uint256 t) internal view {
        (bool ok, GooseExecutor.Job got, uint160 gotCap, uint256 gotTerms) = x.registrationOf(abi.encode(p));
        assertTrue(ok);
        assertEq(uint8(got), uint8(job));
        assertEq(gotCap, cap);
        assertEq(gotTerms, t);
    }

    function _ignored(PM.Permission memory p, string memory what) internal view {
        (bool ok,,,) = x.registrationOf(abi.encode(p));
        assertFalse(ok, what);
    }
}
