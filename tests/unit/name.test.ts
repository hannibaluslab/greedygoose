import { describe, expect, it } from "vitest";
import { firstName } from "@/lib/jaw/name";

describe("firstName", () => {
  it("greets by the name's first label", () => {
    expect(firstName("sam.justan.id")).toBe("Sam");
    expect(firstName("extenso.justan.id")).toBe("Extenso");
  });
});

describe("fullName (add a contact by name)", () => {
  it("adds the app's name parent to a bare name, and takes a dotted one as typed", async () => {
    const { fullName } = await import("@/lib/jaw/name");
    expect(fullName("Sam")).toBe("sam.justan.id");
    expect(fullName("  @kit ")).toBe("kit.justan.id");
    expect(fullName("vitalik.eth")).toBe("vitalik.eth");
    expect(fullName("")).toBeNull();
    expect(fullName("a b")).toBeNull();
  });
});
