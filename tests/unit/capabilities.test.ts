import { describe, expect, it } from "vitest";
import type { ChainCapabilities } from "@jaw.id/core";
import { atomicSend, atomicSupport } from "@/lib/jaw/capabilities";

const caps = (atomic?: unknown): ChainCapabilities => (atomic === undefined ? {} : { atomic });

describe("atomicSupport (EIP-5792 `atomic` as JAW reports it)", () => {
  it("reads supported and ready as supported", () => {
    expect(atomicSupport(caps({ status: "supported" }))).toBe("supported");
    expect(atomicSupport(caps({ status: "ready" }))).toBe("supported");
  });
  it("reads unsupported, and anything else as unknown", () => {
    expect(atomicSupport(caps({ status: "unsupported" }))).toBe("unsupported");
    expect(atomicSupport(caps())).toBe("unknown");
    expect(atomicSupport(caps({ supported: true }))).toBe("unknown");
    expect(atomicSupport(undefined)).toBe("unknown");
  });
});

describe("atomicSend (plan item 3: reported → checked, not reported → still sends)", () => {
  it("requires an all-or-nothing batch when JAW reports it", () => {
    expect(atomicSend(caps({ status: "supported" }), 4)).toEqual({ forceAtomic: true });
  });
  it("sends as before when JAW doesn't report it", () => {
    expect(atomicSend(caps(), 4)).toEqual({ forceAtomic: false });
    expect(atomicSend(undefined, 4)).toEqual({ forceAtomic: false });
  });
  it("stops a batch of several calls when JAW says it can't run them together", () => {
    expect(atomicSend(caps({ status: "unsupported" }), 2)).toBeNull();
    expect(atomicSend(caps({ status: "unsupported" }), 1)).toEqual({ forceAtomic: false });
  });
});
