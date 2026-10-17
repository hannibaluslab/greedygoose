/**
 * Simulates Start earning's batch on Base mainnet (eth_simulateV1), from real accounts: an exact USDC approve to Aave
 * V3's pool and its supply for the account, of the wallet's USDC less the fee buffer (CASH.feeBufferUsd). Nothing is
 * signed or sent. A simulation from the account itself carries no paymaster, so no network fee is taken here: the
 * wallet must end on exactly the buffer, which in the app pays JAW's fee after the batch.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  numberToHex,
  pad,
  type Log,
  type StateOverride,
} from "viem";
import { CASH } from "@/config/risk";
import { explainRevert } from "@/lib/aave/errors";
import { decodeActivity } from "@/lib/activity/decode";
import { feeBufferRaw } from "@/lib/cash";
import { startEarningShown } from "@/lib/cashSetup";
import { CHAIN } from "@/lib/chain";
import { PROTOCOLS } from "@/lib/protocols/config";
import { buildStartEarningCalls, startEarningMinRaw, startEarningPlan, startEarningRaw } from "@/lib/startEarning";
import { checkPlan } from "@/lib/tx/prepared";
import { USDC } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const client = createPublicClient({
  chain: CHAIN,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
  batch: { multicall: true },
});
/** The dev preview's account: idle USDC in the wallet beside savings that already earn. */
const preview: Address = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427";
/** oulina: about $1.36 of idle cash, nothing in savings. */
const oulina: Address = "0xFf13Dc32AcA90b3D61058ea26Df1D895F842eE1F";

const balanceRead = (token: Address, user: Address) => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [user] }),
});
const uint = (x: { data: Address }) => decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: x.data });
const balance = (token: Address, user: Address) =>
  client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [user] });

/** FiatTokenV2_2 keeps balances in the mapping at slot 9 (checked in flows.test.ts): this sets the wallet's USDC. */
const walletOf = (user: Address, raw: bigint): StateOverride => [
  {
    address: USDC.address,
    stateDiff: [
      {
        slot: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [user, 9n])),
        value: pad(numberToHex(raw), { size: 32 }),
      },
    ],
  },
];

/** The batch between two reads of savings (aUSDC) and the wallet in the same block, so interest can't blur the deltas. */
async function simulateStart(user: Address, calls: { to: Address; data: Address }[], stateOverrides?: StateOverride) {
  const reads = [balanceRead(PROTOCOLS.AUSDC, user), balanceRead(USDC.address, user)];
  const r = await client.simulateCalls({ account: user, calls: [...reads, ...calls, ...reads], stateOverrides });
  const before = r.results.slice(0, reads.length);
  const batch = r.results.slice(reads.length, reads.length + calls.length);
  const after = r.results.slice(reads.length + calls.length);
  return {
    statuses: batch.map((x) => x.status),
    logs: batch.flatMap((x) => x.logs ?? []) as unknown as Log[],
    walletBefore: uint(before[1]),
    savingsAdded: uint(after[0]) - uint(before[0]),
    walletAfter: uint(after[1]),
  };
}

/** aUSDC rounds by a unit or two per savings call (Aave V3's ray maths on the scaled balance): 3 units, $0.000003. */
const closeTo = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= 3n;

describe("Start earning simulates on mainnet: the wallet's cash goes into savings, the buffer stays", () => {
  it("the preview account: its idle wallet USDC into savings, the wallet keeps the fee buffer", async () => {
    const walletRaw = await balance(USDC.address, preview);
    expect(startEarningShown("unconfigured", walletRaw)).toBe(true);
    const amount = startEarningRaw(walletRaw)!;
    const calls = buildStartEarningCalls({ user: preview, walletRaw });
    const r = await simulateStart(preview, calls);
    console.log(
      `preview: wallet $${Number(walletRaw) / 1e6} → savings +${r.savingsAdded} (asked ${amount}), wallet after ${r.walletAfter}`,
    );
    expect(r.walletBefore).toBe(walletRaw);
    expect(r.statuses).toEqual(["success", "success"]);
    expect(closeTo(r.savingsAdded, amount)).toBe(true);
    expect(r.walletAfter).toBe(feeBufferRaw);
    // Activity reads the batch's own logs as one move into savings: nothing sent.
    expect(decodeActivity(r.logs, preview)).toEqual([{ kind: "save", symbol: "USDC", amount: Number(amount) / 1e6 }]);
  });

  it("at the smallest wallet that qualifies, $1 goes in and the buffer stays", async () => {
    const r = await simulateStart(
      preview,
      buildStartEarningCalls({ user: preview, walletRaw: startEarningMinRaw }),
      walletOf(preview, startEarningMinRaw),
    );
    expect(r.walletBefore).toBe(startEarningMinRaw);
    expect(r.statuses).toEqual(["success", "success"]);
    expect(closeTo(r.savingsAdded, 1_000_000n)).toBe(true);
    expect(r.walletAfter).toBe(feeBufferRaw);
  });

  it("goes through the app's own check (the prepared path): allowlist, then eth_simulateV1 from the account", async () => {
    const walletRaw = await balance(USDC.address, preview);
    const plan = startEarningPlan(preview, walletRaw)!;
    const checked = await checkPlan(plan, {
      join: async (_user, batch) => batch,
      simulate: async (user, batch) =>
        (await client.simulateCalls({ account: user, calls: batch.map(({ to, data }) => ({ to, data })) })).results,
      explain: explainRevert,
    });
    expect(checked.ok).toBe(true);
    // One unit more than the wallet holds reverts: the batch can't take what isn't there.
    const over = await simulateStart(
      preview,
      buildStartEarningCalls({ user: preview, walletRaw: walletRaw + feeBufferRaw + 1n }),
    );
    expect(over.statuses).toContain("failure");
  });

  it(`oulina: her idle cash qualifies only at $1 plus the buffer ($${(1 + CASH.feeBufferUsd).toFixed(2)} today)`, async () => {
    const walletRaw = await balance(USDC.address, oulina);
    const qualifies = walletRaw >= startEarningMinRaw;
    console.log(
      `oulina: wallet $${Number(walletRaw) / 1e6}; buffer $${CASH.feeBufferUsd}; Start earning ${qualifies ? "shows" : "doesn't show"}`,
    );
    expect(startEarningShown("unconfigured", walletRaw)).toBe(qualifies);
    if (!qualifies) return;
    const r = await simulateStart(oulina, buildStartEarningCalls({ user: oulina, walletRaw }));
    expect(r.statuses).toEqual(["success", "success"]);
    expect(closeTo(r.savingsAdded, walletRaw - feeBufferRaw)).toBe(true);
    expect(r.walletAfter).toBe(feeBufferRaw);
  });
});
