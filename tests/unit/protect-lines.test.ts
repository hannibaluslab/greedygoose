import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData } from "viem";

// The app's Guard, before anything reads lib/agents/config.ts: the allowlist only lets it through once it's set.
const GUARD = vi.hoisted(() => {
  const guard = "0x00000000000000000000000000000000000e5ec0" as const;
  process.env.NEXT_PUBLIC_GOOSE_GUARD = guard;
  return guard;
});

import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import {
  backToText,
  DEFAULT_LINES,
  lineOptions,
  lineText,
  linesOk,
  LINE_MIN,
  TARGET_GAP,
  TARGET_MAX,
  targetOptions,
} from "@/lib/agents/lines";
import { protectBatch, protectSteps, savedChoice, sellLimitsFor, type ProtectSaved } from "@/lib/agents/protect";
import { buildSetProtectCalls } from "@/lib/agents/settings";
import { assertAllowed } from "@/lib/allowlist";

const user = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const on: ProtectSaved = {
  repayOn: true,
  sell: { limitsRaw: sellLimitsFor([]) },
  keepMix: false,
  lines: { line: 10_300, target: 11_200 },
};
const setProtect = (line: number, target: number) =>
  encodeFunctionData({ abi: guardAbi, functionName: "setProtect", args: [line, target] });
const send = (data: `0x${string}`) => assertAllowed(user, [{ to: GUARD, data, value: 0n }]);

describe("Protector's line and target (decision 3), in GooseGuard's units", () => {
  it("mirrors the Guard's bounds and defaults: line from 1.03, target 0.05 above it, at most 1.40", () => {
    expect([LINE_MIN, TARGET_GAP, TARGET_MAX]).toEqual([10_300, 500, 14_000]);
    expect(DEFAULT_LINES).toEqual({ line: 10_300, target: 11_200 });
    expect(linesOk(10_300, 10_800)).toBe(true);
    expect(linesOk(13_500, 14_000)).toBe(true);
    expect(linesOk(10_200, 11_200)).toBe(false);
    expect(linesOk(10_500, 10_999)).toBe(false);
    expect(linesOk(10_500, 14_100)).toBe(false);
    expect(linesOk(10_300.5, 11_200)).toBe(false);
  });

  it("writes them as the app writes health: two decimals, more only for a finer step set elsewhere", () => {
    expect(lineText(10_300)).toBe("1.03");
    expect(lineText(14_000)).toBe("1.40");
    expect(lineText(10_350)).toBe("1.035");
    expect(lineText(10_333)).toBe("1.0333");
  });

  it("offers lines from 1.03 to 1.35, and keeps a line chosen elsewhere on the list", () => {
    const lines = lineOptions(10_300);
    expect(lines[0]).toBe(10_300);
    expect(lines.at(-1)).toBe(13_500);
    expect(lines.every((l) => linesOk(l, l + TARGET_GAP))).toBe(true);
    expect(lineOptions(11_700)).toContain(11_700);
    expect(lineOptions(10_000)).not.toContain(10_000);
    // A saved line set outside the app stays on the list after the user picks another one, so they can go back to it.
    expect(lineOptions(10_400, 10_350)).toEqual(expect.arrayContaining([10_350, 10_400]));
  });

  it("offers targets from 0.05 above the line up to 1.40, the default and a chosen one among them", () => {
    expect(targetOptions(10_300, 11_200)[0]).toBe(10_800);
    expect(targetOptions(10_300, 11_200)).toContain(11_200);
    expect(targetOptions(10_700, 11_200)[0]).toBe(11_200);
    expect(targetOptions(11_000, 11_500)).toEqual([11_500, 12_000, 12_500, 13_000, 13_500, 14_000]);
    expect(targetOptions(13_500, 14_000)).toEqual([14_000]);
    expect(targetOptions(10_300, 11_700)).toContain(11_700);
    expect(targetOptions(11_000, 11_200)).not.toContain(11_200);
    // The saved target stays too, while it still fits 0.05 above the line.
    expect(targetOptions(10_400, 12_000, 11_700)).toEqual(expect.arrayContaining([11_700, 12_000]));
    expect(targetOptions(11_500, 12_000, 11_700)).not.toContain(11_700);
  });
});

