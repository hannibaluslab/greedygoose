import {
  isAddressEqual,
  parseEventLogs,
  type Address,
  type ContractEventName,
  type Hex,
  type Log,
  type ParseEventLogsReturnType,
} from "viem";
import { DEFAULT_PROTECT } from "@/lib/agents/lines";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { unpackMix } from "@/lib/agents/mix";
import { JOBS, type AgentJob } from "@/lib/agents/permissions";

/** Why a plan switches a job off (GoosePlanner's Plan.off, GooseExecutor's OffReason kept for the app), in order. */
export const OFF_REASONS = ["revoked", "expired", "not-owner", "stuck"] as const;

/** GooseGuard's move kinds, in order: what a `Refused` event names (spec-final-v2.md §4.0). */
export const MOVES = ["save", "repay", "sell", "trade", "convert", "end", "refresh"] as const;
export type MoveKind = (typeof MOVES)[number];

/** What GooseGuard did, or was told, for one account: every event it emits indexed by the account. */
export type AgentEvent =
  | { kind: "job-on"; job: AgentJob; end: number }
  | { kind: "job-off"; job: AgentJob }
  | { kind: "saved"; amountRaw: bigint }
  | { kind: "repaid"; amountRaw: bigint; hfBefore: bigint; hfAfter: bigint }
  | { kind: "sold"; sharesRaw: readonly bigint[]; repaidRaw: bigint; hfBefore: bigint; hfAfter: bigint }
  | { kind: "refreshed"; hfBefore: bigint; hfAfter: bigint }
  | { kind: "rescue-ended" }
  | { kind: "keep-mix"; on: boolean }
  | { kind: "mix"; weightsBps: readonly number[] }
  | { kind: "rebalanced"; soldRaw: readonly bigint[]; boughtRaw: readonly bigint[] }
  | { kind: "top-ups-set"; on: boolean; keepRaw: bigint }
  | { kind: "top-up-invested"; amountRaw: bigint; boughtRaw: readonly bigint[] }
  | { kind: "converted"; coin: Address; amountInRaw: bigint; usdcOutRaw: bigint }
  /** A move the Guard refused, and why: its error's selector, or the inner revert's (0 for none). Retried next round. */
  | { kind: "refused"; move: MoveKind; reason: Hex }
  /** Protect's own line and target, set by the account (`setProtect`, decision 3), as health factors. No row. */
  | { kind: "lines-set"; line: number; target: number };

/** One decoded event, where it sits on the chain. Health factors are WAD; amounts are raw units. */
export type AgentLog = AgentEvent & { key: string; blockNumber: bigint; logIndex: number; txHash: Hex };

type EventName = ContractEventName<typeof guardAbi>;
type Args<N extends EventName> = Extract<
  ParseEventLogsReturnType<typeof guardAbi, N, true>[number],
  { eventName: N }
>["args"];

const job = (id: number): AgentJob | null => JOBS[id] ?? null;

/**
 * What each Guard event means for one account, by name. The keys are every event in the ABI, so a new event can't be
 * missed: the ones about the Guard itself (pause, delayed changes) belong to no account and map to null, and so do the
 * settings the app has no screen for yet (the user's own Protect line, the user's own runner).
 */
const DECODE: { [N in EventName]: (a: Args<N>) => AgentEvent | null } = {
  JobOn: (a) => {
    const j = job(a.job);
    return j && { kind: "job-on", job: j, end: a.end };
  },
  // Only the account itself switches a job off (`unregister`): the user's own turn-off.
  JobOff: (a) => {
    const j = job(a.job);
    return j && { kind: "job-off", job: j };
  },
  Saved: (a) => ({ kind: "saved", amountRaw: a.amount }),
  // From the wallet first, then from savings (M2): both are the cash (D15).
  ProtectRepaid: (a) => ({
    kind: "repaid",
    amountRaw: a.fromWallet + a.fromSavings,
    hfBefore: a.hfBefore,
    hfAfter: a.hfAfter,
  }),
  ProtectSold: (a) => ({
    kind: "sold",
    sharesRaw: a.shares,
    repaidRaw: a.repaid,
    hfBefore: a.hfBefore,
    hfAfter: a.hfAfter,
  }),
  ConfigRefreshed: (a) => ({ kind: "refreshed", hfBefore: a.hfBefore, hfAfter: a.hfAfter }),
  RescueEnded: () => ({ kind: "rescue-ended" }),
  KeepMixSet: (a) => ({ kind: "keep-mix", on: a.on }),
  MixSet: (a) => ({ kind: "mix", weightsBps: unpackMix(a.mix) }),
  Rebalanced: (a) => ({ kind: "rebalanced", soldRaw: a.sold, boughtRaw: a.bought }),
  EntryConverted: (a) => ({ kind: "converted", coin: a.coin, amountInRaw: a.amountIn, usdcOutRaw: a.usdcOut }),
  TopUpsSet: (a) => ({ kind: "top-ups-set", on: a.on, keepRaw: BigInt(a.keep) }),
  TopUpInvested: (a) => ({ kind: "top-up-invested", amountRaw: a.amount, boughtRaw: a.bought }),
  Refused: (a) => {
    const move = MOVES[a.kind];
    return move ? { kind: "refused", move, reason: a.reason } : null;
  },
  // (0, 0) puts the account back on the defaults.
  ProtectSet: (a) => ({
    kind: "lines-set",
    ...(a.line === 0 && a.target === 0 ? DEFAULT_PROTECT : { line: a.line / 1e4, target: a.target / 1e4 }),
  }),
  RunnerSet: () => null,
  Paused: () => null,
  ChangeQueued: () => null,
  ChangeApplied: () => null,
  ChangeCancelled: () => null,
  RunnerRemoved: () => null,
};

/**
 * One account's agent history from GooseGuard's logs (no indexer, D12: every event about an account is indexed by it).
 * Logs from any other contract are ignored, so nothing can pose as the Guard, and so are events about another account
 * or about the Guard itself. Oldest first, as the chain has them.
 */
export function decodeAgentLogs(logs: readonly Log[], guard: Address, account: Address): AgentLog[] {
  const ours = logs.filter((l) => isAddressEqual(l.address, guard));
  return parseEventLogs({ abi: guardAbi, logs: ours }).flatMap((l) => {
    const args = l.args as Record<string, unknown>;
    if (typeof args.account !== "string" || !isAddressEqual(args.account as Address, account)) return [];
    const event = (DECODE[l.eventName] as (a: unknown) => AgentEvent | null)(l.args);
    if (!event || l.blockNumber === null || l.logIndex === null || l.transactionHash === null) return [];
    return [
      {
        ...event,
        key: `${l.transactionHash}:${l.logIndex}`,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        txHash: l.transactionHash,
      },
    ];
  });
}
