// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DateTimeLib} from "solady/utils/DateTimeLib.sol";

/// @title NyCalendar
/// @notice When the stock prices are held. Coinbase's tokenized stocks are priced by Chainlink 24/5 feeds that update
///         from Sunday 20:00 to Friday 20:00 New York time (lib/market-hours), and have no paused flag to read. So the
///         executor keeps this calendar: each trading session runs from 20:00 the evening before to 20:00 New York,
///         and prices are held through any session that falls on a Saturday, a Sunday or a holiday.
/// @dev Days are New York calendar days, counted from 1970-01-01. US time-zone rule since 2007: daylight time from the
///      2nd Sunday of March at 02:00 EST (07:00 UTC) to the 1st Sunday of November at 02:00 EDT (06:00 UTC).
library NyCalendar {
    uint256 internal constant DAY = 1 days;
    /// The feeds stop and start at 20:00 New York.
    uint256 internal constant CLOSE = 20 hours;

    /// Seconds New York is behind UTC at `ts`: 4 hours in daylight time, 5 otherwise.
    function offset(uint256 ts) internal pure returns (uint256) {
        (uint256 year,,) = DateTimeLib.timestampToDate(ts);
        uint256 start = DateTimeLib.nthWeekdayInMonthOfYearTimestamp(year, 3, 2, DateTimeLib.SUN) + 7 hours;
        uint256 end = DateTimeLib.nthWeekdayInMonthOfYearTimestamp(year, 11, 1, DateTimeLib.SUN) + 6 hours;
        return ts >= start && ts < end ? 4 hours : 5 hours;
    }

    /// The New York date of `ts`.
    function day(uint256 ts) internal pure returns (uint256) {
        return (ts - offset(ts)) / DAY;
    }

    /// The session live at `ts`: the New York date it ends on, at 20:00.
    function session(uint256 ts) internal pure returns (uint256) {
        return (ts - offset(ts) + DAY - CLOSE) / DAY;
    }

    /// Whether a session's prices are held: a Saturday, a Sunday or a holiday.
    function closed(mapping(uint32 => bool) storage holiday, uint256 d) internal view returns (bool) {
        return DateTimeLib.weekday(d * DAY) >= DateTimeLib.SAT || holiday[uint32(d)];
    }

    /// Whether prices are held at `ts`.
    function frozen(mapping(uint32 => bool) storage holiday, uint256 ts) internal view returns (bool) {
        return closed(holiday, session(ts));
    }

    /// When the next freeze starts: `ts` itself while frozen, otherwise 20:00 New York before the next closed session.
    function nextFreeze(mapping(uint32 => bool) storage holiday, uint256 ts) internal view returns (uint256) {
        uint256 d = session(ts);
        if (closed(holiday, d)) return ts;
        do {
            ++d; // a Saturday is at most five sessions away
        } while (!closed(holiday, d));
        return start(d);
    }

    /// When prices are next live: `ts` itself while they are, otherwise 20:00 New York before the next open session.
    function nextOpen(mapping(uint32 => bool) storage holiday, uint256 ts) internal view returns (uint256) {
        uint256 d = session(ts);
        if (!closed(holiday, d)) return ts;
        do {
            ++d; // past the weekend and any holiday next to it
        } while (closed(holiday, d));
        return start(d);
    }

    /// When session `d` starts: 20:00 New York the evening before, hours away from any time-zone switch (Sundays,
    /// 02:00), so a 5-hour guess at the UTC time finds the right offset.
    function start(uint256 d) internal pure returns (uint256) {
        uint256 local = (d - 1) * DAY + CLOSE;
        return local + offset(local + 5 hours);
    }
}
