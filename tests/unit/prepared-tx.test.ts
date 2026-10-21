import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jawSheet } from "@/lib/tx/jawSheet";
import type { Hex } from "viem";
import { UserRejectedRequestError, encodeFunctionResult, maxUint256 } from "viem";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { accountDataRead, type Call } from "@/lib/aave/tx";
import { NOT_ATOMIC } from "@/lib/jaw/capabilities";
import { tapDeps } from "@/hooks/useTx";
import {
  CANCELLED,
  CANT_CHECK,
  ONLY_SIGNER,
  PREPARE_EVERY_MS,
  PREPARED_TTL_MS,
  PreparedTx,
  TAP_AGAIN,
  TxStop,
  chainEpoch,
  chainMoved,
  checkPlan,
  isCancel,
  isPopupBlocked,
  signPlan,
  txKey,
  type CheckDeps,
  type Checked,
  type SignDeps,
  type TxPhase,
  type TxPlan,
} from "@/lib/tx/prepared";

const SAM = "0x2b8ce2c87c166d8e24e186e7e4253c11fc805427" as const;
const OTHER = "0x00000000000000000000000000000000000000aa" as const;
const call = (n: number): Call => ({
  to: "0x00000000000000000000000000000000000000c1",
  data: `0x${n.toString(16).padStart(8, "0")}` as Hex,
  value: 0n,
});
const plan = (key: string, user: `0x${string}` = SAM): TxPlan => ({ key, user, calls: [call(1)] });
const ok = (...n: number[]): Checked => ({ ok: true, batch: n.map(call) });

/** JAW's popup error as it reaches the app through viem (a 4001 whose details carry JAW's words). */
const popupError = () =>
  new UserRejectedRequestError(
    Object.assign(new Error("Failed to open popup. Please allow popups for this site."), { code: 4001 }),
  );

let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A store with `key` prepared at `clock`. */
function preparedFor(key: string, r: Checked = ok(1), user: `0x${string}` = SAM) {
  const store = new PreparedTx(now);
  store.setPlan(key, user);
  store.finish(store.begin(key, user), r);
  return store;
}

/** The tap's dependencies, with JAW's send mocked; `log` records the order things happen in. */
function deps(store: PreparedTx, over: Partial<SignDeps> = {}) {
  const log: string[] = [];
  const state = { phase: "idle" as TxPhase, error: null as string | null };
  const send = vi.fn((batch: Call[]) => {
    log.push(`send:${batch.map((c) => c.data).join(",")}`);
    return Promise.resolve({ id: "0xcalls" });
  });
  const check = vi.fn(async (p: TxPlan): Promise<Checked> => {
    log.push(`check:${p.key}`);
    return ok(9);
  });
  const d: SignDeps = {
    address: SAM,
    prepared: store,
    now,
    check,
    atomic: () => ({ forceAtomic: true }),
    send,
    setPhase: (p) => {
      log.push(`phase:${p}`);
      state.phase = p;
    },
    setError: (e) => {
      state.error = e;
    },
    onSent: () => log.push("sent"),
    ...over,
  };
  return { d, log, state, send, check };
}

describe("txKey: one key per set of inputs", () => {
  it("is the same for the same inputs, bigints included, and differs when any input does", () => {
    const quote = ["aerodrome", 10, 100_000_000n, 45_000_000n];
    expect(txKey("buy", SAM, "NVDAc", quote)).toBe(txKey("buy", SAM, "NVDAc", [...quote]));
    expect(txKey("buy", SAM, "NVDAc", quote)).not.toBe(
      txKey("buy", SAM, "NVDAc", ["aerodrome", 10, 100_000_000n, 45_000_001n]),
    );
    expect(txKey("buy", SAM, "NVDAc", quote)).not.toBe(txKey("buy", SAM, "AAPLc", quote));
    expect(txKey(1n)).not.toBe(txKey("1"));
  });
});

describe("JAW's blocked popup is told apart from a cancel", () => {
  it("reads JAW's words through viem's wrapping", () => {
    expect(isPopupBlocked(popupError())).toBe(true);
    expect(isPopupBlocked(new Error("Failed to open popup. Please allow popups for this site."))).toBe(true);
    expect(isCancel(popupError())).toBe(false);
  });

  it("a real rejection is a cancel, not a blocked popup", () => {
    const rejected = new UserRejectedRequestError(new Error("User rejected the request."));
    expect(isPopupBlocked(rejected)).toBe(false);
    expect(isCancel(rejected)).toBe(true);
    expect(isPopupBlocked(new Error("RPC down"))).toBe(false);
  });
});

