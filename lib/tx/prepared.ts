import { isAddressEqual, type Hex } from "viem";
import { healthFromAccountData } from "@/lib/aave/math";
import { accountDataRead, type Call } from "@/lib/aave/tx";
import type { ActivityItem } from "@/lib/activity/decode";
import { NOT_ATOMIC } from "@/lib/jaw/capabilities";

/*
 * One tap, one JAW sheet (2026-10-15). On iPhone Safari JAW opens its sheet as a popup (Safari has no
 * IntersectionObserver v2 and the app isn't on JAW's trusted-hosts list, so @jaw.id/core's TransportRouter routes to
 * the popup), and Safari lets `window.open` through only inside the tap's own user activation. A write that reads the
 * chain between the tap and wallet_sendCalls (the board read, a fresh quote, the simulation) loses that activation, and
 * JAW answers "Failed to open popup". So every write's batch is prepared while the screen is idle: built from fresh
 * reads, checked against the allowlist by its builders, GooseBoard.join() added when due, simulated with
 * eth_simulateV1. The tap then signs a batch prepared for exactly the inputs on screen, with nothing awaited before
 * wallet_sendCalls. Pure, so the rules are tested without a browser (tests/unit/prepared-tx.test.ts).
 */

type Address = `0x${string}`;

export type TxPhase = "idle" | "simulating" | "signing" | "pending" | "done" | "failed";

/** Stops a batch while it's built, with words for the user (e.g. the price moved since the screen showed it). */
export class TxStop extends Error {}

/** A prepared batch is signed only while it's under this old: the quote and the cash in it were read then. */
export const PREPARED_TTL_MS = 30_000;
/** While a screen keeps the same inputs, its batch is prepared again this often, so a tap finds one well inside the TTL. */
export const PREPARE_EVERY_MS = 15_000;
/** Inputs that keep changing (typing, a slider) are prepared once they've held still this long. */
export const PREPARE_SETTLE_MS = 300;

/** JAW couldn't open its popup (Safari, the activation was gone): the batch is kept, and the next tap opens it. */
export const TAP_AGAIN = "Tap again to open JAW.";
/** Base didn't answer while the batch was prepared: shown before any tap too, so it doesn't ask to try again. */
export const CANT_CHECK = "We couldn’t check this with Base right now.";
export const ONLY_SIGNER = "Only the signed-in account can do this. Nothing was sent.";
export const CANCELLED = "You cancelled. Nothing was sent.";
export const COULDNT_SEND = "We couldn’t send this. Please try again.";
export const DEFAULT_FALLBACK = "This would fail right now. Try again in a moment.";

/**
 * Act is the line (Adrian, 2026-10-15): a batch that takes credit or frees backing must not end in Act. Its screen plans
 * it at CREDIT_CAP.minHf on the position as last read (up to 15 s old), while Aave itself lets credit go down to a
 * health of 1.0 and, on borrow and withdraw, moves every collateral to its reserve's latest collateral factor. So the
 * simulation reads the account on Aave right after the batch, and a health under `minHf` (RISK.watchMin: in Act) stops
 * it with `stop`, before the tap and at the tap alike. Nothing owed after it passes.
 */
export type HealthFloor = { minHf: number; stop: string };

/**
 * What a screen would sign right now. `key` names every input that shapes the batch (txKey: the account, amounts,
 * legs, the stock, the quote, the plan…): a batch prepared for one key is never signed for another. `calls` builds the
 * batch from fresh reads (a TxStop shows its words).
 */
export type TxPlan = {
  key: string;
  user: Address;
  calls: Call[] | (() => Promise<Call[]>);
  /** Words for a revert the simulation can't name. */
  fallback?: string;
  /** The health the batch may not end under, read on Aave after it in the simulation (HealthFloor). */
  healthFloor?: HealthFloor;
  /** What Activity shows while it confirms. */
  activity?: ActivityItem[];
};

/** A key from the inputs that shape a batch, bigints included. Same inputs, same key. */
export function txKey(...parts: unknown[]): string {
  return JSON.stringify(parts, (_, v) => (typeof v === "bigint" ? `${v}n` : v === undefined ? null : v));
}

/** Every message in an error and its causes (viem keeps JAW's own words in `details` and `cause`). */
function messages(e: unknown): string {
  const out: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    if (typeof cur === "string") out.push(cur);
    else if (typeof cur === "object") {
      const o = cur as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
      for (const m of [o.message, o.details, o.shortMessage]) if (typeof m === "string") out.push(m);
      cur = o.cause;
      continue;
    }
    break;
  }
  return out.join("\n");
}

