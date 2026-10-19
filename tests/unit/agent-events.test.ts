import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  pad,
  type AbiEvent,
  type AbiParameter,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { decodeAgentLogs } from "@/lib/agents/events";
import { logChunks } from "@/lib/agents/history";

const executor: Address = "0x00000000000000000000000000000000000E5EC0";
const account: Address = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA";
const someone: Address = "0x9dF0C6b0066D5317aA5b38B36850548DaCCa6B4e";
const USDT: Address = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";

const EVENTS = gooseExecutorAbi.filter(
  (x): x is Extract<(typeof gooseExecutorAbi)[number], { type: "event" }> => x.type === "event",
);

/** A log as getLogs returns it: `args` by name, the indexed ones in topics. */
function log(name: string, args: Record<string, unknown>, at: { address?: Address; logIndex?: number } = {}): Log {
  const event = EVENTS.find((e) => e.name === name) as AbiEvent;
  const data = event.inputs.filter((i) => !i.indexed);
  return {
    address: at.address ?? executor,
    topics: encodeEventTopics({ abi: [event], eventName: name, args } as never) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      data,
      data.map((i) => args[i.name!]),
    ),
    blockNumber: 100n,
    logIndex: at.logIndex ?? 0,
    transactionHash: pad("0x01"),
    transactionIndex: 0,
    blockHash: pad("0x02"),
    removed: false,
  };
}

/** A value of any type the executor's events use. */
function sample(p: AbiParameter): unknown {
  if (p.name === "account") return account;
  const fixed = p.type.match(/^(.*)\[(\d+)\]$/);
  if (fixed) return Array.from({ length: Number(fixed[2]) }, () => sample({ ...p, type: fixed[1] }));
  if (p.type === "address") return someone;
  if (p.type === "bool") return true;
  if (p.type === "bytes") return "0x";
  if (p.type.startsWith("bytes")) return pad("0x12", { size: Number(p.type.slice(5)) });
  if (p.type === "uint8") return 1;
  if (p.type.startsWith("uint")) return 1n;
  throw new Error(`no sample for ${p.type}`);
}

const one = (l: Log) => decodeAgentLogs([l], executor, account);

describe("decodeAgentLogs: every GooseExecutor event", () => {
  /** The events about one account: everything else is about the executor itself. */
  const ABOUT_AN_ACCOUNT = [
    "JobOn",
    "JobOff",
    "Saved",
    "ProtectRepaid",
    "ProtectSold",
    "SaleSkipped",
    "KeepMixSet",
    "MixSet",
    "Rebalanced",
    "RebalanceSkipped",
    "EntryConverted",
    "EntryWaiting",
    "RunFailed",
    "RunDeferred",
  ];

  it.each(EVENTS.map((e) => e.name))("%s decodes, or is known to belong to no account", (name) => {
    const event = EVENTS.find((e) => e.name === name)!;
    const args = Object.fromEntries(event.inputs.map((i) => [i.name, sample(i)]));
    expect(one(log(name, args)).length).toBe(ABOUT_AN_ACCOUNT.includes(name) ? 1 : 0);
  });

  it("covers the ABI: every event indexed by an account is one of them", () => {
    const byAccount = EVENTS.filter((e) => e.inputs.some((i) => i.name === "account" && i.indexed)).map((e) => e.name);
    expect(byAccount.sort()).toEqual([...ABOUT_AN_ACCOUNT].sort());
  });
});

