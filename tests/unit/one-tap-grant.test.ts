import { describe, expect, it, vi } from "vitest";

/*
 * The one-tap grant (lib/agents/oneTapGrant.ts) next to JAW's own SDK, @jaw.id/core 1.6.3. The SDK's grant
 * (`grantPermissions`, exported by its rpc module) runs here for real, against a fake bundler and a fake relay: what
 * its user operation carries, the permission id it reads from the receipt and the request it sends the relay are
 * compared with ours, built for the same template, start and salt.
 *
 * No request leaves this machine: fetch answers only the fake bundler, XMLHttpRequest (what the SDK's axios uses here,
 * as in a browser) only records, and Node's http and https refuse. Set up before any import, so axios picks the fake
 * XMLHttpRequest when it loads.
 */
const net = vi.hoisted(() => {
  type Sent = { url: string; method: string; headers: Record<string, string>; body: string; credentials: string };
  const state = {
    rest: [] as Sent[],
    restReply: (_req: Sent): { status: number; body: unknown } => ({ status: 500, body: null }),
    rpcReply: (method: string, _params: unknown[]): unknown => {
      throw new Error(`no answer for ${method}`);
    },
  };
  const refuse = () => {
    throw new Error("No network in this test");
  };
  for (const id of ["node:http", "node:https"] as const)
    Object.assign(process.getBuiltinModule(id), { request: refuse, get: refuse });

  class FakeXhr {
    onloadend: (() => void) | null = null;
    status = 0;
    statusText = "";
    responseText = "";
    response = "";
    readyState = 0;
    withCredentials = false;
    timeout = 0;
    private req = { url: "", method: "", headers: {} as Record<string, string> };
    open(method: string, url: string) {
      this.req = { url, method, headers: {} };
    }
    setRequestHeader(key: string, value: string) {
      this.req.headers[key.toLowerCase()] = value;
    }
    getAllResponseHeaders() {
      return "content-type: application/json\r\n";
    }
    addEventListener() {}
    abort() {}
    send(body: string | null) {
      // An XMLHttpRequest without credentials sends cookies to its own origin only, as fetch's default does.
      const sent = { ...this.req, body: body ?? "", credentials: this.withCredentials ? "include" : "same-origin" };
      state.rest.push(sent);
      const reply = state.restReply(sent);
      this.status = reply.status;
      this.statusText = String(reply.status);
      this.responseText = this.response = JSON.stringify(reply.body);
      this.readyState = 4;
      setTimeout(() => this.onloadend?.(), 0);
    }
  }
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (!req.url.startsWith("https://bundler.invalid/")) throw new Error(`No network in this test: ${req.url}`);
    const answer = (q: { id: number; method: string; params: unknown[] }) => {
      try {
        return { jsonrpc: "2.0", id: q.id, result: state.rpcReply(q.method, q.params) };
      } catch (e) {
        return { jsonrpc: "2.0", id: q.id, error: { code: -32601, message: String(e) } };
      }
    };
    const body = JSON.parse(await req.text());
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  process.env.NEXT_PUBLIC_GOOSE_GUARD = "0x00000000000000000000000000000000000e5ec0";
  return state;
});

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  pad,
  type Address,
  type Hex,
} from "viem";
import { entryPoint08Abi, entryPoint08Address, type SmartAccount } from "viem/account-abstraction";
import {
  buildGrantPermissionCall,
  buildRevokePermissionCall,
  PERMISSIONS_MANAGER_ADDRESS,
  type Permission,
  type PermissionsDetail,
} from "@jaw.id/core";
// JAW's own grant and the calls its send prepares: exported by the SDK's modules, not by its package root.
import { grantPermissions } from "../../node_modules/@jaw.id/core/dist/rpc/permissions.js";
import { prepareCallsForExecution } from "../../node_modules/@jaw.id/core/dist/account/smartAccount.js";
import { abi as jawAccountAbi } from "../../node_modules/@jaw.id/core/dist/account/toJustanAccount.js";
import { jobGrant, JOBS, stockLimitsRaw } from "@/lib/agents/permissions";
import {
  addManagerOwnerCall,
  approveCall,
  contractPermission,
  grantPick,
  jawPermission,
  managerOwnerCalls,
  oneTapGrantCalls,
  permissionIdFromReceipt,
  relayRecord,
  RELAY_PERMISSIONS_URL,
  storePermissionInRelay,
} from "@/lib/agents/oneTapGrant";
import { encodePermission } from "@/lib/agents/register";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { permissionManagerAbi } from "@/lib/protocols/abis";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

