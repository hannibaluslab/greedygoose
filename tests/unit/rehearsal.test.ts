import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, type Address } from "viem";
import { buildGrantPermissionCall } from "@jaw.id/core";
import {
  agentPermission,
  entryPermission,
  jobGrant,
  rebalancePermission,
  sellPermission,
  type AgentJob,
  type StockLimits,
} from "@/lib/agents/permissions";
import { permissionManagerAbi } from "@/lib/guardian/abis";
import { GUARDIAN } from "@/lib/guardian/config";
import { isLocalRpc, rehearsalRpcFrom } from "@/lib/rehearsal/flag";

const LOCAL = "http://127.0.0.1:18545";
const account = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA" as const;
const executor = getAddress("0x00000000000000000000000000000000000e5ec0");
const signer = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the rehearsal's on-switch (lib/rehearsal/flag.ts)", () => {
  it("is off in production, whatever the environment says", () => {
    expect(rehearsalRpcFrom({ NODE_ENV: "production", NEXT_PUBLIC_REHEARSAL_RPC: LOCAL })).toBeUndefined();
    expect(rehearsalRpcFrom({ NODE_ENV: "production", NEXT_PUBLIC_REHEARSAL_RPC: "https://mainnet.base.org" })).toBeUndefined();
  });

  it("is off without NEXT_PUBLIC_REHEARSAL_RPC", () => {
    expect(rehearsalRpcFrom({ NODE_ENV: "development" })).toBeUndefined();
    expect(rehearsalRpcFrom({ NODE_ENV: "development", NEXT_PUBLIC_REHEARSAL_RPC: " " })).toBeUndefined();
  });

  it("is on in development with a local fork", () => {
    expect(rehearsalRpcFrom({ NODE_ENV: "development", NEXT_PUBLIC_REHEARSAL_RPC: LOCAL })).toBe(LOCAL);
    expect(rehearsalRpcFrom({ NODE_ENV: "development", NEXT_PUBLIC_REHEARSAL_RPC: "http://localhost:8545" })).toBe("http://localhost:8545");
    expect(rehearsalRpcFrom({ NODE_ENV: "test", NEXT_PUBLIC_REHEARSAL_RPC: "http://[::1]:8545" })).toBe("http://[::1]:8545");
  });

  it("refuses any RPC that isn't on this machine, so the fork signer can't be pointed at a real chain", () => {
    for (const url of ["https://mainnet.base.org", "http://10.0.0.5:8545", "http://127.0.0.1.example.com:8545", "ws://127.0.0.1:8545", "not a url"]) {
      expect(isLocalRpc(url)).toBe(false);
      expect(() => rehearsalRpcFrom({ NODE_ENV: "development", NEXT_PUBLIC_REHEARSAL_RPC: url })).toThrow(/local anvil fork/);
    }
  });
});

describe("the production build has no fork signer", () => {
  const fork = { NEXT_PUBLIC_REHEARSAL_RPC: LOCAL, NEXT_PUBLIC_REHEARSAL_ACCOUNT: account, NEXT_PUBLIC_REHEARSAL_SIGNER: signer, NEXT_PUBLIC_REHEARSAL_FROM_BLOCK: "1" };

  it("wagmi signs in with JAW's connector in production, even with every rehearsal variable set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [k, v] of Object.entries(fork)) vi.stubEnv(k, v);
    const config = await import("@/lib/jaw/config");
    expect(config.REHEARSAL).toBeNull();
    expect(config.SIGN_IN_CONNECTOR_TYPE).toBe("jaw");
    expect(config.wagmiConfig.connectors.map((c) => c.type)).toEqual(["jaw"]);
  });

  it("the fork signer and its loader refuse to run in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [k, v] of Object.entries(fork)) vi.stubEnv(k, v);
    const { createForkSigner } = await import("@/lib/rehearsal/signer");
    expect(() => createForkSigner({ rpc: LOCAL, account, signer, fromBlock: 1n })).toThrow(/development only/);
    const { loadRehearsal } = await import("@/lib/rehearsal");
    expect(loadRehearsal()).toBeNull();
  });

  // lib/jaw/config.ts loads this with require(), which vitest can't resolve through the @/ alias; `npm run
  // rehearsal:prove` covers that path in the real app.
  it("in development the rehearsal brings the fork's RPC and the fork signer's connector", async () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const [k, v] of Object.entries(fork)) vi.stubEnv(k, v);
    const { loadRehearsal } = await import("@/lib/rehearsal");
    const r = loadRehearsal();
    expect(r?.rpc).toBe(LOCAL);
    expect(r?.connectorType).toBe("rehearsal");
  });

  it("the rehearsal needs its account, signer and first block, or it doesn't start", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_REHEARSAL_RPC", LOCAL);
    const { loadRehearsal } = await import("@/lib/rehearsal");
    expect(() => loadRehearsal()).toThrow(/NEXT_PUBLIC_REHEARSAL_ACCOUNT is missing/);
  });
});