/** JAW's "Failed to open popup. Please allow popups for this site." (a 4001, so it also reads as a rejection). */
export const isPopupBlocked = (e: unknown) => /failed to open popup|allow popups/i.test(messages(e));
/** The user said no on JAW's sheet (not a blocked popup). */
export const isCancel = (e: unknown) => !isPopupBlocked(e) && /reject|denied|cancel/i.test(messages(e));

export type Checked = { ok: true; batch: Call[] } | { ok: false; error: string; blocks: boolean };

export type CheckDeps = {
  /** GooseBoard.join() at the end of an account's first move (lib/board/join.ts). */
  join: (user: Address, batch: Call[]) => Promise<Call[]>;
  /** eth_simulateV1 of the whole batch from the user. */
  simulate: (user: Address, batch: Call[]) => Promise<readonly { status: string; data?: Hex }[]>;
  /** A revert in plain words (lib/aave/errors.ts explainRevert). */
  explain: (data: Hex | undefined, fallback: string, call: Call) => string;
};

/**
 * Builds a plan's batch and checks it, the same way for a background preparation and at the tap: its calls (fresh
 * reads; every builder runs assertAllowed), join() when due, then the simulation. With a health floor, the account is
 * read on Aave at the end of the simulation, and a health under it stops the batch (Act is the line). A revert, a
 * TxStop or a health under the floor blocks it (`blocks`); Base not answering doesn't, so the tap can try again. The
 * batch signed is never the read.
 */
export async function checkPlan(plan: TxPlan, d: CheckDeps): Promise<Checked> {
  try {
    const built = typeof plan.calls === "function" ? await plan.calls() : plan.calls;
    const batch = await d.join(plan.user, built);
    const floor = plan.healthFloor;
    const results = await d.simulate(plan.user, floor ? [...batch, accountDataRead(plan.user)] : batch);
    const bad = results.slice(0, batch.length).findIndex((r) => r.status !== "success");
    if (bad >= 0) return { ok: false, error: d.explain(results[bad].data, plan.fallback ?? DEFAULT_FALLBACK, batch[bad]), blocks: true };
    if (floor) {
      const read = results[batch.length];
      // No health after it, no signature: it's checked again, as when Base doesn't answer.
      if (read?.status !== "success" || !read.data) return { ok: false, error: CANT_CHECK, blocks: false };
      const hf = healthFromAccountData(read.data);
      if (hf !== null && hf < floor.minHf) return { ok: false, error: floor.stop, blocks: true };
    }
    return { ok: true, batch };
  } catch (e) {
    return e instanceof TxStop ? { ok: false, error: e.message, blocks: true } : { ok: false, error: CANT_CHECK, blocks: false };
  }
}

/**
 * How many batches have landed (or failed on Base) on this page, from any write. A batch prepared before one may be
 * stale (a savings withdrawal sized for cash that another write spent), so it's never signed: every store prepares
 * again. Each useTx store is also cleared when its own batch lands; this covers the others on the same page.
 */
let landed = 0;
/** The stores someone is watching, told when the chain moved so their buttons wait for a new batch. */
const watched = new Set<PreparedTx>();

/** A write landed or failed on Base (useTx): nothing prepared before it may be signed, in any store. */
export function chainMoved() {
  landed += 1;
  for (const s of watched) s.refresh();
}

/** The current count of writes landed, stamped on each batch as its reads start. */
export const chainEpoch = () => landed;

/** A batch simulated OK for `key`, from reads taken from `at` on, after `epoch` writes had landed. */
export type PreparedBatch = { key: string; user: Address; batch: Call[]; at: number; epoch: number };
type Failure = { key: string; error: string; blocks: boolean; at: number; epoch: number };

/** What the button shows for the inputs on screen. */
export type PrepView = {
  key: string | null;
  /** A batch for these inputs can be signed now: the tap goes straight to JAW. */
  ready: boolean;
  /** No batch for these inputs yet: the button says "Checking…" and waits. */
  checking: boolean;
  /** Why the last preparation didn't go through; `blocked` when it can't go ahead (a revert, a stop). */
  error: string | null;
  blocked: boolean;
};

