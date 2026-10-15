/**
 * Simulates Send's batch on Base mainnet (eth_simulateV1), from a real account, as useTx simulates it before JAW's
 * sheet. Nothing is signed or sent. The batch is built by the app's own builder (buildSendCalls) from the cash read the
 * way useSigningCash reads it, and the account is read around it in the same simulated block.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, erc20Abi, http, parseUnits, type Log } from "viem";
import { CHAIN } from "@/lib/chain";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import type { Call } from "@/lib/aave/tx";
import { decodeActivity } from "@/lib/activity/decode";
import { assertAllowed } from "@/lib/allowlist";
import { cashRaw, readCash } from "@/lib/cash";
import { GUARDIAN } from "@/lib/guardian/config";
import { SendStop, buildSendCalls, readRecipient } from "@/lib/send";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const client = createPublicClient({ chain: CHAIN, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL), batch: { multicall: true } });
/** The dev preview's account: cash (mostly in savings), five stocks backing credit, a little free Amazon. */
const backer: Address = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427";
/** Someone else: an address with no history, so the B20 policy treats it as any fresh account. */
const friend: Address = "0x7d3A9C0E5B1f4a2D8c6e0B9A7f3D5c1E2b4a6C8E";
const amzn = EQUITIES.find((e) => e.symbol === "AMZNc")!;

const plain = (calls: { to: Address; data: Address }[]) => calls.map(({ to, data }) => ({ to, data }));
const read = (to: Address, data: Address) => ({ to, data });
const balanceRead = (token: Address, who: Address) => read(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [who] }));
const suppliedRead = (stock: ReserveAsset, who: Address) =>
  read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(stock.reserveId), who] }));
const debtRead = (who: Address) => read(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), who] }));
const uint = (x: { data: Address }) => decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: x.data });

/** Simulates the batch between two sets of reads: the token for the user and the friend, the user's cash, backing and debt. */
async function simulate(user: Address, token: ReserveAsset, calls: Call[], backing: ReserveAsset = amzn) {
  const reads = [
    balanceRead(token.address, user),
    balanceRead(token.address, friend),
    balanceRead(USDC.address, user),
    balanceRead(GUARDIAN.AUSDC, user),
    suppliedRead(backing, user),
    debtRead(user),
  ];
  const r = await client.simulateCalls({ account: user, calls: [...reads, ...plain(calls), ...reads] });
  const batch = r.results.slice(reads.length, reads.length + calls.length);
  const [a, b] = [r.results.slice(0, reads.length), r.results.slice(-reads.length)];
  const ok = batch.every((x) => x.status === "success");
  const delta = (i: number) => (ok ? uint(b[i]) - uint(a[i]) : 0n);
  return {
    statuses: batch.map((x) => x.status),
    logs: batch.flatMap((x) => (x.logs ?? []) as unknown as Log[]),
    userDelta: delta(0),
    friendDelta: delta(1),
    walletDelta: delta(2),
    savingsDelta: delta(3),
    backingDelta: delta(4),
    debtDelta: delta(5),
  };
}

describe("Send on Base (the Send tab)", () => {
  it("the friend is a fresh address Base has never seen used, so the screen would warn", async () => {
    expect(await readRecipient(client, friend)).toEqual({ code: false, used: false });
    expect((await readRecipient(client, backer)).used).toBe(true);
  }, 60_000);

  it("cash, the one pot: $100 when the wallet holds less, so savings pay the rest first, and the friend gets exactly $100", async () => {
    const cash = await readCash(client, backer);
    const amount = parseUnits("100", 6);
    expect(cash.walletRaw).toBeLessThan(amount);
    expect(cashRaw(cash)).toBeGreaterThan(amount + parseUnits("1", 6));
    const calls = buildSendCalls({ user: backer, token: USDC, to: friend, amountRaw: amount, cash });
    expect(calls).toHaveLength(2);
    expect(calls[0].to).toBe(GUARDIAN.AAVE_V3_POOL);
    expect(calls[1].to).toBe(USDC.address);
    const r = await simulate(backer, USDC, calls);
    console.log(`cash send: wallet ${r.walletDelta}, savings ${r.savingsDelta}, friend +${r.friendDelta}`);
    expect(r.statuses).toEqual(["success", "success"]);
    expect(r.friendDelta).toBe(amount);
    // The cash went down by the send, give or take savings' rounding (a unit or two).
    const spent = -(r.walletDelta + r.savingsDelta);
    expect(spent - amount).toBeLessThanOrEqual(2n);
    expect(spent - amount).toBeGreaterThanOrEqual(-2n);
    // Nothing touched credit.
    expect(r.backingDelta).toBe(0n);
    expect(r.debtDelta).toBeGreaterThanOrEqual(0n);
    expect(r.debtDelta).toBeLessThan(parseUnits("0.01", 6));
    expect(decodeActivity(r.logs, backer)).toEqual([{ kind: "send", symbol: "USDC", amount: 100, to: friend }]);
  }, 60_000);

  it("a stock: every free Amazon share goes, what backs credit and what's owed don't move", async () => {
    const freeRaw = await client.readContract({ address: amzn.address, abi: erc20Abi, functionName: "balanceOf", args: [backer] });
    const backing = await client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(amzn.reserveId), backer] });
    expect(freeRaw).toBeGreaterThan(0n);
    expect(backing).toBeGreaterThan(0n);
    const cash = await readCash(client, backer);
    const calls = buildSendCalls({ user: backer, token: amzn, to: friend, amountRaw: freeRaw, cash });
    expect(calls.at(-1)!.to).toBe(amzn.address);
    const r = await simulate(backer, amzn, calls);
    console.log(`stock send: ${freeRaw} raw AMZN free, ${backing} backing; friend +${r.friendDelta}`);
    expect(r.statuses.every((s) => s === "success")).toBe(true);
    expect(r.userDelta).toBe(-freeRaw);
    expect(r.friendDelta).toBe(freeRaw);
    expect(r.backingDelta).toBe(0n);
    expect(r.debtDelta).toBeLessThan(parseUnits("0.01", 6));
    expect(decodeActivity(r.logs, backer)).toEqual([{ kind: "send", symbol: "AMZNc", amount: Number(freeRaw) / 1e8, to: friend }]);
  }, 60_000);

  it("shares that back credit can't be sent: one unit over the free shares reverts on Base", async () => {
    const freeRaw = await client.readContract({ address: amzn.address, abi: erc20Abi, functionName: "balanceOf", args: [backer] });
    const cash = await readCash(client, backer);
    const calls = buildSendCalls({ user: backer, token: amzn, to: friend, amountRaw: freeRaw + 1n, cash });
    const r = await client.simulateCalls({ account: backer, calls: plain(calls) });
    expect(r.results.at(-1)!.status).toBe("failure");
  }, 60_000);

  it("the builder and the allowlist refuse the account itself and the app's contracts before Base is asked", async () => {
    const cash = await readCash(client, backer);
    for (const to of [backer, AAVE.SPOKE, USDC.address, GUARDIAN.AAVE_V3_POOL]) {
      expect(() => buildSendCalls({ user: backer, token: USDC, to: to as Address, amountRaw: 1n, cash })).toThrow(SendStop);
    }
    const raw = { to: USDC.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [AAVE.SPOKE, 1n] }), value: 0n };
    expect(() => assertAllowed(backer, [raw], { sendTo: AAVE.SPOKE })).toThrow(/unexpected recipient/);
  }, 60_000);
});
