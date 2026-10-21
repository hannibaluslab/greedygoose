import { describe, expect, it } from "vitest";
import {
  KEEP_DEFAULT_USD,
  KEEP_MAX_USD,
  keepText,
  keepToStart,
  parseKeepUsd,
  topUpsChanged,
  topUpsView,
  type TopUpsChoice,
  type TopUpsFacts,
} from "@/lib/agents/topUps";

/** Wednesday 2025-10-15 12:00 New York (16:00 UTC). */
const WED_NOON = Date.UTC(2025, 9, 15, 16) / 1000;
const DAY = 86_400;

/** Top-ups available and on with Keep $500, $600 owed, Protect · sell running, the cash at 4.2%. */
function input(over: Partial<TopUpsFacts & TopUpsChoice> = {}): TopUpsFacts & TopUpsChoice {
  return {
    available: true,
    earningFirst: false,
    saved: { on: true, keepUsd: 500 },
    waiting: null,
    rate: "4.2%",
    debtUsd: 600,
    protectSells: true,
    nowSec: WED_NOON,
    on: true,
    keepUsd: 500,
    ...over,
  };
}

const WARNING = {
  kind: "warning",
  title: "Protect may have nothing to use",
  line: "You owe $600 and Protect can’t sell. Keep some cash, or let Protect sell.",
};

describe("topUpsView: the switch", () => {
  it("is greyed with “Not available yet.” until the executor counts top-ups", () => {
    expect(topUpsView(input({ available: false, saved: null, on: false }))).toEqual({
      disabled: true,
      blocked: "Not available yet.",
      open: false,
      helper: null,
      note: null,
    });
  });

  it("waits for earning when it can't be turned on in the same signature, but can always be turned off", () => {
    expect(topUpsView(input({ earningFirst: true, saved: { on: false, keepUsd: 500 }, on: false }))).toMatchObject({
      disabled: true,
      blocked: "Turn on earning first.",
    });
    expect(topUpsView(input({ earningFirst: true }))).toMatchObject({ disabled: false, blocked: null });
  });

  it("can be switched back on after switching it off, while earning waits", () => {
    expect(topUpsView(input({ earningFirst: true, on: false }))).toMatchObject({ disabled: false, blocked: null });
  });

  it("is greyed with nothing to say while the setting isn't read", () => {
    expect(topUpsView(input({ saved: null, on: false }))).toMatchObject({ disabled: true, blocked: null });
  });

  it("shows nothing under it while off (board 7e)", () => {
    expect(topUpsView(input({ saved: { on: false, keepUsd: 500 }, on: false }))).toEqual({
      disabled: false,
      blocked: null,
      open: false,
      helper: null,
      note: null,
    });
  });
});

describe("topUpsView: Keep as cash's line", () => {
  it("says top-ups fill Keep first, at the live cash rate (board 7f)", () => {
    expect(topUpsView(input()).helper).toBe("Top-ups fill this first. It keeps earning 4.2%.");
    expect(topUpsView(input({ rate: null })).helper).toBe("Top-ups fill this first.");
    expect(topUpsView(input({ keepUsd: null })).helper).toBe("Top-ups fill this first. It keeps earning 4.2%.");
  });

  it("says every top-up goes into the mix with Keep $0 (board 7h)", () => {
    expect(topUpsView(input({ keepUsd: 0 })).helper).toBe("Every top-up goes into your mix.");
  });
});

