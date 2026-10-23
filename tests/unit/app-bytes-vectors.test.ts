import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appBytesVectors } from "@/scripts/app-bytes-vectors";

describe("contracts/test/vectors/app-bytes.json", () => {
  it("is the batch the app's grant builders return today (run npm run contracts:vectors after changing a grant)", async () => {
    const committed = JSON.parse(
      readFileSync(new URL("../../contracts/test/vectors/app-bytes.json", import.meta.url), "utf8"),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(await appBytesVectors())));
  });
});
