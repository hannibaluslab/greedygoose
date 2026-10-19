import { describe, expect, it } from "vitest";
import { startEarningFlow } from "@/lib/startEarning";

describe("Start earning's tap, stage by stage (startEarningFlow)", () => {
  it("before a tap: the batch's own phase, nothing held", () => {
    expect(startEarningFlow({ stage: null, phase: "idle", busy: false, grantFollows: null })).toEqual({
      deposited: false,
      granting: false,
      landed: false,
      pinned: false,
      phase: "idle",
    });
  });

  it("the batch on JAW's sheet: held as signed for", () => {
    const f = startEarningFlow({ stage: "deposit", phase: "signing", busy: true, grantFollows: true });
    expect(f).toMatchObject({ deposited: false, pinned: true, phase: "signing" });
  });

  it("landed with the grant to follow: granting, still signing", () => {
    const f = startEarningFlow({ stage: "deposit", phase: "done", busy: false, grantFollows: true });
    expect(f).toMatchObject({ deposited: true, granting: true, landed: false, pinned: true, phase: "signing" });
  });

  it("landed with no grant: all through, the batch's own done; idle once the stage says landed", () => {
    const f = startEarningFlow({ stage: "deposit", phase: "done", busy: false, grantFollows: false });
    expect(f).toMatchObject({ deposited: true, granting: false, landed: true, pinned: false, phase: "done" });
    expect(startEarningFlow({ stage: "landed", phase: "done", busy: false, grantFollows: true }).phase).toBe("idle");
  });

  it("the grant left to open: held, idle until the next tap", () => {
    const f = startEarningFlow({ stage: "grant-left", phase: "done", busy: false, grantFollows: true });
    expect(f).toMatchObject({ granting: false, pinned: true, phase: "idle" });
    expect(startEarningFlow({ stage: "grant", phase: "done", busy: false, grantFollows: true }).phase).toBe("signing");
  });
});
