import { describe, expect, it } from "vitest";
import { firstName } from "@/lib/jaw/name";

describe("firstName", () => {
  it("greets by the name's first label", () => {
    expect(firstName("sam.justan.id")).toBe("Sam");
    expect(firstName("extenso.justan.id")).toBe("Extenso");
  });
});
