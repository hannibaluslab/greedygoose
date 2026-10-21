import { describe, expect, it } from "vitest";
import { atText, rebalanceCheckAt, whenText } from "@/lib/agents/next";
import { clockText, dayIn, gmtOffsetMinutes, gmtText } from "@/lib/clock";

/*
 * Check times on the viewer's own clock with its GMT offset (Adrian, 2026-10-21): "Today 5:00 PM GMT+3". The
 * Rebalancer's window opens at 10:00 New York; each zone below is pinned, so the words don't depend on the machine.
 */

/** Intl may put a narrow space before AM or PM: the tests read any space as one. */
const plain = (s: string) => s.replace(/\s/g, " ");

/** Wednesday 2025-10-15, 9:00 New York (13:00 GMT): today's window, 10:00 New York, is still ahead. */
const WED_9AM_NY = Date.UTC(2025, 9, 15, 13) / 1000;
/** Wednesday 2025-10-15, 12:00 New York (16:00 GMT): today's window has passed. */
const WED_NOON_NY = Date.UTC(2025, 9, 15, 16) / 1000;
/** Friday 2025-10-17, 12:00 New York: the next window is Monday's. */
const FRI_NOON_NY = Date.UTC(2025, 9, 17, 16) / 1000;

describe("gmtText: the offset as people write it", () => {
  it("whole hours, half and quarter hours, behind and ahead, and GMT alone at no offset", () => {
    expect(gmtText(0)).toBe("GMT");
    expect(gmtText(180)).toBe("GMT+3");
    expect(gmtText(-240)).toBe("GMT-4");
    expect(gmtText(330)).toBe("GMT+5:30");
    expect(gmtText(345)).toBe("GMT+5:45");
    expect(gmtText(-210)).toBe("GMT-3:30");
    expect(gmtText(600)).toBe("GMT+10");
  });

  it("reads each zone's offset at the time asked, summer time included", () => {
    expect(gmtOffsetMinutes(WED_NOON_NY, "UTC")).toBe(0);
    expect(gmtOffsetMinutes(WED_NOON_NY, "Europe/Istanbul")).toBe(180);
    expect(gmtOffsetMinutes(WED_NOON_NY, "Asia/Kolkata")).toBe(330);
    expect(gmtOffsetMinutes(WED_NOON_NY, "America/New_York")).toBe(-240);
    expect(gmtOffsetMinutes(Date.UTC(2025, 11, 15, 16) / 1000, "America/New_York")).toBe(-300);
  });
});

describe("whenText: today, tomorrow or the weekday, the time, and the offset", () => {
  const check = rebalanceCheckAt(WED_9AM_NY, 0); // Wednesday 10:00 New York, 14:00 GMT

  it("today, for a viewer three hours ahead of GMT: Today 5:00 PM GMT+3 on the card", () => {
    expect(plain(whenText(check, WED_9AM_NY, "Europe/Istanbul"))).toBe("today 5:00 PM GMT+3");
  });

  it("GMT alone for a viewer on GMT, half an hour for India, behind for New York", () => {
    expect(plain(whenText(check, WED_9AM_NY, "UTC"))).toBe("today 2:00 PM GMT");
    expect(plain(whenText(check, WED_9AM_NY, "Asia/Kolkata"))).toBe("today 7:30 PM GMT+5:30");
    expect(plain(whenText(check, WED_9AM_NY, "America/New_York"))).toBe("today 10:00 AM GMT-4");
  });

  it("tomorrow once today's window has passed, and the weekday further out", () => {
    const thu = rebalanceCheckAt(WED_NOON_NY, 0);
    expect(plain(whenText(thu, WED_NOON_NY, "Europe/Istanbul"))).toBe("tomorrow 5:00 PM GMT+3");
    const mon = rebalanceCheckAt(FRI_NOON_NY, 0);
    expect(plain(whenText(mon, FRI_NOON_NY, "Europe/Istanbul"))).toBe("Mon 5:00 PM GMT+3");
  });

  it("counts days on the viewer's own calendar: Thursday 1:00 AM in Tokyo, the check is tonight", () => {
    const thu = rebalanceCheckAt(WED_NOON_NY, 0); // Thursday 14:00 GMT, 23:00 in Tokyo
    expect(plain(whenText(thu, WED_NOON_NY, "Asia/Tokyo"))).toBe("today 11:00 PM GMT+9");
    expect(dayIn(WED_NOON_NY, "Asia/Tokyo") - dayIn(WED_NOON_NY, "UTC")).toBe(1);
  });

  it("shows the offset the check falls in: past New York's clock change, GMT-5", () => {
    const sat = Date.UTC(2025, 10, 1, 16) / 1000; // Saturday 2025-11-01, still summer time
    const mon = rebalanceCheckAt(sat, 0); // Monday 2025-11-03, 10:00 New York, winter time
    expect(plain(whenText(mon, sat, "America/New_York"))).toBe("Mon 10:00 AM GMT-5");
    expect(plain(clockText(sat, "America/New_York"))).toBe("12:00 PM GMT-4");
  });

  it("the viewer's own zone when none is pinned", () => {
    expect(plain(whenText(check, WED_9AM_NY))).toMatch(/^(today|tomorrow|[A-Z][a-z]{2}) \d{1,2}:\d{2} [AP]M GMT/);
  });
});

describe("atText: the same in a sentence, with the day said", () => {
  // Friday 2025-10-17, 14:30 New York; prices pause at 20:00 New York, Saturday 00:00 GMT.
  const fri = Date.UTC(2025, 9, 17, 18, 30) / 1000;
  const freeze = Date.UTC(2025, 9, 18, 0) / 1000;

  it("the weekend freeze is already Saturday east of New York, so the day comes with the time", () => {
    expect(plain(atText(freeze, fri, "Europe/Istanbul"))).toBe("tomorrow at 3:00 AM GMT+3");
    expect(plain(atText(freeze, fri, "UTC"))).toBe("tomorrow at 12:00 AM GMT");
    expect(plain(atText(freeze, fri, "America/New_York"))).toBe("today at 8:00 PM GMT-4");
  });
});