describe("topUpsView: the one note", () => {
  it("says it starts with the next top-up while turning it on (board 7f)", () => {
    expect(topUpsView(input({ saved: { on: false, keepUsd: 500 } })).note).toEqual({
      kind: "starts",
      title: "Starts with your next top-up",
      line: "The cash you have now stays as it is.",
    });
  });

  it("names a top-up waiting for the next check, and that it earns until then (board 7g)", () => {
    const waiting = topUpsView(input({ waiting: { usd: 300, atSec: WED_NOON + DAY } })).note;
    expect(waiting).toMatchObject({ kind: "waiting", title: "$300 waiting" });
    expect(waiting?.line).toMatch(
      /^Goes into your mix tomorrow at \d{1,2}:\d{2}\s[AP]M GMT([+-]\d{1,2}(:\d{2})?)?\. It earns until then\.$/,
    );
    expect(topUpsView(input({ waiting: { usd: 300.5, atSec: WED_NOON + DAY } })).note?.title).toBe("$300.50 waiting");
    // Dust is no top-up to name.
    expect(topUpsView(input({ waiting: { usd: 0.004, atSec: WED_NOON + DAY } })).note).toBeNull();
  });

  it("warns only when something is owed, Keep is $0 and Protect can't sell (board 7h)", () => {
    expect(topUpsView(input({ keepUsd: 0, protectSells: false })).note).toEqual(WARNING);
    // Each condition alone off: no warning.
    expect(topUpsView(input({ keepUsd: 0, protectSells: true })).note).toBeNull();
    expect(topUpsView(input({ keepUsd: 1, protectSells: false })).note).toBeNull();
    expect(topUpsView(input({ keepUsd: null, protectSells: false })).note).toBeNull();
    expect(topUpsView(input({ keepUsd: 0, protectSells: false, debtUsd: 0 })).note).toBeNull();
    expect(topUpsView(input({ keepUsd: 0, protectSells: false, debtUsd: 0.004 })).note).toBeNull();
  });

  it("says what's owed as Home does, rounded up to the dollar", () => {
    expect(topUpsView(input({ keepUsd: 0, protectSells: false, debtUsd: 1_234.01 })).note?.line).toBe(
      "You owe $1,235 and Protect can’t sell. Keep some cash, or let Protect sell.",
    );
  });

  it("puts the warning before the other notes", () => {
    const off = { on: false, keepUsd: 500 };
    expect(topUpsView(input({ saved: off, keepUsd: 0, protectSells: false })).note).toEqual(WARNING);
    expect(
      topUpsView(input({ keepUsd: 0, protectSells: false, waiting: { usd: 300, atSec: WED_NOON + DAY } })).note,
    ).toEqual(WARNING);
  });

  it("has nothing to say while on with nothing waiting", () => {
    expect(topUpsView(input()).note).toBeNull();
  });
});

describe("Keep as cash: whole dollars, $0 allowed, at most $1,000,000", () => {
  it("reads what's typed", () => {
    expect(parseKeepUsd("$500")).toBe(500);
    expect(parseKeepUsd("1,250")).toBe(1_250);
    expect(parseKeepUsd("$0")).toBe(0);
    expect(parseKeepUsd("0500")).toBe(500);
    expect(parseKeepUsd("")).toBeNull();
    expect(parseKeepUsd("$")).toBeNull();
    // Whole dollars: what's after a dot is dropped, never joined to the dollars.
    expect(parseKeepUsd("$12.99")).toBe(12);
    expect(parseKeepUsd("$2,000,000")).toBe(KEEP_MAX_USD);
  });

  it("shows what it holds", () => {
    expect(keepText(500)).toBe("$500");
    expect(keepText(0)).toBe("$0");
    expect(keepText(KEEP_MAX_USD)).toBe("$1,000,000");
    expect(keepText(null)).toBe("");
  });

  it("starts at $500 when turned on, or at what the executor has while it's on", () => {
    expect(keepToStart(null)).toBe(KEEP_DEFAULT_USD);
    expect(keepToStart({ on: false, keepUsd: 0 })).toBe(500);
    expect(keepToStart({ on: true, keepUsd: 0 })).toBe(0);
    expect(keepToStart({ on: true, keepUsd: 1_200 })).toBe(1_200);
  });
});

describe("topUpsChanged", () => {
  it("counts the switch, and Keep only while it's on", () => {
    const on = { on: true, keepUsd: 500 };
    expect(topUpsChanged(on, { on: true, keepUsd: 500 })).toBe(false);
    expect(topUpsChanged(on, { on: true, keepUsd: 0 })).toBe(true);
    expect(topUpsChanged(on, { on: true, keepUsd: null })).toBe(true);
    expect(topUpsChanged(on, { on: false, keepUsd: 500 })).toBe(true);
    expect(topUpsChanged({ on: false, keepUsd: 500 }, { on: false, keepUsd: 0 })).toBe(false);
    expect(topUpsChanged(null, { on: true, keepUsd: 500 })).toBe(false);
  });
});