describe("PreparedTx: a batch is signed only for the inputs it was prepared for", () => {
  it("a key mismatch is never usable", () => {
    const store = preparedFor("A");
    expect(store.usable("A", SAM)).not.toBeNull();
    expect(store.usable("B", SAM)).toBeNull();
    store.setPlan("B", SAM);
    expect(store.usable("A", SAM)).toBeNull();
    expect(store.usable("B", SAM)).toBeNull();
  });

  it("another account never uses it", () => {
    const store = preparedFor("A");
    expect(store.usable("A", OTHER)).toBeNull();
  });

  it("an input change clears it: coming back to the old inputs needs a new preparation", () => {
    const store = preparedFor("A");
    store.setPlan("B", SAM);
    store.setPlan("A", SAM);
    expect(store.usable("A", SAM)).toBeNull();
    expect(store.getSnapshot()).toMatchObject({ key: "A", ready: false, checking: true });
  });

  it("a moment with nothing to sign (a quote refreshing) keeps it for the very same inputs", () => {
    const store = preparedFor("A");
    store.setPlan(null, null);
    expect(store.getSnapshot()).toMatchObject({ key: null, ready: false, checking: false });
    store.setPlan("A", SAM);
    expect(store.usable("A", SAM)).not.toBeNull();
    store.setPlan(null, null);
    store.setPlan("B", SAM);
    store.setPlan("A", SAM);
    expect(store.usable("A", SAM)).toBeNull();
  });

  it("is stale at 30 s, is prepared again after 15 s, and the new one is fresh", () => {
    const store = preparedFor("A");
    expect(store.due("A")).toBe(false);
    clock += PREPARE_EVERY_MS - 1;
    expect(store.due("A")).toBe(false);
    clock += 1;
    expect(store.due("A")).toBe(true);
    clock += PREPARED_TTL_MS - PREPARE_EVERY_MS - 1;
    expect(store.usable("A", SAM)).not.toBeNull();
    clock += 1;
    expect(store.usable("A", SAM)).toBeNull();
    // The view says so on its own, when the batch gets too old.
    vi.advanceTimersByTime(PREPARED_TTL_MS + 10);
    expect(store.getSnapshot()).toMatchObject({ ready: false, checking: true });
    const id = store.begin("A", SAM);
    expect(store.due("A")).toBe(false);
    store.finish(id, ok(2));
    expect(store.usable("A", SAM)?.batch).toEqual([call(2)]);
    expect(store.getSnapshot()).toMatchObject({ ready: true, checking: false });
  });

  it("a preparation that comes back after the inputs changed is thrown away", () => {
    const store = new PreparedTx(now);
    store.setPlan("A", SAM);
    const id = store.begin("A", SAM);
    store.setPlan("B", SAM);
    store.finish(id, ok(1));
    expect(store.usable("A", SAM)).toBeNull();
    expect(store.usable("B", SAM)).toBeNull();
  });

  it("only the newest preparation counts", () => {
    const store = new PreparedTx(now);
    store.setPlan("A", SAM);
    const first = store.begin("A", SAM);
    clock += 10;
    const second = store.begin("A", SAM);
    store.finish(second, ok(2));
    store.finish(first, ok(1));
    expect(store.usable("A", SAM)?.batch).toEqual([call(2)]);
  });

  it("a simulation that fails blocks it, and drops the batch from before", () => {
    const store = preparedFor("A");
    clock += PREPARE_EVERY_MS;
    store.finish(store.begin("A", SAM), {
      ok: false,
      error: "That’s more than your stocks can back right now.",
      blocks: true,
    });
    expect(store.usable("A", SAM)).toBeNull();
    expect(store.getSnapshot()).toMatchObject({
      ready: false,
      checking: false,
      blocked: true,
      error: "That’s more than your stocks can back right now.",
    });
  });

  it("Base not answering doesn't block, and keeps the batch it has until its TTL", () => {
    const store = preparedFor("A");
    clock += PREPARE_EVERY_MS;
    store.finish(store.begin("A", SAM), { ok: false, error: CANT_CHECK, blocks: false });
    expect(store.usable("A", SAM)).not.toBeNull();
    const fresh = new PreparedTx(now);
    fresh.setPlan("B", SAM);
    fresh.finish(fresh.begin("B", SAM), { ok: false, error: CANT_CHECK, blocks: false });
    expect(fresh.getSnapshot()).toMatchObject({ ready: false, checking: false, blocked: false, error: CANT_CHECK });
  });

  it("keeps a batch built at the tap only for the inputs on screen", () => {
    const store = new PreparedTx(now);
    store.setPlan("A", SAM);
    store.keep({ key: "B", user: SAM, batch: [call(1)], at: clock, epoch: chainEpoch() });
    expect(store.usable("B", SAM)).toBeNull();
    store.keep({ key: "A", user: SAM, batch: [call(1)], at: clock, epoch: chainEpoch() });
    expect(store.usable("A", SAM)).not.toBeNull();
  });
});

