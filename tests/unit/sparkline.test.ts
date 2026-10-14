import { describe, expect, it } from "vitest";
import { captionCorner } from "@/components/gg/Sparkline";

// Invest's hero line (PortfolioPage): 350 × 34, padded 2 / 10 / 7 / 7 as Sparkline draws it, with "Market prices · 7 days"
// (22 characters at 6.8px) 12px tall in a corner, and the lime dot's 4.25px around the last point.
const W = 350;
const H = 34;
const CAPTION = { width: 22 * 6.8, height: 12 };
const DOT = 4.25;
const hero = (points: number[]) => {
  const min = Math.min(...points);
  const range = Math.max(...points) - min;
  return points.map((p, i) => ({ x: 2 + (i / (points.length - 1)) * (W - 12), y: 7 + (1 - (p - min) / range) * (H - 14) }));
};
const corner = (points: number[]) => captionCorner(hero(points), W, H, CAPTION, DOT);

describe("captionCorner (the caption inside the hero line)", () => {
  it("sits top-left over a week that starts low", () => {
    expect(corner([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])).toBe("top-left");
  });

  it("drops to the bottom-left when the week starts high", () => {
    expect(corner([13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).toBe("bottom-left");
  });

  it("moves right when the line fills the left, and stays clear of the dot", () => {
    // Down to the low and back up under the left corners, then high to the end: the dot is at the top right.
    expect(corner([10, 0, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10])).toBe("bottom-right");
  });

  it("counts the line between points, where it crosses the caption's edge", () => {
    // Its only point under the caption is at y 18, 6px below a top corner; but the line climbs to y 1.2 by the
    // caption's right edge, so the top left is taken and the bottom left (4px clear of y 18) is free.
    expect(captionCorner([{ x: 2, y: 18 }, { x: 160, y: 0 }, { x: 340, y: 18 }], W, H, CAPTION, 0)).toBe("bottom-left");
  });

  it("keeps the dot's room on the right", () => {
    // The left is filled, then the line is flat at y 16: the top right has 4px without the dot. With it, no corner is
    // clear, and the bottom right has the most room (1.75px).
    const xy = [{ x: 2, y: 7 }, { x: 60, y: 27 }, { x: 120, y: 7 }, { x: 180, y: 16 }, { x: 340, y: 16 }];
    expect(captionCorner(xy, W, H, CAPTION, 0)).toBe("top-right");
    expect(captionCorner(xy, W, H, CAPTION, DOT)).toBe("bottom-right");
  });

  it("takes the corner with the most room when none is clear", () => {
    // A flat line at y 11 in a 24px box: a top corner has −1px, a bottom one 1px.
    expect(captionCorner([{ x: 2, y: 11 }, { x: 340, y: 11 }], W, 24, CAPTION, 0)).toBe("bottom-left");
  });
});