describe("where the copy says Protector brings the credit back to", () => {
  it("says Watch only when it steps in from Act and stops in Watch, as the defaults do; else the number", () => {
    expect(backToText({ line: 1.03, target: 1.12 })).toBe("Watch");
    expect(backToText({ line: 1.03, target: 1.08 })).toBe("1.08");
    expect(backToText({ line: 1.15, target: 1.25 })).toBe("1.25");
  });
});

describe("protectSteps with the line and target", () => {
  it("starts on the saved numbers, or the defaults before they're read", () => {
    expect(savedChoice(on)).toMatchObject({ line: 10_300, target: 11_200 });
    expect(savedChoice({ ...on, lines: { line: 10_500, target: 11_500 } })).toMatchObject({
      line: 10_500,
      target: 11_500,
    });
    expect(savedChoice({ ...on, lines: null })).toMatchObject(DEFAULT_LINES);
    expect(protectSteps(on, savedChoice(on)).steps).toEqual([]);
  });

  it("a changed line or target is one setProtect step, with both numbers, before everything else", () => {
    const steps = protectSteps(on, { ...savedChoice(on), line: 10_500, target: 11_500, keepMix: true }).steps;
    expect(steps[0]).toEqual({ kind: "lines", line: 10_500, target: 11_500 });
    expect(steps[1]).toEqual({ kind: "keepMix", on: true });
    expect(protectSteps(on, { ...savedChoice(on), target: 12_000 }).steps).toEqual([
      { kind: "lines", line: 10_300, target: 12_000 },
    ]);
  });

  it("while Protector is off, saving sets the numbers and switches it on in the same batch", () => {
    const off: ProtectSaved = { repayOn: false, sell: null, keepMix: false, lines: { line: 10_300, target: 11_200 } };
    const steps = protectSteps(off, { ...savedChoice(off), line: 10_800, target: 13_000 }).steps;
    expect(steps).toEqual([
      { kind: "lines", line: 10_800, target: 13_000 },
      { kind: "grant", job: "protect" },
    ]);
    expect(protectBatch(steps)).toMatchObject({
      grants: [{ job: "protect" }],
      lines: { line: 10_800, target: 13_000 },
    });
  });

  it("sends nothing for the numbers until they're read: a save never overwrites what it hasn't seen", () => {
    const unread = { ...on, lines: null };
    expect(protectSteps(unread, { ...savedChoice(unread), line: 10_500, target: 11_500 }).steps).toEqual([]);
  });

  it("blocks a target the Guard won't take", () => {
    expect(protectSteps(on, { ...savedChoice(on), line: 11_000, target: 11_200 })).toEqual({
      steps: [],
      blocked: "Bring your credit back at least 0.05 above where Protector steps in.",
    });
  });

  it("a numbers-only save is a batch of its own", () => {
    expect(protectBatch([{ kind: "lines", line: 10_400, target: 11_200 }])).toEqual({
      grants: [],
      off: [],
      lines: { line: 10_400, target: 11_200 },
    });
  });
});

describe("setProtect's call", () => {
  it("goes to the Guard with the two numbers in its units", () => {
    const [call] = buildSetProtectCalls(user, 10_500, 11_500);
    expect(call.to).toBe(GUARD);
    expect(call.value).toBe(0n);
    expect(decodeFunctionData({ abi: guardAbi, data: call.data })).toMatchObject({
      functionName: "setProtect",
      args: [10_500, 11_500],
    });
  });

  it("is never built with numbers the Guard would refuse", () => {
    expect(() => buildSetProtectCalls(user, 10_200, 11_200)).toThrow(/out of range/);
    expect(() => buildSetProtectCalls(user, 11_000, 11_200)).toThrow(/out of range/);
    expect(() => buildSetProtectCalls(user, 10_300, 14_100)).toThrow(/out of range/);
  });

  it("the allowlist takes only numbers the Guard takes, and (0, 0) for its defaults", () => {
    expect(send(setProtect(10_300, 11_200))).toHaveLength(1);
    expect(send(setProtect(0, 0))).toHaveLength(1);
    expect(() => send(setProtect(10_200, 11_200))).toThrow(/Blocked: unexpected arguments to setProtect/);
    expect(() => send(setProtect(10_500, 10_900))).toThrow(/Blocked: unexpected arguments to setProtect/);
    expect(() => send(setProtect(10_300, 14_100))).toThrow(/Blocked: unexpected arguments to setProtect/);
    expect(() => send(setProtect(0, 11_200))).toThrow(/Blocked: unexpected arguments to setProtect/);
  });
});