describe("a write that lands on the page: nothing prepared before it is signed", () => {
  it("every store's batch stops being usable, its button waits, and it's prepared again at once", () => {
    const a = preparedFor("A");
    const b = preparedFor("B");
    const seen = vi.fn();
    b.subscribe(seen);
    expect(b.getSnapshot()).toMatchObject({ ready: true });
    chainMoved();
    expect(a.usable("A", SAM)).toBeNull();
    expect(b.usable("B", SAM)).toBeNull();
    // The watched store tells its screen; the other works it out when it's next read.
    expect(seen).toHaveBeenCalled();
    expect(b.getSnapshot()).toMatchObject({ key: "B", ready: false, checking: true });
    expect(a.getSnapshot()).toMatchObject({ key: "A", ready: false, checking: true });
    // No 15 s wait: what's there is from before the write.
    expect(a.due("A")).toBe(true);
    a.finish(a.begin("A", SAM), ok(2));
    expect(a.usable("A", SAM)?.batch).toEqual([call(2)]);
  });

  it("a preparation that started before the write is never signable, and a stop from before is checked again", () => {
    const store = new PreparedTx(now);
    store.setPlan("A", SAM);
    const id = store.begin("A", SAM);
    chainMoved();
    store.finish(id, ok(1));
    expect(store.usable("A", SAM)).toBeNull();
    expect(store.due("A")).toBe(true);

    const stopped = new PreparedTx(now);
    stopped.setPlan("A", SAM);
    stopped.finish(stopped.begin("A", SAM), { ok: false, error: "Your cash moved since you started.", blocks: true });
    expect(stopped.getSnapshot()).toMatchObject({ blocked: true });
    chainMoved();
    expect(stopped.getSnapshot()).toMatchObject({ blocked: false, checking: true, error: null });
    expect(stopped.due("A")).toBe(true);
  });

  it("a sleeping batch (its sheet closed) doesn't wake up after another write landed", () => {
    const store = preparedFor("A");
    store.setPlan(null, null);
    chainMoved();
    store.setPlan("A", SAM);
    expect(store.usable("A", SAM)).toBeNull();
  });

  it("a batch kept after a blocked popup is dropped by a write that landed while JAW was being asked", async () => {
    const store = new PreparedTx(now);
    store.setPlan("A", SAM);
    const blocked = deps(store, {
      check: vi.fn(async () => {
        chainMoved();
        return ok(9);
      }),
      send: vi.fn(() => Promise.reject(popupError())),
    });
    await signPlan(plan("A"), blocked.d);
    expect(blocked.state.error).toBe(TAP_AGAIN);
    expect(store.usable("A", SAM)).toBeNull();
    const again = deps(store);
    await signPlan(plan("A"), again.d);
    expect(again.check).toHaveBeenCalledTimes(1);
  });
});