const GUARD = "0x00000000000000000000000000000000000e5ec0" as const;
const USER = getAddress("0x14087c532332dE6E971Eb2F60a252cbf511F59eA");
const MANAGER = PERMISSIONS_MANAGER_ADDRESS as Address;
const API_KEY = "test-key-not-real";
const RPC = "https://bundler.invalid/rpc";
const PICK = { start: 1_792_454_400, salt: 0x00c0ffee_1234_5678_9abc_def0_0fed_cba9_8765_4321_0000_1111_2222_3333n };
const EXPIRY = PICK.start + 365 * 86_400;
const sellLimits = stockLimitsRaw(EQUITIES.map((e) => e.symbol === "NVDAc" || e.symbol === "TSLAc"));
const rebalanceLimits = stockLimitsRaw(EQUITIES.map((e) => e.symbol === "AAPLc"));

/** Every job's grant as the app asks for it, and one request that walks JAW's other branches. */
const TEMPLATES: Record<string, PermissionsDetail> = {
  save: jobGrant("save"),
  protect: jobGrant("protect"),
  sell: jobGrant("sell", sellLimits),
  rebalance: jobGrant("rebalance", rebalanceLimits),
  entry: jobGrant("entry"),
  "not ours: a signature, a year, the native token, × 3": {
    calls: [{ target: USDC.address, functionSignature: "transfer(address,uint256)" }],
    spends: [
      { token: USDC.address, allowance: "0x2540be400", unit: "year", multiplier: 2 },
      { token: "" as Address, allowance: "1000", unit: "forever" },
      { token: USDC.address, allowance: "7", unit: "minute", multiplier: 3 },
    ],
  },
};

/** JAW's grant takes its start from Date.now and its salt from 64 Math.random hex digits, before its first await. */
function withJawClock<T>(pick: { start: number; salt: bigint }, run: () => T): T {
  const digits = pick.salt.toString(16).padStart(64, "0");
  let i = 0;
  const now = vi.spyOn(Date, "now").mockReturnValue(pick.start * 1000 + 999);
  const random = vi
    .spyOn(Math, "random")
    .mockImplementation(() => (i < 64 ? (parseInt(digits[i++], 16) + 0.5) / 16 : 0.5));
  try {
    return run();
  } finally {
    now.mockRestore();
    random.mockRestore();
  }
}

type RawLog = { address: Address; topics: Hex[]; data: Hex };
/** The permission as the manager takes it and logs it. */
type OnChain = Parameters<typeof encodePermission>[0];
const TX = `0x${"0b".repeat(32)}` as Hex;
const BLOCK = `0x${"0c".repeat(32)}` as Hex;
const USER_OP = `0x${"0a".repeat(32)}` as Hex;

