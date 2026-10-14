import { describe, expect, it } from "vitest";
import { homeStatus, needsExtraConfirm, statusFor } from "@/lib/risk/status";

describe("statusFor", () => {
  it("is none without debt", () => {
    expect(statusFor(null)).toBe("none");
    expect(statusFor(Infinity)).toBe("none");
  });
  it("maps bands at their edges", () => {
    expect(statusFor(1.5)).toBe("safe");
    expect(statusFor(1.4999)).toBe("watch");
    expect(statusFor(1.1)).toBe("watch");
    expect(statusFor(1.0999)).toBe("act");
    expect(statusFor(0.9)).toBe("act");
  });
  it("respects custom bands", () => {
    expect(statusFor(1.3, { safeMin: 1.2, watchMin: 1.05 })).toBe("safe");
  });
  it("requires extra confirmation only for watch/act", () => {
    expect(needsExtraConfirm("safe")).toBe(false);
    expect(needsExtraConfirm("none")).toBe(false);
    expect(needsExtraConfirm("watch")).toBe(true);
    expect(needsExtraConfirm("act")).toBe(true);
  });
});

describe("homeStatus", () => {
  it("shows Safe for nothing owed and keeps the bands as they are", () => {
    expect(homeStatus("none")).toBe("safe");
    expect(homeStatus("watch")).toBe("watch");
    expect(homeStatus("act")).toBe("act");
  });
});