describe("checkPlan: build, join(), simulate", () => {
  const d = (over: Partial<CheckDeps> = {}): CheckDeps => ({
    join: async (_u, batch) => [...batch, call(99)],
    simulate: async (_u, batch) => batch.map(() => ({ status: "success" })),
    explain: (_data, fallback) => fallback,
    ...over,
  });

  it("builds the calls from fresh reads, adds join() and simulates the whole batch", async () => {
    const simulate = vi.fn(async (_u: `0x${string}`, batch: Call[]) => batch.map(() => ({ status: "success" })));
    const r = await checkPlan({ key: "A", user: SAM, calls: async () => [call(1)] }, d({ simulate }));
    expect(r).toEqual({ ok: true, batch: [call(1), call(99)] });
    expect(simulate).toHaveBeenCalledWith(SAM, [call(1), call(99)]);
  });

  it("a revert blocks with its words; a stop with its own; Base down doesn't block", async () => {
    const reverts = d({ simulate: async () => [{ status: "success" }, { status: "failure", data: "0x" }] });
    expect(await checkPlan({ ...plan("A"), fallback: "Would fail." }, reverts)).toEqual({
      ok: false,
      error: "Would fail.",
      blocks: true,
    });
    const stops = await checkPlan(
      { key: "A", user: SAM, calls: async () => Promise.reject(new TxStop("The price moved.")) },
      d(),
    );
    expect(stops).toEqual({ ok: false, error: "The price moved.", blocks: true });
    const down = await checkPlan(plan("A"), d({ simulate: async () => Promise.reject(new Error("fetch failed")) }));
    expect(down).toEqual({ ok: false, error: CANT_CHECK, blocks: false });
  });
});

describe("checkPlan: the health on Aave after a batch that takes credit or frees backing (Act is the line)", () => {
  const STOP = "That would put your credit in Act. Try a smaller amount.";
  /** getUserAccountData's answer with this health factor (WAD), as eth_simulateV1 returns it. */
  const account = (hfWad: bigint): Hex =>
    encodeFunctionResult({
      abi: spokeAbi,
      functionName: "getUserAccountData",
      result: {
        riskPremium: 0n,
        avgCollateralFactor: 7n * 10n ** 17n,
        healthFactor: hfWad,
        totalCollateralValue: 0n,
        totalDebtValueRay: 0n,
        activeCollateralCount: 1n,
        borrowCount: 1n,
      },
    });
  const wad = (hf: number) => BigInt(Math.round(hf * 1e6)) * 10n ** 12n;
  const floored: TxPlan = {
    key: "credit",
    user: SAM,
    calls: async () => [call(1), call(2)],
    healthFloor: { minHf: 1.1, stop: STOP },
  };
  /** The batch succeeds; the read at its end answers `data` (or fails). */
  const withHealth = (data: Hex | null) =>
    vi.fn(async (_u: `0x${string}`, batch: Call[]) =>
      batch.map((_, i) =>
        i === batch.length - 1
          ? data
            ? { status: "success", data }
            : { status: "failure", data: "0x" as Hex }
          : { status: "success", data: "0x" as Hex },
      ),
    );
  const deps = (simulate: CheckDeps["simulate"]): CheckDeps => ({
    join: async (_u, batch) => batch,
    simulate,
    explain: (_d, fallback) => fallback,
  });

  it("reads the account on Aave at the end of the simulation, and signs only the batch", async () => {
    const simulate = withHealth(account(wad(1.1201)));
    const r = await checkPlan(floored, deps(simulate));
    expect(r).toEqual({ ok: true, batch: [call(1), call(2)] });
    expect(simulate).toHaveBeenCalledWith(SAM, [call(1), call(2), accountDataRead(SAM)]);
  });

  it("stops a batch that lands in Act, whatever the screen planned, with the floor's words", async () => {
    expect(await checkPlan(floored, deps(withHealth(account(wad(1.0999)))))).toEqual({
      ok: false,
      error: STOP,
      blocks: true,
    });
    // At the line exactly it's Watch, and goes ahead.
    expect((await checkPlan(floored, deps(withHealth(account(wad(1.1)))))).ok).toBe(true);
    // Nothing owed after it (a full Free up with no credit): no health to fall under.
    expect((await checkPlan(floored, deps(withHealth(account(maxUint256))))).ok).toBe(true);
  });

  it("without the health after it, it isn't signed: checked again, as when Base doesn't answer", async () => {
    expect(await checkPlan(floored, deps(withHealth(null)))).toEqual({ ok: false, error: CANT_CHECK, blocks: false });
    expect(await checkPlan(floored, deps(withHealth("0x1234")))).toEqual({
      ok: false,
      error: CANT_CHECK,
      blocks: false,
    });
  });

  it("a revert in the batch still names its own call, not the read", async () => {
    const explain = vi.fn((_d: Hex | undefined, fallback: string, c: Call) => `${fallback} ${c.data}`);
    const simulate = async (_u: `0x${string}`, batch: Call[]) =>
      batch.map((_, i) => ({ status: i === 1 ? "failure" : "success", data: "0x" as Hex }));
    expect(await checkPlan({ ...floored, fallback: "Fails at" }, { ...deps(simulate), explain })).toEqual({
      ok: false,
      error: `Fails at ${call(2).data}`,
      blocks: true,
    });
  });

  it("a plan without a floor (a buy, a repay, backing alone) has nothing read after it", async () => {
    const simulate = vi.fn(async (_u: `0x${string}`, batch: Call[]) => batch.map(() => ({ status: "success" })));
    await checkPlan({ key: "buy", user: SAM, calls: [call(1)] }, deps(simulate));
    expect(simulate).toHaveBeenCalledWith(SAM, [call(1)]);
  });
});