/** A PermissionApproved log, the permission as the manager logs it; the hash stands in for the manager's own. */
function approvedLog(p: OnChain, from: Address = MANAGER, hash?: Hex): RawLog {
  const data = encodePermission(p);
  const permissionHash = hash ?? keccak256(data);
  const topics = encodeEventTopics({
    abi: permissionManagerAbi,
    eventName: "PermissionApproved",
    args: { permissionHash },
  });
  return { address: from, topics: topics as Hex[], data };
}
const rpcLog = (l: RawLog, i: number) => ({
  ...l,
  blockHash: BLOCK,
  blockNumber: "0x1",
  transactionHash: TX,
  transactionIndex: "0x0",
  logIndex: `0x${i.toString(16)}`,
  removed: false,
});
const txReceipt = (logs: RawLog[]) => ({
  transactionHash: TX,
  transactionIndex: "0x0",
  blockHash: BLOCK,
  blockNumber: "0x1",
  from: "0x00000000000000000000000000000000000b0b00",
  to: entryPoint08Address,
  cumulativeGasUsed: "0x1",
  gasUsed: "0x1",
  effectiveGasPrice: "0x1",
  contractAddress: null,
  logs: logs.map(rpcLog),
  logsBloom: `0x${"00".repeat(256)}`,
  status: "0x1",
  type: "0x2",
});

type SdkCall = { to: Address; value: bigint; data: Hex };

/** A smart account that only records the calls JAW's send hands it; it signs nothing. */
function fakeAccount(sent: SdkCall[]) {
  return {
    address: USER,
    type: "smart",
    entryPoint: { address: entryPoint08Address, abi: entryPoint08Abi, version: "0.8" },
    encodeCalls: async (calls: readonly SdkCall[]) => {
      sent.push(...calls);
      return "0x";
    },
    getAddress: async () => USER,
    getFactoryArgs: async () => ({ factory: undefined, factoryData: undefined }),
    getNonce: async () => 0n,
    getStubSignature: async () => "0x",
    signUserOperation: async () => "0x",
    isDeployed: async () => true,
    userOperation: {
      estimateGas: async () => ({ callGasLimit: 1n, preVerificationGas: 1n, verificationGasLimit: 1n }),
    },
  } as unknown as SmartAccount;
}

/**
 * Runs JAW's own `grantPermissions` for `detail` with the clock and randomness set to `pick`. The fake bundler mines
 * the user operation in a transaction whose logs `logsFor` makes from the permission JAW approved; the fake relay
 * answers its POST with the record, as the real one does.
 */
async function jawGrant(detail: PermissionsDetail, pick: typeof PICK, logsFor: (approved: OnChain) => RawLog[]) {
  const sent: SdkCall[] = [];
  let logs: RawLog[] = [];
  net.rest.length = 0;
  net.restReply = (req) =>
    req.method === "POST" && req.url === RELAY_PERMISSIONS_URL
      ? { status: 201, body: { statusCode: 201, result: { data: JSON.parse(req.body), error: null } } }
      : { status: 200, body: { statusCode: 200, result: { data: {}, error: null } } };
  net.rpcReply = (method) => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_maxPriorityFeePerGas") return "0x1";
    if (method === "eth_getBlockByNumber") {
      return { number: "0x1", hash: BLOCK, timestamp: "0x1", baseFeePerGas: "0x1", transactions: [] };
    }
    if (method === "eth_sendUserOperation") {
      const { args } = decodeFunctionData({ abi: permissionManagerAbi, data: sent.at(-1)!.data });
      logs = logsFor(args[0] as OnChain);
      return USER_OP;
    }
    if (method === "eth_getUserOperationReceipt") {
      return {
        userOpHash: USER_OP,
        entryPoint: entryPoint08Address,
        sender: USER,
        nonce: "0x0",
        actualGasCost: "0x1",
        actualGasUsed: "0x1",
        success: true,
        reason: "",
        logs: [],
        receipt: txReceipt(logs),
      };
    }
    if (method === "eth_getTransactionReceipt") return txReceipt(logs);
    throw new Error(`unexpected ${method}`);
  };
  const pending = withJawClock(pick, () =>
    grantPermissions(fakeAccount(sent), EXPIRY, GUARD, detail, { id: 8453, rpcUrl: RPC }, API_KEY),
  );
  const response = await pending;
  const relay = net.rest.filter((r) => r.method === "POST" && r.url === RELAY_PERMISSIONS_URL);
  return { sent, response, logs, relay, rest: [...net.rest] };
}