export const idleView = (key: string | null = null): PrepView => ({ key, ready: false, checking: false, error: null, blocked: false });
export const checkingView = (key: string): PrepView => ({ key, ready: false, checking: true, error: null, blocked: false });
const sameView = (a: PrepView, b: PrepView) =>
  a.key === b.key && a.ready === b.ready && a.checking === b.checking && a.error === b.error && a.blocked === b.blocked;

/**
 * One write's prepared batch (an external store, so a screen and the hook that signs share it). It holds at most one
 * batch, for the inputs on screen: new inputs drop it, a preparation that finishes after the inputs changed is thrown
 * away, and a batch is usable only under PREPARED_TTL_MS.
 */
export class PreparedTx {
  private key: string | null = null;
  private user: Address | null = null;
  private batch: PreparedBatch | null = null;
  private failure: Failure | null = null;
  private running: { key: string; user: Address; id: number; at: number; epoch: number } | null = null;
  private seq = 0;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private view: PrepView = idleView();
  private viewEpoch = landed;
  private listeners = new Set<() => void>();

  constructor(private now: () => number = Date.now) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    watched.add(this);
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) watched.delete(this);
    };
  };
  getSnapshot = () => {
    // A write landed while no one watched: the view is worked out again, without telling anyone mid-render.
    if (this.viewEpoch !== landed) {
      this.viewEpoch = landed;
      this.view = this.compute();
    }
    return this.view;
  };

  /** The chain moved (chainMoved): what was ready may not be any more. */
  refresh() {
    this.update();
  }

  /**
   * The inputs on screen. New inputs drop anything prepared or failed for other ones. Null (nothing can be signed for
   * a moment: a quote refreshing, the risk tick off) keeps the batch asleep: it's usable again only if the very same
   * inputs come back, within its TTL.
   */
  setPlan(key: string | null, user: Address | null) {
    if (key === this.key && (user === this.user || (!!user && !!this.user && isAddressEqual(user, this.user)))) return;
    this.key = key;
    this.user = user;
    if (key !== null) {
      if (this.batch?.key !== key) this.batch = null;
      if (this.failure?.key !== key) this.failure = null;
    }
    if (this.running?.key !== key) this.running = null;
    this.update();
  }

  /** The batch the tap may sign for `key` from `user`, or null: never one prepared for other inputs, nor a stale one. */
  usable(key: string, user: Address, now = this.now()): PreparedBatch | null {
    const b = this.batch;
    if (!b || b.key !== key || key !== this.key || !isAddressEqual(b.user, user) || b.epoch !== landed) return null;
    return now >= b.at && now - b.at < PREPARED_TTL_MS ? b : null;
  }

  /** Whether a background preparation should start for the inputs on screen: none running, the last over 15 s ago. */
  due(key: string, now = this.now()): boolean {
    if (key !== this.key || this.running?.key === key) return false;
    // Only what was prepared since the last write landed counts: anything older is prepared again at once.
    const b = this.batch?.key === key && this.batch.epoch === landed ? this.batch.at : -Infinity;
    const f = this.failure?.key === key && this.failure.epoch === landed ? this.failure.at : -Infinity;
    const last = Math.max(b, f);
    return now - last >= PREPARE_EVERY_MS;
  }

  /** A preparation starts for `key`; its reads are taken from now on. */
  begin(key: string, user: Address, now = this.now()): number {
    const id = ++this.seq;
    this.running = { key, user, id, at: now, epoch: landed };
    this.update();
    return id;
  }

  /** A preparation came back. Kept only when it's still the newest for the inputs on screen. */
  finish(id: number, r: Checked) {
    const run = this.running;
    if (!run || run.id !== id) return;
    this.running = null;
    if (run.key === this.key) {
      if (r.ok) {
        this.batch = { key: run.key, user: run.user, batch: r.batch, at: run.at, epoch: run.epoch };
        this.failure = null;
      } else {
        this.failure = { key: run.key, error: r.error, blocks: r.blocks, at: run.at, epoch: run.epoch };
        // A revert now means the batch from before would revert too.
        if (r.blocks) this.batch = null;
      }
    }
    this.update();
  }

  /** A batch built at the tap that JAW couldn't open: kept for its own inputs alone, for the next tap. */
  keep(b: PreparedBatch) {
    if (b.key !== this.key) return;
    if (this.batch?.key === b.key && this.batch.at >= b.at) return;
    this.batch = b;
    this.failure = null;
    this.update();
  }

  /** After a batch lands (or fails on Base): the chain moved, so nothing prepared before it may be signed. */
  clear() {
    this.batch = null;
    this.failure = null;
    this.running = null;
    this.update();
  }

  /** Nothing in flight counts any more (the screen went away or started signing). */
  abandon() {
    if (!this.running) return;
    this.running = null;
    this.update();
  }

  private compute(): PrepView {
    const key = this.key;
    if (key === null || this.user === null) return idleView(key);
    if (this.usable(key, this.user)) return { key, ready: true, checking: false, error: null, blocked: false };
    const f = this.failure?.key === key && this.failure.epoch === landed ? this.failure : null;
    if (f) return { key, ready: false, checking: false, error: f.error, blocked: f.blocks };
    return checkingView(key);
  }

  private update() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    this.viewEpoch = landed;
    const next = this.compute();
    // A ready batch stops being ready when it gets too old: say so then, even if nothing else happens.
    if (next.ready && this.batch) {
      this.expiry = setTimeout(() => this.update(), Math.max(0, this.batch.at + PREPARED_TTL_MS - this.now()) + 5);
    }
    if (sameView(next, this.view)) return;
    this.view = next;
    for (const l of this.listeners) l();
  }
}