describe("signPlan: the tap", () => {
  it("with a batch prepared for the inputs on screen, reaches JAW's wallet_sendCalls before anything is awaited", async () => {
    const store = preparedFor("A", ok(1, 2));
    const { d, log, send, check, state } = deps(store);
    const done = signPlan(plan("A"), d);
    // Nothing awaited yet: the call already went to JAW, inside the tap's activation.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual([call(1), call(2)]);
    expect(check).not.toHaveBeenCalled();
    expect(log).toEqual(["phase:signing", `send:${call(1).data},${call(2).data}`]);
    await done;
    expect(log.slice(2)).toEqual(["sent", "phase:pending"]);
    expect(state.error).toBeNull();
  });

  it("through useTx's own wiring (tapDeps), wagmi's sendCalls gets the batch on Base before anything is awaited", async () => {
    // tapDeps reads the real clock (Date.now), faked here to the store's.
    vi.setSystemTime(clock);
    const store = preparedFor("A", ok(1, 2));
    const sendCalls = vi.fn(async () => ({ id: "0xcalls" }));
    const check = vi.fn(async () => ok(9));
    const phases: TxPhase[] = [];
    const onSent = vi.fn();
    const caps = { atomic: { status: "supported" } } as unknown as Parameters<typeof tapDeps>[0]["chainCaps"];
    const done = signPlan(
      plan("A"),
      tapDeps({
        address: SAM,
        store,
        chainCaps: caps,
        check,
        sendCalls,
        setPhase: (p) => phases.push(p),
        setError: vi.fn(),
        onSent,
      }),
    );
    expect(sendCalls).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveBeenCalledWith({
      chainId: 8453,
      calls: [call(1), call(2)].map(({ to, data }) => ({ to, data })),
      forceAtomic: true,
    });
    expect(check).not.toHaveBeenCalled();
    expect(phases).toEqual(["signing"]);
    await done;
    expect(onSent).toHaveBeenCalledWith(plan("A"), "0xcalls");
    expect(phases).toEqual(["signing", "pending"]);
  });

  it("never signs a batch prepared for other inputs: it builds and checks the screen's own first", async () => {
    const store = preparedFor("A", ok(1));
    store.setPlan("B", SAM);
    const { d, send, check, log } = deps(store);
    const done = signPlan(plan("B"), d);
    expect(send).not.toHaveBeenCalled();
    await done;
    expect(check).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      "phase:simulating",
      "check:B",
      "phase:signing",
      `send:${call(9).data}`,
      "sent",
      "phase:pending",
    ]);
  });

  it("a batch over 30 s old is checked again before JAW sees anything", async () => {
    const store = preparedFor("A");
    clock += PREPARED_TTL_MS;
    const { d, send, check } = deps(store);
    const done = signPlan(plan("A"), d);
    expect(send).not.toHaveBeenCalled();
    await done;
    expect(check).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual([call(9)]);
  });

  it("when JAW can't open its popup, keeps the batch for that key alone, and the next tap sends it at once", async () => {
    const store = new PreparedTx(now);
    store.setPlan("A", SAM);
    const blocked = deps(store, { send: vi.fn(() => Promise.reject(popupError())) });
    await signPlan(plan("A"), blocked.d);
    expect(blocked.check).toHaveBeenCalledTimes(1);
    expect(blocked.state).toEqual({ phase: "idle", error: TAP_AGAIN });

    const again = deps(store);
    const done = signPlan(plan("A"), again.d);
    expect(again.send).toHaveBeenCalledTimes(1);
    expect(again.send.mock.calls[0][0]).toEqual([call(9)]);
    expect(again.check).not.toHaveBeenCalled();
    await done;
    expect(again.state.phase).toBe("pending");
  });

  it("the kept batch is gone once the inputs change", async () => {
    const store = new PreparedTx(now);
    store.setPlan("A", SAM);
    await signPlan(plan("A"), deps(store, { send: vi.fn(() => Promise.reject(popupError())) }).d);
    store.setPlan("B", SAM);
    store.setPlan("A", SAM);
    const { d, send } = deps(store);
    void signPlan(plan("A"), d);
    expect(send).not.toHaveBeenCalled();
  });

  it("a prepared batch JAW couldn't open stays for the next tap", async () => {
    const store = preparedFor("A");
    const blocked = deps(store, { send: vi.fn(() => Promise.reject(popupError())) });
    await signPlan(plan("A"), blocked.d);
    expect(blocked.state).toEqual({ phase: "idle", error: TAP_AGAIN });
    const again = deps(store);
    void signPlan(plan("A"), again.d);
    expect(again.send).toHaveBeenCalledTimes(1);
  });

  it("a simulation that fails at the tap blocks it: nothing reaches JAW", async () => {
    const store = new PreparedTx(now);
    store.setPlan("A", SAM);
    const { d, send, state } = deps(store, {
      check: vi.fn(async () => ({ ok: false as const, error: "Would fail.", blocks: true })),
    });
    await signPlan(plan("A"), d);
    expect(send).not.toHaveBeenCalled();
    expect(state).toEqual({ phase: "failed", error: "Would fail." });
  });

  it("says when the user cancelled, and keeps the batch for another try", async () => {
    const store = preparedFor("A");
    const { d, state } = deps(store, {
      send: vi.fn(() => Promise.reject(new UserRejectedRequestError(new Error("User rejected the request.")))),
    });
    await signPlan(plan("A"), d);
    expect(state).toEqual({ phase: "failed", error: CANCELLED });
    expect(store.usable("A", SAM)).not.toBeNull();
  });

  it("only the signed-in account signs, and a batch JAW can't run all at once isn't sent", async () => {
    const store = preparedFor("A");
    const preview = deps(store, { address: OTHER });
    await signPlan(plan("A"), preview.d);
    expect(preview.send).not.toHaveBeenCalled();
    expect(preview.state).toEqual({ phase: "failed", error: ONLY_SIGNER });
    const apart = deps(store, { atomic: () => null });
    await signPlan(plan("A"), apart.d);
    expect(apart.send).not.toHaveBeenCalled();
    expect(apart.state).toEqual({ phase: "failed", error: NOT_ATOMIC });
  });
});

describe("JAW's sheet is up exactly while JAW answers (our sheet steps aside meanwhile)", () => {
  it("from the send until JAW sends, cancels or is blocked", async () => {
    for (const answer of [
      () => Promise.resolve({ id: "0xcalls" }),
      () => Promise.reject(new Error("User rejected the request.")),
      () => Promise.reject(popupError()),
    ]) {
      const store = preparedFor("A", ok(1));
      let upAtSend = false;
      const send = vi.fn(() => {
        upAtSend = jawSheet.isUp();
        return answer();
      });
      const done = signPlan(plan("A"), deps(store, { send }).d);
      expect(upAtSend).toBe(true);
      await done;
      expect(jawSheet.isUp()).toBe(false);
    }
  });

  it("isn't raised for a batch that never reaches JAW", async () => {
    const store = new PreparedTx(now);
    await signPlan(
      plan("A"),
      deps(store, { check: vi.fn(async () => ({ ok: false as const, error: "stop", blocks: true })) }).d,
    );
    expect(jawSheet.isUp()).toBe(false);
  });
});
