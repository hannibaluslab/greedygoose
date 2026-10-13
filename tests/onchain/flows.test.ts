/**
 * Simulates the app's real write batches on Base mainnet (eth_simulateV1), from a real
 * Equities Hub borrower. Nothing is signed or sent.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, erc20Abi, http } from "viem";
import { CHAIN } from "@/lib/chain";
import { buildBorrowCalls, buildLoanCalls, buildRepayCalls, buildSupplyCalls, buildWithdrawCalls } from "@/lib/aave/tx";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { AAVE } from "@/lib/aave/addresses";
import { explainRevert } from "@/lib/aave/errors";
import { EQUITIES } from "@/lib/tokens/registry";

const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) });
const user = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427"; // real borrower with stock collateral (found via spoke Borrow logs)

const simulate = (calls: { to: `0x${string}`; data: `0x${string}` }[]) =>
  client.simulateCalls({ account: user, calls: calls.map(({ to, data }) => ({ to, data })) });

describe("write batches simulate on mainnet", () => {
  it("borrow $1 then repay $1", async () => {
    const r = await simulate([
      ...buildBorrowCalls({ user, amountRaw: 1_000_000n }),
      ...buildRepayCalls({ user, amountRaw: 1_000_000n, all: false }),
    ]);
    expect(r.results.map((x) => x.status)).toEqual(["success", "success", "success"]);
  });

  it("supply a free stock balance as collateral", async () => {
    let done = false;
    for (const stock of EQUITIES) {
      const bal = await client.readContract({ address: stock.address, abi: erc20Abi, functionName: "balanceOf", args: [user] });
      if (bal === 0n) continue;
      const r = await simulate(buildSupplyCalls({ user, stock, amountRaw: bal }));
      expect(r.results.map((x) => x.status)).toEqual(["success", "success", "success"]);
      done = true;
      break;
    }
    expect(done).toBe(true);
  });

  it("borrowing far past the limit is rejected by Aave", async () => {
    const r = await simulate(buildBorrowCalls({ user, amountRaw: 10n ** 12n })); // $1M
    expect(r.results[0].status).toBe("failure");
    const msg = explainRevert(r.results[0].data, "fallback");
    console.log("over-limit borrow →", msg);
    expect(msg).not.toBe("fallback");
  });

  it("unlock a small slice of collateral, and refuse unlocking everything while in debt", async () => {
    const stock = EQUITIES.find((e) => e.symbol === "AMZNc")!;
    const supplied = await client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(stock.reserveId), user] });
    expect(supplied).toBeGreaterThan(0n);
    const small = await simulate(buildWithdrawCalls({ user, stock, amountRaw: supplied / 100n, all: false }));
    expect(small.results[0].status).toBe("success");
    // Withdrawing every stock at once would leave the debt uncovered.
    const everything = await simulate(
      EQUITIES.flatMap((e) => buildWithdrawCalls({ user, stock: e, amountRaw: 0n, all: true })),
    );
    expect(everything.results.some((r) => r.status === "failure")).toBe(true);
  });

  it("get a loan: lock a free balance + borrow $1 in one batch", async () => {
    for (const stock of EQUITIES) {
      const bal = await client.readContract({ address: stock.address, abi: erc20Abi, functionName: "balanceOf", args: [user] });
      if (bal === 0n) continue;
      const r = await simulate(buildLoanCalls({ user, locks: [{ stock, raw: bal }], borrowRaw: 1_000_000n }));
      expect(r.results.map((x) => x.status)).toEqual(["success", "success", "success", "success"]);
      return;
    }
    throw new Error("no free stock to test with");
  });

  it("get a loan with several stocks at once", async () => {
    const locks = [];
    for (const stock of EQUITIES) {
      const bal = await client.readContract({ address: stock.address, abi: erc20Abi, functionName: "balanceOf", args: [user] });
      if (bal > 0n) locks.push({ stock, raw: bal });
      if (locks.length === 2) break;
    }
    expect(locks.length).toBeGreaterThanOrEqual(2);
    const r = await simulate(buildLoanCalls({ user, locks, borrowRaw: 1_000_000n }));
    expect(r.results.every((x) => x.status === "success")).toBe(true);
    expect(r.results).toHaveLength(locks.length * 3 + 1);
  });
});