describe("the fork signer's grant is JAW's (buildGrantPermissionCall) and GooseExecutor's template", () => {
  const limits: StockLimits = [0n, 0n, 0n, 0n, 0n, 2_250_000n, 0n];
  const cases: { job: AgentJob; cap: bigint; limits?: StockLimits }[] = [
    { job: "save", cap: 5_000_000n },
    { job: "protect", cap: 5_000_000n },
    { job: "sell", cap: 5_000_000n, limits },
    { job: "rebalance", cap: 5_000_000n, limits },
    { job: "entry", cap: 5_000_000n },
  ];

  it.each(cases)("$job: the approve JAW's grant ends with carries the permission the executor rebuilds", ({ job, cap, limits }) => {
    const expiry = Math.floor(Date.now() / 1000) + 365 * 86_400;
    const call = buildGrantPermissionCall(account, executor, expiry, jobGrant(job, cap, limits));
    expect(getAddress(call.to)).toBe(getAddress(GUARDIAN.PERMISSION_MANAGER));
    const { functionName, args } = decodeFunctionData({ abi: permissionManagerAbi, data: call.data });
    expect(functionName).toBe("approve");
    const p = args[0] as { account: Address; spender: Address; start: number; end: number; salt: bigint };
    // JAW's SDK picks the start (this clock) and a random salt; everything else must be the template.
    expect(Math.abs(p.start - Date.now() / 1000)).toBeLessThan(5);
    expect(p.end).toBe(expiry);
    const signed = { account, spender: executor, start: p.start, end: p.end, salt: p.salt, capRaw: cap };
    const template =
      job === "save" || job === "protect"
        ? agentPermission(job, signed)
        : job === "sell"
          ? sellPermission({ ...signed, limitsRaw: limits! })
          : job === "rebalance"
            ? rebalancePermission({ ...signed, limitsRaw: limits! })
            : entryPermission(signed);
    expect(args[0]).toEqual(template);
  });
});

describe("the fork signer answers JAW's wallet methods (no network needed for these)", () => {
  const load = async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { createForkSigner, REHEARSAL_SIGNER_MARKER } = await import("@/lib/rehearsal/signer");
    return { signer: createForkSigner({ rpc: LOCAL, account, signer, fromBlock: 1n }), marker: REHEARSAL_SIGNER_MARKER };
  };

  it("is the rehearsal account on Base", async () => {
    const { signer: s } = await load();
    expect(await s.request({ method: "eth_accounts" })).toEqual([account]);
    expect(await s.request({ method: "eth_chainId" })).toBe("0x2105");
  });

  it("reports what JAW reports on Base: atomic batches and USDC as a fee token, and that it is the rehearsal", async () => {
    const { signer: s, marker } = await load();
    const caps = (await s.request({ method: "wallet_getCapabilities", params: [account] })) as Record<string, Record<string, unknown>>;
    expect(caps["0x2105"].atomic).toEqual({ status: "supported" });
    expect(caps["0x2105"].feeToken).toMatchObject({ supported: true, tokens: [{ symbol: "USDC", feeToken: true }] });
    expect(caps["0x2105"].rehearsal).toEqual({ fork: true, signer: marker });
  });

  it("refuses other chains, other senders and anything it doesn't stand in for", async () => {
    const { signer: s } = await load();
    await expect(s.request({ method: "wallet_sendCalls", params: [{ chainId: "0x1", calls: [{ to: account }] }] })).rejects.toMatchObject({ code: 4902 });
    await expect(s.request({ method: "wallet_sendCalls", params: [{ chainId: "0x2105", from: signer, calls: [{ to: account }] }] })).rejects.toMatchObject({ code: 4100 });
    await expect(s.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] })).rejects.toMatchObject({ code: 4902 });
    for (const method of ["personal_sign", "eth_sendTransaction", "eth_sendRawTransaction", "eth_signTypedData_v4", "wallet_sign"]) {
      await expect(s.request({ method, params: [] })).rejects.toMatchObject({ code: 4200 });
    }
  });
});
