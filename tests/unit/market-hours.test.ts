import { describe, expect, it } from "vitest";
import { marketState } from "@/lib/market-hours";

// 2026-10-12 is a Monday. EDT = UTC-4.
const at = (iso: string) => marketState(new Date(iso)).open;

describe("marketState", () => {
  it("is open midweek", () => expect(at("2026-10-14T15:00:00Z")).toBe(true));
  it("closes Friday 20:00 ET", () => {
    expect(at("2026-10-16T23:59:00Z")).toBe(true); // Fri 19:59 ET
    expect(at("2026-10-17T00:00:00Z")).toBe(false); // Fri 20:00 ET
  });
  it("is closed Saturday", () => expect(at("2026-10-17T18:00:00Z")).toBe(false));
  it("reopens Sunday 20:00 ET", () => {
    expect(at("2026-10-18T23:59:00Z")).toBe(false); // Sun 19:59 ET
    expect(at("2026-10-19T00:00:00Z")).toBe(true); // Sun 20:00 ET
  });
});