/** The request our `storePermissionInRelay` sends, read the way the fake relay reads the SDK's. */
async function ourRelayRequest(id: Hex, p: Permission, apiKey: string | undefined) {
  let seen: { url: string; method: string; headers: Record<string, string>; body: string; credentials: string } | null =
    null;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen = {
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
      credentials: req.credentials,
    };
    return new Response(JSON.stringify({ statusCode: 201, result: { data: JSON.parse(seen.body), error: null } }), {
      status: 201,
    });
  }) as typeof fetch;
  const stored = await storePermissionInRelay(id, p, 8453, apiKey, fetchFn);
  return { seen: seen!, stored };
}

/** The receipt of a batch that approved one permission: the manager's PermissionApproved for it. */
const onlyOurs = (approved: OnChain) => [approvedLog(approved)];

describe("JAW's own grant, run against a fake bundler and relay, next to the one-tap grant", () => {
  for (const [name, detail] of Object.entries(TEMPLATES)) {
    it(`${name}: the same approve call, the same permission id and the same relay request`, async () => {
      const jaw = await jawGrant(detail, PICK, onlyOurs);
      const ours = jawPermission(USER, GUARD, EXPIRY, detail, PICK);

      // The user operation JAW's grant sends is one call, manager.approve(permission): ours, byte for byte.
      expect(jaw.sent).toHaveLength(1);
      expect(approveCall(ours)).toEqual(jaw.sent[0]);
      expect(jaw.sent[0].to).toBe(getAddress(PERMISSIONS_MANAGER_ADDRESS));
      expect(jaw.response.start).toBe(PICK.start);
      expect(jaw.response.salt).toBe(`0x${PICK.salt.toString(16)}`);

      // The id JAW reads from the receipt is the one we read, with or without the permission.
      expect(permissionIdFromReceipt(jaw.logs)).toBe(jaw.response.permissionId);
      expect(permissionIdFromReceipt(jaw.logs, ours)).toBe(jaw.response.permissionId);

      // One POST to the relay: the same URL, method, headers and body as ours.
      expect(jaw.relay).toHaveLength(1);
      const { seen, stored } = await ourRelayRequest(jaw.response.permissionId as Hex, ours, API_KEY);
      expect(seen).toEqual(jaw.relay[0]);
      expect(stored).toEqual(relayRecord(jaw.response.permissionId as Hex, ours, 8453));
    });
  }

  it("the relay request, written out: a POST of the record, keyed by the app's API key, nothing that proves ownership", async () => {
    const detail = TEMPLATES.save;
    const jaw = await jawGrant(detail, PICK, onlyOurs);
    const ours = jawPermission(USER, GUARD, EXPIRY, detail, PICK);
    expect(jaw.relay[0].url).toBe("https://api.justaname.id/proxy/v1/permissions");
    expect(jaw.relay[0].method).toBe("POST");
    expect(jaw.relay[0].headers).toEqual({
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "x-api-key": API_KEY,
    });
    expect(JSON.parse(jaw.relay[0].body)).toEqual({
      permissionId: jaw.response.permissionId,
      account: USER,
      spender: GUARD,
      start: PICK.start,
      end: EXPIRY,
      salt: `0x${PICK.salt.toString(16)}`,
      calls: ours.calls.map((c) => ({ target: c.target, selector: c.selector, checker: c.checker })),
      spends: ours.spends.map((s) => ({
        token: s.token,
        allowance: `0x${s.allowance.toString(16)}`,
        unit: "day",
        multiplier: 1,
      })),
      chainId: "0x2105",
    });
    // Its other request is the receipt notice every JAW send makes, which wallet_sendCalls makes for our batch too.
    expect(jaw.rest.map((r) => `${r.method} ${r.url.split("?")[0]}`)).toEqual([
      `PATCH https://api.justaname.id/proxy/v1/rpc/calls-history/${USER_OP}`,
      "POST https://api.justaname.id/proxy/v1/permissions",
    ]);
  });

  it("without an API key: the same request, no x-api-key", async () => {
    const ours = jawPermission(USER, GUARD, EXPIRY, TEMPLATES.save, PICK);
    const { seen } = await ourRelayRequest(`0x${"11".repeat(32)}`, ours, undefined);
    expect(seen.headers).toEqual({ accept: "application/json, text/plain, */*", "content-type": "application/json" });
  });

  it("a crowded bundle: JAW takes the first PermissionApproved the manager logged; ours does the same, or finds its own", async () => {
    const someoneElse = getAddress("0x00000000000000000000000000000000000a11ce");
    const theirs = contractPermission(jawPermission(someoneElse, GUARD, EXPIRY, TEMPLATES.save, PICK));
    const theirLog = approvedLog(theirs);
    const transfer = {
      address: USDC.address,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: USER, to: someoneElse } }),
      data: encodeAbiParameters([{ type: "uint256" }], [1n]),
    } as RawLog;
    const revoked = {
      address: MANAGER,
      topics: encodeEventTopics({
        abi: permissionManagerAbi,
        eventName: "PermissionRevoked",
        args: { permissionHash: `0x${"22".repeat(32)}` },
      }),
      data: "0x",
    } as RawLog;
    const spoof = approvedLog(theirs, USDC.address, `0x${"33".repeat(32)}`);
    const logsFor = (approved: OnChain) => [transfer, revoked, spoof, theirLog, approvedLog(approved)];
    const jaw = await jawGrant(TEMPLATES.save, PICK, logsFor);
    const ours = jawPermission(USER, GUARD, EXPIRY, TEMPLATES.save, PICK);

    expect(jaw.response.permissionId).toBe(theirLog.topics[1]);
    expect(permissionIdFromReceipt(jaw.logs)).toBe(jaw.response.permissionId);
    expect(permissionIdFromReceipt(jaw.logs, ours)).toBe(jaw.logs.at(-1)!.topics[1]);
    expect(permissionIdFromReceipt(jaw.logs, ours)).not.toBe(jaw.response.permissionId);
  });

  it("no PermissionApproved from the manager: JAW and ours fail with the same words", async () => {
    const someoneElse = getAddress("0x00000000000000000000000000000000000a11ce");
    const spoof = approvedLog(
      contractPermission(jawPermission(someoneElse, GUARD, EXPIRY, TEMPLATES.save, PICK)),
      USDC.address,
    );
    await expect(jawGrant(TEMPLATES.save, PICK, () => [spoof])).rejects.toThrow(
      "PermissionApproved event not found in transaction receipt",
    );
    expect(() => permissionIdFromReceipt([spoof])).toThrow("PermissionApproved event not found in transaction receipt");
  });
});

