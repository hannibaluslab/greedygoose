import { describe, expect, it } from "vitest";
import { runSteps, type AgentStep } from "@/hooks/useAgentRun";

describe("an agent change, one JAW screen a step", () => {
  const offAll: AgentStep[] = [{ off: "save" }, { off: "protect" }, { off: "sell" }];

  it("runs every step in order", async () => {
    const seen: AgentStep[] = [];
    const r = await runSteps(offAll, async (s) => void seen.push(s));
    expect(seen).toEqual(offAll);
    expect(r).toEqual({ done: 3, rest: [] });
  });

  it("stops at the first that doesn't go through, and keeps it and the rest for a retry", async () => {
    const r = await runSteps(offAll, async (s) => {
      if ("off" in s && s.off === "protect") throw new Error("User rejected");
    });
    // Save is off now, so the screen's rebuilt list starts at Protect: the retry must run Protect and selling, not skip one.
    expect(r).toEqual({ done: 1, rest: [{ off: "protect" }, { off: "sell" }] });
  });

  it("keeps everything when the first is cancelled", async () => {
    const r = await runSteps(offAll, async () => {
      throw new Error("User rejected");
    });
    expect(r).toEqual({ done: 0, rest: offAll });
  });
});