/** What the tap needs: the account, the store, a clock, the check, and JAW (wagmi's sendCalls). */
export type SignDeps = {
  address: Address | undefined;
  prepared: PreparedTx;
  now: () => number;
  check: (plan: TxPlan) => Promise<Checked>;
  /** EIP-5792 `atomic` for a batch this long (lib/jaw/capabilities.ts atomicSend); null stops it. */
  atomic: (callCount: number) => { forceAtomic: boolean } | null;
  send: (batch: Call[], atomic: { forceAtomic: boolean }) => Promise<{ id: string }>;
  setPhase: (p: TxPhase) => void;
  setError: (e: string | null) => void;
  /** JAW took it: record it for Activity while it confirms. */
  onSent: (plan: TxPlan, id: string) => void;
};

/**
 * The tap. With a batch prepared for exactly the inputs on screen (the same key and account, simulated OK, under 30 s
 * old) it calls JAW's wallet_sendCalls before anything is awaited, so the tap's activation is still there when JAW
 * opens its sheet. Without one it builds and checks the batch first (fine where JAW opens in its iframe); if JAW then
 * can't open its popup, that batch is kept for this key alone and the screen says "Tap again to open JAW.".
 */
export function signPlan(plan: TxPlan | null, d: SignDeps): Promise<void> {
  if (!plan) return Promise.resolve();
  d.setError(null);
  // Every call is pinned to `plan.user` and simulated from it, so only that account may sign it. They differ only in
  // the dev preview (`?as=`), which would otherwise pay from the signed-in account for another address.
  if (!d.address || !isAddressEqual(plan.user, d.address)) {
    d.setPhase("failed");
    d.setError(ONLY_SIGNER);
    return Promise.resolve();
  }
  const ready = d.prepared.usable(plan.key, plan.user, d.now());
  return ready ? submit(plan, ready, d) : signSlow(plan, d);
}

/** Sends `b` to JAW straight away: nothing between here and `d.send` waits. */
function submit(plan: TxPlan, b: PreparedBatch, d: SignDeps): Promise<void> {
  const atomic = d.atomic(b.batch.length);
  if (!atomic) {
    d.setPhase("failed");
    d.setError(NOT_ATOMIC);
    return Promise.resolve();
  }
  d.setPhase("signing");
  let sent: Promise<{ id: string }>;
  try {
    sent = d.send(b.batch, atomic);
  } catch (e) {
    sent = Promise.reject(e);
  }
  return sent.then(
    ({ id }) => {
      d.onSent(plan, id);
      d.setPhase("pending");
    },
    (e: unknown) => {
      if (isPopupBlocked(e)) {
        d.prepared.keep(b);
        d.setPhase("idle");
        d.setError(TAP_AGAIN);
        return;
      }
      d.setPhase("failed");
      d.setError(isCancel(e) ? CANCELLED : COULDNT_SEND);
    },
  );
}

/** No batch ready for these inputs: build and check it now, then send it. */
async function signSlow(plan: TxPlan, d: SignDeps): Promise<void> {
  d.setPhase("simulating");
  const at = d.now();
  const epoch = landed;
  const r = await d.check(plan);
  if (!r.ok) {
    d.setPhase("failed");
    d.setError(r.error);
    return;
  }
  return submit(plan, { key: plan.key, user: plan.user, batch: r.batch, at, epoch }, d);
}