describe("the approve call against the SDK's exported builder", () => {
  for (const [name, detail] of Object.entries(TEMPLATES)) {
    it(`${name}: buildGrantPermissionCall with the same start and salt is our approve call`, () => {
      const jaw = withJawClock(PICK, () => buildGrantPermissionCall(USER, GUARD, EXPIRY, detail));
      expect(approveCall(jawPermission(USER, GUARD, EXPIRY, detail, PICK))).toEqual({ ...jaw, value: 0n });
    });
  }

  it("JAW's revoke, rebuilt from our relay record, revokes exactly the struct our batch approved", () => {
    for (const detail of Object.values(TEMPLATES)) {
      const p = jawPermission(USER, GUARD, EXPIRY, detail, PICK);
      const revoke = buildRevokePermissionCall(relayRecord(`0x${"44".repeat(32)}`, p, 8453));
      expect(revoke.data).toBe(
        encodeFunctionData({ abi: permissionManagerAbi, functionName: "revoke", args: [contractPermission(p)] }),
      );
      expect(revoke.to).toBe(approveCall(p).to);
    }
  });

  it("refuses a call with neither a selector nor a signature, as JAW's grant does", () => {
    const detail = { calls: [{ target: USDC.address }] } as PermissionsDetail;
    expect(() => jawPermission(USER, GUARD, EXPIRY, detail, PICK)).toThrow(
      "Either selector or functionSignature must be provided for call permission",
    );
    expect(() => withJawClock(PICK, () => buildGrantPermissionCall(USER, GUARD, EXPIRY, detail))).toThrow(
      "Either selector or functionSignature must be provided for call permission",
    );
  });

  it("picks a start from the clock and a fresh 256-bit salt each time", () => {
    const a = grantPick(1_792_454_400_999);
    const b = grantPick(1_792_454_400_999);
    expect(a.start).toBe(1_792_454_400);
    expect(a.salt).not.toBe(b.salt);
    expect(a.salt < 2n ** 256n).toBe(true);
  });
});

