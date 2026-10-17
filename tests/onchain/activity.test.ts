/** Decodes real Equities Hub transactions from Base mainnet. */
import { describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { CHAIN } from "@/lib/chain";
import { decodeActivity } from "@/lib/activity/decode";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });

describe("decodeActivity", () => {
  it("decodes a real USDC repay for its user only", async () => {
    const r = await client.getTransactionReceipt({
      hash: "0x54ec1ce8fbb87295e8b7e8b79b8891d30b447dda2c16623320dad312f9e4e2e0",
    });
    const items = decodeActivity(r.logs, "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427");
    expect(items.some((i) => i.kind === "repay" && i.symbol === "USDC" && i.amount > 0)).toBe(true);
    expect(decodeActivity(r.logs, "0x000000000000000000000000000000000000dEaD")).toEqual([]);
  });
  it("decodes a real USDC supply (topic 0xd986db22 = Supply)", async () => {
    const r = await client.getTransactionReceipt({
      hash: "0xe350e2ae90b5084ab22b7d5162913c75e6b05b3d7cef55a8bde3be75a574d106",
    });
    const items = decodeActivity(r.logs, "0x57a71b108c63d5fda0b09e0f764a84e4acc3a79d");
    expect(items.some((i) => i.kind === "supply" && i.symbol === "USDC" && i.amount > 37)).toBe(true);
  });
});

/**
 * JAW's network fee (D4) on our test JAW account's own receipts: the paymaster takes USDC from the account inside the
 * transaction, to its treasury. That is no move of the user's, so it is no "Sent" (measured 2026-10-15).
 */
describe("decodeActivity: JAW's network fee", () => {
  const jawAccount = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;

  it("credit taken with backing reads as the backing and the credit, without the fee", async () => {
    const r = await client.getTransactionReceipt({
      hash: "0xfb269d3378792239bb7eee82d986d2ece77b442910aefae6506ef999738a6b91",
    });
    expect(decodeActivity(r.logs, jawAccount)).toEqual([
      { kind: "supply", symbol: "NVDAc", amount: 0.00435899 },
      { kind: "borrow", symbol: "USDC", amount: 0.45 },
    ]);
  });

  it("freeing up a stock reads as that alone", async () => {
    const r = await client.getTransactionReceipt({
      hash: "0x21377f51cfd17aee039c28a94646ba1ba6f13ace7e37e269274652c480657e1c",
    });
    expect(decodeActivity(r.logs, jawAccount)).toEqual([{ kind: "withdraw", symbol: "NVDAc", amount: 0.00435899 }]);
  });
});