describe("decodeAgentLogs: what each event carries", () => {
  it("names the job and why it went off, in GooseExecutor's order", () => {
    expect(
      one(log("JobOn", { account, job: 3, permissionHash: pad("0xab"), cap: 500_000_000n, end: 1_800_000_000 }))[0],
    ).toMatchObject({
      kind: "job-on",
      job: "rebalance",
      capRaw: 500_000_000n,
      end: 1_800_000_000,
    });
    expect(one(log("JobOff", { account, job: 2, reason: 3 }))[0]).toMatchObject({
      kind: "job-off",
      job: "sell",
      reason: "stuck",
    });
    expect(one(log("JobOff", { account, job: 4, reason: 0 }))[0]).toMatchObject({ job: "entry", reason: "revoked" });
  });

  it("reads Protect's repay from savings, below its line or on through a rescue (ProtectCase Act)", () => {
    const act = {
      account,
      amount: 120_000_000n,
      hfBefore: 1_020_000_000_000_000_000n,
      hfAfter: 1_120_000_000_000_000_000n,
      reason: 5,
    };
    expect(one(log("ProtectRepaid", act))[0]).toEqual(
      expect.objectContaining({
        kind: "repaid",
        amountRaw: 120_000_000n,
        hfBefore: 1_020_000_000_000_000_000n,
        hfAfter: 1_120_000_000_000_000_000n,
      }),
    );
    expect(one(log("ProtectRepaid", act))[0]).not.toHaveProperty("reason");
  });

  it("reads the sale by reserve id, at once with no heads-up before it", () => {
    const shares = [0n, 0n, 0n, 0n, 0n, 0n, 47_000_000n];
    const sold = one(log("ProtectSold", { account, shares, repaid: 178_200_000n, hfBefore: 1n, hfAfter: 2n }))[0];
    expect(sold).toMatchObject({ kind: "sold", sharesRaw: shares, repaidRaw: 178_200_000n, hfBefore: 1n, hfAfter: 2n });
    expect(sold).not.toHaveProperty("atOnce");
  });

  it("reads the Rebalancer's mix and trades, and Entry's coins", () => {
    expect(one(log("MixSet", { account, weights: [2500, 0, 0, 0, 0, 5000, 2500] }))[0]).toMatchObject({
      kind: "mix",
      weightsBps: [2500, 0, 0, 0, 0, 5000, 2500],
    });
    const sold = [27_000_000n, 0n, 0n, 0n, 0n, 0n, 0n];
    const bought = [0n, 0n, 0n, 0n, 0n, 28_000_000n, 0n];
    expect(one(log("Rebalanced", { account, sold, bought }))[0]).toMatchObject({
      kind: "rebalanced",
      soldRaw: sold,
      boughtRaw: bought,
    });
    expect(
      one(log("EntryConverted", { account, coin: USDT, amountIn: 1_000_000_000n, usdcOut: 998_630_000n }))[0],
    ).toMatchObject({
      kind: "converted",
      coin: USDT,
      usdcOutRaw: 998_630_000n,
    });
    expect(one(log("EntryWaiting", { account, coin: USDT, amountIn: 5n, retryAt: 1_760_003_600 }))[0]).toMatchObject({
      retryAt: 1_760_003_600,
    });
  });

  it("keys each event by its transaction and place, and keeps the chain's order", () => {
    const logs = [
      log("Saved", { account, amount: 1n }, { logIndex: 4 }),
      log("RunFailed", { account, reason: "0xdeadbeef", fails: 2 }, { logIndex: 7 }),
    ];
    const out = decodeAgentLogs(logs, executor, account);
    expect(out.map((e) => [e.kind, e.key, e.blockNumber])).toEqual([
      ["saved", `${pad("0x01")}:4`, 100n],
      ["run-failed", `${pad("0x01")}:7`, 100n],
    ]);
    expect(out[1]).toMatchObject({ reason: "0xdeadbeef", fails: 2 });
  });

  it("ignores another account's events, and the same event from any other contract", () => {
    expect(one(log("Saved", { account: someone, amount: 1n }))).toEqual([]);
    expect(one(log("Saved", { account, amount: 1n }, { address: someone }))).toEqual([]);
    expect(
      decodeAgentLogs([{ ...log("Saved", { account, amount: 1n }), topics: [pad("0x99")] }], executor, account),
    ).toEqual([]);
  });
});

describe("logChunks: the getLogs ranges, newest first", () => {
  it("cuts on chunk boundaries, so a finished chunk is the same request every time", () => {
    expect(logChunks(3n, 12n, 5n)).toEqual([
      { from: 10n, to: 12n },
      { from: 5n, to: 9n },
      { from: 3n, to: 4n },
    ]);
    expect(logChunks(10_000n, 19_999n)).toEqual([
      { from: 15_000n, to: 19_999n },
      { from: 10_000n, to: 14_999n },
    ]);
  });

  it("reads one block, and nothing when the range is empty", () => {
    expect(logChunks(7n, 7n, 5n)).toEqual([{ from: 7n, to: 7n }]);
    expect(logChunks(8n, 7n, 5n)).toEqual([]);
  });
});
