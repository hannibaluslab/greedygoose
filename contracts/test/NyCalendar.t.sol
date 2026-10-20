// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IJustaPermissionManager} from "../src/IJustaPermissionManager.sol";
import {IAaveOracle, IAaveV3Pool, IERC20, ISpoke} from "../src/IProtocols.sol";
import {NyCalendar} from "../src/NyCalendar.sol";
import {DeployExecutor} from "../script/DeployExecutor.s.sol";
import {ExecutorHarness} from "./ExecutorHarness.sol";
import {Vectors} from "./Vectors.sol";

/// The executor's New York calendar (docs/archive/goose-executor-plan.md §7): time-zone switches, the Friday window in
/// summer and winter, holidays, and agreement with Leo's inWeekendWindow and the app's marketState on 10,000
/// timestamps.
contract NyCalendarTest is Test {
    ExecutorHarness x;
    /// The calendar for the library's own functions (`x` keeps its own).
    mapping(uint32 => bool) holidays;

    // UTC instants, checked against America/New_York.
    uint256 constant DST_START_2026 = 1_772_953_200; // Sun 2026-03-08 07:00 UTC = 03:00 EDT
    uint256 constant DST_END_2026 = 1_793_512_800; // Sun 2026-11-01 06:00 UTC = 01:00 EST
    uint256 constant DST_START_2027 = 1_805_007_600; // Sun 2027-03-14 07:00 UTC
    uint256 constant FRI_2026_10_16 = 1_792_108_800; // Fri 2026-10-16 00:00 UTC (summer time)
    uint256 constant FRI_2026_12_04 = 1_796_342_400; // Fri 2026-12-04 00:00 UTC (winter time)

    function setUp() public {
        DeployExecutor d = new DeployExecutor();
        bytes32[] memory none;
        x = new ExecutorHarness(
            GooseExecutor.Config({
                manager: IJustaPermissionManager(makeAddr("manager")),
                aaveV3Pool: IAaveV3Pool(makeAddr("pool")),
                spoke: ISpoke(makeAddr("spoke")),
                usdc: IERC20(makeAddr("usdc")),
                aUsdc: IERC20(makeAddr("ausdc")),
                usdcReserveId: 7,
                oracle: IAaveOracle(makeAddr("oracle")),
                router: makeAddr("router"),
                stocks: d.baseStocks(),
                capMax: 5e6,
                pageSize: 48,
                owner: address(this),
                codehashes: none,
                thresholds: d.thresholds(),
                amounts: d.amounts(),
                sellLimits: d.sellLimits(),
                rebalanceLimits: d.rebalanceLimits(),
                entryLimits: d.entryLimits()
            })
        );
    }

    function test_time_zone_switches_one_second_either_side() public pure {
        assertEq(NyCalendar.offset(DST_START_2026 - 1), 5 hours);
        assertEq(NyCalendar.offset(DST_START_2026), 4 hours);
        assertEq(NyCalendar.offset(DST_END_2026 - 1), 4 hours);
        assertEq(NyCalendar.offset(DST_END_2026), 5 hours);
        assertEq(NyCalendar.offset(DST_START_2027 - 1), 5 hours);
        assertEq(NyCalendar.offset(DST_START_2027), 4 hours);
    }

    function test_friday_window_in_summer() public view {
        _fridayEdges(FRI_2026_10_16, 4 hours);
    }

    function test_friday_window_in_winter() public view {
        _fridayEdges(FRI_2026_12_04, 5 hours);
    }

    /// The Fridays either side of each switch: 2026-03-06 (EST) and 2026-03-13 (EDT), 2026-10-30 (EDT) and
    /// 2026-11-06 (EST).
    function test_friday_window_in_switch_weeks() public view {
        _fridayEdges(1_772_755_200, 5 hours);
        _fridayEdges(1_773_360_000, 4 hours);
        _fridayEdges(1_793_318_400, 4 hours);
        _fridayEdges(1_793_923_200, 5 hours);
    }

    /// Sunday 20:00 New York reopens, in both the switch weekends.
    function test_reopens_sunday_evening() public view {
        uint256 sunMar8 = DST_START_2026 - 7 hours + 20 hours + 4 hours; // 2026-03-08 20:00 EDT
        assertTrue(x.frozen(sunMar8 - 1));
        assertFalse(x.frozen(sunMar8));
        uint256 sunNov1 = DST_END_2026 - 6 hours + 20 hours + 5 hours; // 2026-11-01 20:00 EST
        assertTrue(x.frozen(sunNov1 - 1));
        assertFalse(x.frozen(sunNov1));
        assertEq(x.nextFreeze(sunNov1 - 1), sunNov1 - 1, "while frozen, now");
    }

    /// Thanksgiving (Thu 2026-11-26): held from Wednesday 20:00 to Thursday 20:00, and Weekend Shield looks on
    /// Wednesday afternoon.
    function test_a_holiday_freezes_from_the_evening_before() public {
        uint256 thu = 1_795_651_200; // 2026-11-26 00:00 UTC
        x.setHolidayNow(uint32(thu / 1 days), true);
        uint256 wed20 = thu - 1 days + 20 hours + 5 hours;
        assertFalse(x.frozen(wed20 - 1));
        assertTrue(x.frozen(wed20));
        assertTrue(x.frozen(wed20 + 1 days - 1));
        assertFalse(x.frozen(wed20 + 1 days), "Thursday 20:00 reopens for Friday");
        assertEq(x.nextFreeze(wed20 - 6 hours), wed20);
        assertTrue(_preFreeze(wed20 - 6 hours));
        assertFalse(_preFreeze(wed20 - 6 hours - 1));
    }

    /// A Monday holiday (MLK, 2027-01-18) keeps the weekend freeze going until Monday 20:00; a Friday one (Good
    /// Friday, 2027-03-26) starts it on Thursday.
    function test_holidays_next_to_a_weekend() public {
        uint256 mon = 1_800_230_400; // 2027-01-18 00:00 UTC
        x.setHolidayNow(uint32(mon / 1 days), true);
        uint256 sun20 = mon - 1 days + 20 hours + 5 hours;
        assertTrue(x.frozen(sun20), "no Sunday reopening");
        assertTrue(x.frozen(sun20 + 1 days - 1));
        assertFalse(x.frozen(sun20 + 1 days));

        uint256 goodFriday = 1_806_019_200; // 2027-03-26 00:00 UTC, summer time
        x.setHolidayNow(uint32(goodFriday / 1 days), true);
        uint256 thu20 = goodFriday - 1 days + 20 hours + 4 hours;
        assertEq(x.nextFreeze(thu20 - 1 hours), thu20);
        assertTrue(_preFreeze(thu20 - 1 hours), "the weekend heads-up's window moves to Thursday");
        assertFalse(_preFreeze(goodFriday + 15 hours + 4 hours), "and is over by Friday");
        assertTrue(x.frozen(goodFriday + 2 days + 20 hours + 4 hours - 1), "until Sunday 20:00");
    }

    /// When prices are next live, the time a heads-up gives for a sale whose wait ends in a freeze: now while they
    /// are; Sunday 20:00 after the Friday freeze, in summer, in winter and in both switch weekends.
    function test_next_open_after_the_weekend() public view {
        uint256 fri20 = FRI_2026_10_16 + 20 hours + 4 hours;
        assertEq(NyCalendar.nextOpen(holidays, fri20 - 1), fri20 - 1, "live: now");
        assertEq(NyCalendar.nextOpen(holidays, fri20), fri20 + 2 days, "Friday 20:00: Sunday 20:00");
        assertEq(NyCalendar.nextOpen(holidays, fri20 + 2 days - 1), fri20 + 2 days);
        uint256 winterFri20 = FRI_2026_12_04 + 20 hours + 5 hours;
        assertEq(NyCalendar.nextOpen(holidays, winterFri20 + 30 minutes), winterFri20 + 2 days);
        uint256 sunMar8 = DST_START_2026 - 7 hours + 20 hours + 4 hours; // 2026-03-08 20:00 EDT
        assertEq(NyCalendar.nextOpen(holidays, sunMar8 - 2 days + 1 hours), sunMar8, "from Friday 20:00 EST");
        uint256 sunNov1 = DST_END_2026 - 6 hours + 20 hours + 5 hours; // 2026-11-01 20:00 EST
        assertEq(NyCalendar.nextOpen(holidays, sunNov1 - 2 days - 1 hours), sunNov1, "from Friday 20:00 EDT");
    }

    /// Holidays: MLK Monday holds the weekend's prices until Monday 20:00, Good Friday's freeze from Thursday 20:00
    /// ends Sunday 20:00, and Thanksgiving's ends Thursday 20:00.
    function test_next_open_past_holidays() public {
        uint256 mon = 1_800_230_400; // 2027-01-18 00:00 UTC
        holidays[uint32(mon / 1 days)] = true;
        assertEq(NyCalendar.nextOpen(holidays, mon - 3 days + 20 hours + 5 hours), mon + 20 hours + 5 hours);

        uint256 goodFriday = 1_806_019_200; // 2027-03-26 00:00 UTC, summer time
        holidays[uint32(goodFriday / 1 days)] = true;
        uint256 thu20 = goodFriday - 1 days + 20 hours + 4 hours;
        assertEq(NyCalendar.nextOpen(holidays, thu20 + 30 minutes), thu20 + 3 days);

        uint256 thanksgiving = 1_795_651_200; // 2026-11-26 00:00 UTC
        holidays[uint32(thanksgiving / 1 days)] = true;
        uint256 wed20 = thanksgiving - 1 days + 20 hours + 5 hours;
        assertEq(NyCalendar.nextOpen(holidays, wed20), wed20 + 1 days);
    }

    /// On the 10,000 calendar timestamps: the next open is live, no earlier than now, and prices are held right up to
    /// it.
    function test_next_open_is_where_the_freeze_ends() public view {
        for (uint256 i; i < 10_000; ++i) {
            uint256 ts = Vectors.calendarTime(i);
            uint256 open = NyCalendar.nextOpen(holidays, ts);
            string memory at = string.concat("t = ", vm.toString(ts));
            assertGe(open, ts, at);
            assertFalse(NyCalendar.frozen(holidays, open), at);
            if (open > ts) assertTrue(NyCalendar.frozen(holidays, open - 1), at);
        }
    }

    /// docs/archive/goose-executor-plan.md §7: with no holiday and a 6-hour window, the weekend heads-up's window is
    /// Leo's inWeekendWindow (plan.ts) and `frozen` is the app's "markets closed" (lib/market-hours).
    function test_agrees_with_the_app_on_10000_timestamps() public view {
        string memory json = vm.readFile("test/vectors/calendar.json");
        bytes memory window = vm.parseJsonBytes(json, ".window");
        bytes memory closed = vm.parseJsonBytes(json, ".frozen");
        for (uint256 i; i < 10_000; ++i) {
            uint256 ts = Vectors.calendarTime(i);
            string memory at = string.concat("t = ", vm.toString(ts));
            assertEq(_preFreeze(ts), Vectors.bit(window, i), at);
            assertEq(x.frozen(ts), Vectors.bit(closed, i), at);
        }
    }

    function _fridayEdges(uint256 fridayUtc, uint256 offset) internal view {
        uint256 at14 = fridayUtc + 14 hours + offset;
        uint256 at20 = fridayUtc + 20 hours + offset;
        assertFalse(_preFreeze(at14 - 1), "13:59:59");
        assertTrue(_preFreeze(at14), "14:00");
        assertTrue(_preFreeze(at20 - 1), "19:59:59");
        assertFalse(x.frozen(at20 - 1));
        assertFalse(_preFreeze(at20), "20:00 is frozen, not before it");
        assertTrue(x.frozen(at20), "20:00");
        assertEq(x.nextFreeze(at14), at20);
    }

    /// The weekend card's window on the executor's calendar: prices are live and the next freeze starts within
    /// `weekendWindow`. The executor makes no move in it; this keeps it agreeing with the app's `inWeekendWindow`.
    function _preFreeze(uint256 ts) internal view returns (bool) {
        (,,, uint32 weekendWindow,) = x.amounts();
        return !x.frozen(ts) && x.nextFreeze(ts) - ts <= weekendWindow;
    }
}