describe("addOwnerAddress(manager): JAW's call, and when the batch needs it", () => {
  it("is the call JAW's send puts first for an account the manager doesn't own", async () => {
    const impl = getAddress("0xbb4f7d5418Cd8DADB61bb95561179e517572cBCd");
    const isOwner = encodeFunctionData({ abi: jawAccountAbi, functionName: "isOwnerAddress", args: [MANAGER] });
    net.rpcReply = (method, params) => {
      const [q] = params as [{ to?: string; data?: string }];
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_getCode") return `0xef0100${impl.slice(2).toLowerCase()}`;
      if (method === "eth_call" && q.data === isOwner) return encodeAbiParameters([{ type: "bool" }], [false]);
      if (method === "eth_call") return encodeAbiParameters([{ type: "address" }], [impl]); // the factory's getImplementation
      throw new Error(`unexpected ${method}`);
    };
    const approve = approveCall(jawPermission(USER, GUARD, EXPIRY, TEMPLATES.save, PICK));
    const { calls } = await prepareCallsForExecution(fakeAccount([]), [approve], { id: 8453, rpcUrl: RPC }, {
      address: USER,
    } as never);
    expect(calls).toEqual([addManagerOwnerCall(USER), approve]);
  });

  const client = (code: Hex | undefined, owns: boolean | Error) => ({
    getCode: vi.fn(async () => code),
    readContract: vi.fn(async () => {
      if (owns instanceof Error) throw owns;
      return owns;
    }),
  });

  it("none for an account not deployed yet: JAW's factory makes the manager its second owner", async () => {
    const c = client(undefined, false);
    expect(await managerOwnerCalls(c as never, USER)).toEqual([]);
    expect(c.readContract).not.toHaveBeenCalled();
    expect(await managerOwnerCalls(client("0x", false) as never, USER)).toEqual([]);
  });

  it("none when the manager owns the account, the call when it doesn't, and no guess when Base doesn't answer", async () => {
    const clone = "0x363d3d373d3d3d363d73bb4f7d5418cd8dadb61bb95561179e517572cbcd5af43d82803e903d91602b57fd5bf3";
    expect(await managerOwnerCalls(client(clone, true) as never, USER)).toEqual([]);
    expect(await managerOwnerCalls(client(clone, false) as never, USER)).toEqual([addManagerOwnerCall(USER)]);
    await expect(managerOwnerCalls(client(clone, new Error("rpc down")) as never, USER)).rejects.toThrow("rpc down");
  });
});

