import { describe, expect, it } from "vitest";
import { protectCard, protectCardLabel, type ProtectCardInput } from "@/lib/agents/protectCard";

const NOW = 1_760_000_000;
const DAY = 86_400;
const base: ProtectCardInput = {
  live: true,
  nowSec: NOW,
  status: "on",
  waiting: null,
  hf: 1.62,
  rescuing: false,
  fails: 0,
  cooldownUntil: 0,
  stoppedAt: null,
  endsAt: NOW + 200 * DAY,
  act: null,
  weekend: null,
  next: { idle: "Safe. Nothing to do." },
  triggerHf: 1.03,
  targetHf: 1.12,
};
const card = (over: Partial<ProtectCardInput>) => protectCard({ ...base, ...over });

describe("Protect's card on the Agents overview: one pill, the credit health, the levels bar, two lines", () => {
  it("all good: On, the health and its word, the room before Protect's line rounded down", () => {
    expect(card({})).toEqual({
      pill: { text: "On", tone: "on" },
      hf: 1.62,
      word: "Safe",
      bar: { hf: 1.62, line: 1.03, target: 1.12, guarded: true, working: false, dropPct: null },
      line1: "Steps in only under 1.03.",
      line2: "Your stocks can fall 36% before that.",
    });
    // 1 - 1.03/1.28 = 19.5%: never said as 20%.
    expect(card({ hf: 1.28 })).toMatchObject({ word: "Watch", line2: "Your stocks can fall 19% before that." });
  });

  it("needs you while JAW granted it and the executor doesn't run it yet; nothing guards the line", () => {
    expect(card({ status: "starting" })).toMatchObject({
      pill: { text: "Needs you", tone: "needs" },
      line1: "One more Face ID turns it on.",
      line2: "Until then, nothing steps in.",
      bar: { guarded: false },
    });
  });

  it("stopped on its own says when, with no reason on the card (Adrian: not needed)", () => {
    const c = card({ status: "off", stoppedAt: NOW - 2 * DAY });
    expect(c.pill).toEqual({ text: "Stopped", tone: "needs" });
    expect(c.line1).toMatch(/^Stopped on \w{3} \d{1,2}\. Nothing steps in now\.$/);
    expect(c.line2).toBeNull();
  });

  it("off: what it would do, in Act's colour when the credit is in Act with nothing to step in", () => {
    expect(card({ status: "off" })).toMatchObject({
      pill: { text: "Off", tone: "neutral" },
      line1: "When on, it steps in under 1.03.",
      line2: "Nothing steps in while it’s off.",
      bar: { guarded: false },
    });
    expect(card({ status: "off", hf: 1.06, act: { addUsd: 54, protectOn: false } })).toMatchObject({
      pill: { text: "Off", tone: "act" },
      word: "Act",
      line1: "Your credit is in Act. Nothing steps in.",
      line2: "Repaying $54 now brings it back to Watch.",
    });
  });

  it("working: lime, the path back to 1.12 on the bar, and the rule's next move", () => {
    const c = card({ rescuing: true, hf: 1.01, next: { will: "repays $98.22 from your cash", would: "x" } });
    expect(c).toMatchObject({
      pill: { text: "Working", tone: "working" },
      line1: "Bringing your credit back to 1.12.",
      line2: "Next: repays $98.22 from your cash.",
      bar: { working: true, guarded: true },
    });
  });

  it("retrying after 3 failed runs, with when they try again", () => {
    const c = card({ fails: 3, cooldownUntil: NOW + 20 * 60 });
    expect(c.pill).toEqual({ text: "Retrying", tone: "watch" });
    expect(c.line1).toBe("Your agents’ last 3 runs didn’t go through.");
    expect(c.line2).toMatch(/^Nothing moved\. They try again at \d{1,2}:\d{2}\s?[AP]M\.$/);
    expect(card({ fails: 3, cooldownUntil: NOW - 1 }).line2).toBe("Nothing moved. They try again on the next run.");
  });

  it("in Act above Protect's line: still On, the gap back to Watch", () => {
    expect(card({ hf: 1.07, act: { addUsd: 45, protectOn: true } })).toMatchObject({
      pill: { text: "On", tone: "on" },
      word: "Act",
      line1: "Steps in if your credit falls under 1.03.",
      line2: "Repaying $45 now brings it back to Watch.",
    });
  });

  it("weekend risk: the drop on the bar and the app's own weekend words", () => {
    expect(card({ hf: 1.16, weekend: { addUsd: 96, dropPct: 15, when: "at 8:00 PM" } })).toMatchObject({
      pill: { text: "Weekend risk", tone: "needs" },
      line1: "Prices pause at 8:00 PM. If stocks reopen 15% lower, Aave can sell part of them.",
      line2: "Repaying $96 now keeps your credit over Aave’s line.",
      bar: { dropPct: 15 },
    });
  });

  it("ends soon within a week, then nothing steps in", () => {
    const c = card({ endsAt: NOW + 4 * DAY });
    expect(c.pill).toEqual({ text: "Ends soon", tone: "watch" });
    expect(c.line1).toMatch(/^Ends on \w{3} \d{1,2}\. Then nothing steps in\.$/);
  });

  it("the first state that applies wins", () => {
    // A grant waiting for its batch beats everything; a rescue beats failed runs; failed runs beat Act.
    expect(card({ status: "starting", rescuing: true, fails: 5 }).pill.text).toBe("Needs you");
    expect(card({ rescuing: true, fails: 5, hf: 1.01 }).pill.text).toBe("Working");
    expect(card({ fails: 5, hf: 1.07, act: { addUsd: 45, protectOn: true } }).pill.text).toBe("Retrying");
    expect(
      card({ hf: 1.07, act: { addUsd: 45, protectOn: true }, weekend: { addUsd: 1, dropPct: 15, when: "x" } }).pill
        .text,
    ).toBe("On");
  });

  it("selling granted and waiting for its batch: Needs you, while repaying from cash still guards the line", () => {
    expect(card({ waiting: "sell" })).toMatchObject({
      pill: { text: "Needs you", tone: "needs" },
      line1: "One more Face ID turns on selling.",
      line2: "Until then, it repays from your cash only.",
      bar: { guarded: true },
    });
    expect(card({ waiting: "protect" }).line1).toBe("One more Face ID turns it on.");
  });

  it("under Protect's line before a rescue starts: about to step in, or held back, never 'steps in if it falls'", () => {
    expect(card({ hf: 1.02, next: { will: "repays $40 from your cash", would: "x" } })).toMatchObject({
      pill: { text: "On", tone: "act" },
      word: "Act",
      line1: "Your credit is under 1.03.",
      line2: "Next: repays $40 from your cash.",
    });
    expect(card({ hf: 1.02, next: { idle: "Act. No cash to repay with" } })).toMatchObject({
      pill: { text: "On hold", tone: "needs" },
      line1: "Can’t bring your credit back to 1.12 yet.",
      line2: "Act. No cash to repay with.",
    });
  });

  it("an ending grant says so even with nothing owed", () => {
    expect(card({ hf: null, endsAt: NOW + 3 * DAY }).pill.text).toBe("Ends soon");
  });

  it("nothing owed, and not live yet", () => {
    expect(card({ hf: null })).toMatchObject({
      hf: null,
      word: null,
      line1: "Nothing owed, nothing to do.",
      line2: null,
    });
    expect(card({ live: false })).toMatchObject({ pill: { text: "Soon", tone: "neutral" }, bar: { guarded: false } });
  });

  it("reads as one line to a screen reader, and never names the machinery", () => {
    expect(protectCardLabel(card({}))).toBe("Protect, on. Your credit health 1.62, Safe. Steps in only under 1.03.");
    const words = [card({}), card({ status: "starting" }), card({ fails: 3 }), card({ rescuing: true })]
      .flatMap((c) => [c.pill.text, c.line1, c.line2 ?? ""])
      .join(" ");
    expect(words).not.toMatch(/borrow|lock|permission|executor|registry|register|grant/i);
  });
});
