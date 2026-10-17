import { describe, expect, it } from "vitest";
import { runError, runSteps, type AgentStep } from "@/hooks/useAgentRun";

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
    expect(runError(0, 2, new Error("User rejected the request"))).toBe(
      "You cancelled on JAW’s screen. Nothing changed.",
    );
    expect(runError(0, 1, new Error("RPC down"))).toBe("We couldn’t do that right now. Nothing changed. Try again.");
  });

  it("counts what went through before it stopped", () => {
    expect(runError(1, 3, new Error("denied"))).toBe(
      "1 of 3 went through, then you cancelled on JAW’s screen. Try again for the rest.",
    );
    expect(runError(2, 3, "boom")).toBe("2 of 3 went through, then the next one didn’t. Try again for the rest.");
  });
});