describe("oneTapGrantCalls: one batch, one Face ID", () => {
  const grant = (detail: PermissionsDetail, account: Address = USER, spender: Address = GUARD) =>
    jawPermission(account, spender, EXPIRY, detail, PICK);
  const registered = (data: Hex, job: string) => {
    const { functionName, args } = decodeFunctionData({ abi: guardAbi, data });
    expect(functionName).toBe("register");
    const [id, permission] = args as readonly [number, Hex];
    expect(JOBS[id]).toBe(job);
    return permission;
  };

  it("owner call, then each approve, then each registration, as its own job, with the permission as the manager logs it", () => {
    const save = grant(TEMPLATES.save);
    const sell = grant(TEMPLATES.sell);
    const calls = oneTapGrantCalls(USER, [save, sell], [addManagerOwnerCall(USER)]);
    expect(calls.map((c) => c.to)).toEqual([USER, MANAGER, MANAGER, GUARD, GUARD]);
    expect(calls[1]).toEqual(approveCall(save));
    expect(calls[2]).toEqual(approveCall(sell));
    expect(registered(calls[3].data, "save")).toBe(approvedLog(contractPermission(save)).data);
    expect(registered(calls[4].data, "sell")).toBe(approvedLog(contractPermission(sell)).data);
    expect(calls.every((c) => c.value === 0n)).toBe(true);
  });

  it("refuses a grant that isn't the user's own agent", () => {
    const blocked = "Blocked: a grant that isn't one of the user's agents";
    expect(() => oneTapGrantCalls(USER, [grant(TEMPLATES.save, getAddress(pad("0xa11ce", { size: 20 })))])).toThrow(
      blocked,
    );
    expect(() => oneTapGrantCalls(USER, [grant(TEMPLATES.save, USER, USDC.address)])).toThrow(blocked);
    expect(() =>
      oneTapGrantCalls(USER, [grant(TEMPLATES["not ours: a signature, a year, the native token, × 3"])]),
    ).toThrow(blocked);
    expect(() => oneTapGrantCalls(USER, [])).toThrow("Nothing to grant");
  });

  it("refuses any owner change but addOwnerAddress(manager) on the user's own account, once", () => {
    const save = grant(TEMPLATES.save);
    const other = {
      ...addManagerOwnerCall(USER),
      data: encodeFunctionData({ abi: jawAccountAbi, functionName: "addOwnerAddress", args: [USDC.address] }),
    };
    expect(() => oneTapGrantCalls(USER, [save], [other])).toThrow("Blocked: unexpected owner change");
    expect(() => oneTapGrantCalls(USER, [save], [addManagerOwnerCall(GUARD)])).toThrow(
      "Blocked: unexpected owner change",
    );
    expect(() => oneTapGrantCalls(USER, [save], [addManagerOwnerCall(USER), addManagerOwnerCall(USER)])).toThrow(
      "Blocked: unexpected owner change",
    );
  });
});

describe("storePermissionInRelay: the relay's answers", () => {
  const p = jawPermission(USER, GUARD, EXPIRY, TEMPLATES.save, PICK);
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it("throws the relay's own words, with its status, when it refuses", async () => {
    const refused = answer(403, {
      statusCode: 403,
      result: {
        data: null,
        error:
          "KeylessOriginUnauthorizedException: no api-key was sent and the request carries no origin, so nothing identifies the caller",
      },
    });
    await expect(storePermissionInRelay(`0x${"55".repeat(32)}`, p, 8453, undefined, refused)).rejects.toMatchObject({
      message: expect.stringContaining("KeylessOriginUnauthorizedException"),
      status: 403,
    });
  });

  it("throws when the relay answers without a record", async () => {
    const empty = answer(201, { statusCode: 201, result: { data: null, error: "Permission already exists" } });
    await expect(storePermissionInRelay(`0x${"55".repeat(32)}`, p, 8453, API_KEY, empty)).rejects.toThrow(
      "Permission already exists",
    );
    await expect(
      storePermissionInRelay(`0x${"55".repeat(32)}`, p, 8453, API_KEY, answer(502, "bad gateway")),
    ).rejects.toThrow("JAW's relay didn't record the permission (HTTP 502)");
  });
});
