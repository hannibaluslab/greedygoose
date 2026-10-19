import { describe, expect, it } from "vitest";
import { runError, runSteps, type AgentStep } from "@/hooks/useAgentRun";
import { JOBS, type AgentJob } from "@/lib/agents/permissions";
import { OFF_UNREADABLE, jobStatus, offSteps, type AgentStatus } from "@/lib/agents/status";

describe("an agent change, one JAW screen a step", () => {
  const offAll: AgentStep[] = [{ off: "save" }, { off: "protect" }, { off: "sell" }];

  it("runs every step in order", async () => {
    const seen: AgentStep[] = [];
    const r = await runSteps(offAll, async (s) => void seen.push(s));
    expect(seen).toEqual(offAll);
    expect(r).toEqual({ done: 3, rest: [], error: null });
  });

  it("stops at the first that doesn't go through, and keeps it and the rest for a retry", async () => {
    const r = await runSteps(offAll, async (s) => {
      if ("off" in s && s.off === "protect") throw new Error("User rejected");
    });
    // Save is off now, so the screen's rebuilt list starts at Protect: the retry must run Protect and selling, not skip one.
    expect(r).toMatchObject({ done: 1, rest: [{ off: "protect" }, { off: "sell" }] });
    expect(r.error).toBeInstanceOf(Error);
  });

  it("keeps everything when the first is cancelled", async () => {
    const r = await runSteps(offAll, async () => {
      throw new Error("User rejected");
    });
    expect(r).toMatchObject({ done: 0, rest: offAll });
  });
});

describe("runError: what a change that stopped says, under its button or as a toast", () => {
  it("says nothing changed when the first JAW sheet didn't go through, and whether it was cancelled", () => {
    expect(runError(0, 2, new Error("User rejected the request"))).toBe("You cancelled. Nothing changed.");
    expect(runError(0, 1, new Error("RPC down"))).toBe("We couldn’t do that right now. Nothing changed. Try again.");
  });

  it("counts what went through before it stopped", () => {
    expect(runError(1, 3, new Error("denied"))).toBe(
      "1 of 3 went through, then you cancelled. Try again for the rest.",
    );
    expect(runError(2, 3, "boom")).toBe("2 of 3 went through, then the next one didn’t. Try again for the rest.");
  });
});

describe("turning a job off while the list of what's switched on can't be read", () => {
  const status = (s: Partial<Record<AgentJob, AgentStatus>>) => (job: AgentJob) => s[job] ?? "off";
  const none = () => 0;

  it("says so in plain words instead of doing nothing, for a job that is on or starting", () => {
    for (const on of ["on", "starting"] as const) {
      expect(offSteps(["protect", "sell"], status({ protect: on }), none, true)).toEqual({
        steps: [],
        error: OFF_UNREADABLE,
        on: true,
      });
    }
    expect(OFF_UNREADABLE).not.toMatch(/borrow|loan|lock|collateral|aave|chainlink|jaw|executor|permission/i);
  });

  it("keeps the job's state honest: the registry still says it runs, so it still shows on", () => {
    const stored = { start: 1, end: 2_000, cap: 5n };
    expect(jobStatus("protect", 1 << JOBS.indexOf("protect"), stored, [], 1_000, true)).toBe("on");
  });

  it("revokes what the list shows when it can be read, and has nothing to do for a job already off", () => {
    const faceIds = (job: AgentJob) => (job === "protect" ? 1 : 0);
    expect(offSteps(["protect", "sell"], status({ protect: "on" }), faceIds, false)).toEqual({
      steps: [{ off: "protect" }],
      error: null,
      on: true,
    });
    expect(offSteps(["protect", "sell"], status({}), none, true)).toEqual({ steps: [], error: null, on: false });
  });

  it("a revoke that finds the list unreadable stops with those words, after any that went through", () => {
    expect(runError(0, 1, new Error(OFF_UNREADABLE))).toBe(OFF_UNREADABLE);
    expect(runError(1, 2, new Error(OFF_UNREADABLE))).toBe(`1 of 2 went through. ${OFF_UNREADABLE}`);
  });
});
