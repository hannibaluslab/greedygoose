import { describe, expect, it } from "vitest";
import { MIX_WHOLE, setMixRow } from "@/lib/agents/mix";

describe("setMixRow: the mix never adds up to more than 100%", () => {
  const rows = [
    { reserveId: 0, bps: 6_000 },
    { reserveId: 5, bps: 3_000 },
  ];
  const sum = (r: { bps: number }[]) => r.reduce((a, x) => a + x.bps, 0);

  it("a target stops where the other stocks leave off", () => {
    const next = setMixRow(rows, 5, 7_000);
    expect(next.find((r) => r.reserveId === 5)!.bps).toBe(4_000);
    expect(sum(next)).toBe(MIX_WHOLE);
  });

  it("under the room it's taken as set, and never under 0", () => {
    expect(setMixRow(rows, 5, 2_500).find((r) => r.reserveId === 5)!.bps).toBe(2_500);
    expect(setMixRow(rows, 5, -100).find((r) => r.reserveId === 5)!.bps).toBe(0);
  });

  it("other stocks don't move", () => {
    expect(setMixRow(rows, 5, 9_000).find((r) => r.reserveId === 0)!.bps).toBe(6_000);
  });
});
