import { describe, expect, it } from "vitest";
import { fallTo, healthMargins, healthParts } from "@/lib/risk/health";

describe("the credit status sheet's maths, on Aave's rules", () => {
  const holdings = [
    { symbol: "GOOGLc", name: "Alphabet", backingUsd: 5 },
    { symbol: "AAPLc", name: "Apple", backingUsd: 0 },
  ];

  it("each stock backs its value × its backing factor; health is what they back ÷ what's owed", () => {
    const h = healthParts(holdings, { GOOGLc: 0.79, AAPLc: 0.78 }, 3.4)!;
    expect(h.parts).toEqual([{ symbol: "GOOGLc", name: "Alphabet", valueUsd: 5, cf: 0.79, backsUsd: 3.95 }]);
    expect(h.backsUsd).toBeCloseTo(3.95, 9);
    expect(h.health).toBeCloseTo(3.95 / 3.4, 9);
  });

  it("nothing to show while the factors load or nothing is owed", () => {
    expect(healthParts(holdings, undefined, 3.4)).toBeNull();
    expect(healthParts(holdings, { GOOGLc: 0.79 }, 0)).toBeNull();
  });

  it("the stocks can fall 1 − line ÷ health before the health reaches a line", () => {
    expect(fallTo(1.25, 1)).toBeCloseTo(0.2, 9);
    expect(fallTo(1.05, 1.1)).toBe(0);
    const m = healthMargins(1.16);
    expect(m.toAave).toBeCloseTo(1 - 1 / 1.16, 9);
    expect(m.toAct).toBeCloseTo(1 - 1.1 / 1.16, 9);
  });
});
