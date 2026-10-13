/** Decodes real Equities Hub transactions from Base mainnet. */
import { describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { CHAIN } from "@/lib/chain";
import { decodeActivity } from "@/lib/activity/decode";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });

describe("decodeActivity", () => {
  it("decodes a real USDC repay for its user only", async () => {
    const r = await client.getTransactionReceipt({ hash: "0x54ec1ce8fbb87295e8b7e8b79b8891d30b447dda2c16623320dad312f9e4e2e0" });
    const items = decodeActivity(r.logs, "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427");
    expect(items.some((i) => i.kind === "repay" && i.symbol === "USDC" && i.amount > 0)).toBe(true);
    expect(decodeActivity(r.logs, "0x000000000000000000000000000000000000dEaD")).toEqual([]);
  });
  it("decodes a real USDC supply (topic 0xd986db22 = Supply)", async () => {
    const r = await client.getTransactionReceipt({ hash: "0xe350e2ae90b5084ab22b7d5162913c75e6b05b3d7cef55a8bde3be75a574d106" });
    const items = decodeActivity(r.logs, "0x57a71b108c63d5fda0b09e0f764a84e4acc3a79d");
    expect(items.some((i) => i.kind === "supply" && i.symbol === "USDC" && i.amount > 37)).toBe(true);
  });
});
