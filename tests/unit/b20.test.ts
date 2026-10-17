import { describe, expect, it } from "vitest";
import { rawToShares, sharesToRaw } from "@/lib/tokens/b20";

const ONE = 10n ** 18n;

describe("sharesToRaw", () => {
  it("is identity at multiplier 1", () => expect(sharesToRaw("1.5", ONE, 8)).toBe(150_000_000n));
  it("divides by the multiplier after a dividend", () =>
    expect(sharesToRaw("1.02", (ONE * 102n) / 100n, 8)).toBe(100_000_000n));
  it("rejects junk and truncates extra decimals", () => {
    expect(sharesToRaw("1.2.3", ONE, 8)).toBe(0n);
    expect(sharesToRaw("abc", ONE, 8)).toBe(0n);
    expect(sharesToRaw("", ONE, 8)).toBe(0n);
    expect(sharesToRaw("0.123456789", ONE, 8)).toBe(12_345_678n);
  });
  it("round-trips", () =>
    expect(rawToShares(sharesToRaw("3.25", (ONE * 11n) / 10n, 8), (ONE * 11n) / 10n, 8)).toBeCloseTo(3.25, 6));
});
