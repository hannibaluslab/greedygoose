import { isAddressEqual, parseEventLogs, type Address, type ContractEventName, type Hex, type Log, type ParseEventLogsReturnType } from "viem";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { JOBS, type AgentJob } from "@/lib/agents/permissions";

/** GooseExecutor's OffReason, in order: why a job was switched off. */
export const OFF_REASONS = ["revoked", "expired", "not-owner", "stuck"] as const;
export type OffReason = (typeof OFF_REASONS)[number];

/** CashRules' ProtectCase: of its seven cases only Watch (5) and WeekendShield (6) repay. */
const WEEKEND_SHIELD = 6;

/** What GooseExecutor did, or was told, for one account: every event it emits indexed by the account. */
export type AgentEvent =
  | { kind: "job-on"; job: AgentJob; capRaw: bigint; end: number }
  | { kind: "job-off"; job: AgentJob; reason: OffReason }
  | { kind: "saved"; amountRaw: bigint }
  | { kind: "repaid"; amountRaw: bigint; hfBefore: bigint; hfAfter: bigint; reason: "watch" | "weekend" }
  | { kind: "heads-up"; hf: bigint; sellValueRaw: bigint; sellAfter: number }
  | { kind: "heads-up-cleared"; hf: bigint }
  | { kind: "sold"; sharesRaw: readonly bigint[]; repaidRaw: bigint; hfBefore: bigint; hfAfter: bigint; atOnce: boolean }
  | { kind: "keep-mix"; on: boolean }
  | { kind: "mix"; weightsBps: readonly number[] }
  | { kind: "rebalanced"; soldRaw: readonly bigint[]; boughtRaw: readonly bigint[] }
  | { kind: "rebalance-skipped" }
  | { kind: "converted"; coin: Address; amountInRaw: bigint; usdcOutRaw: bigint }
  | { kind: "entry-waiting"; coin: Address; amountInRaw: bigint; retryAt: number }
  | { kind: "run-failed"; reason: Hex; fails: number }
  | { kind: "run-deferred" };

/** One decoded event, where it sits on the chain. Health factors are WAD; amounts are raw units. */
export type AgentLog = AgentEvent & { key: string; blockNumber: bigint; logIndex: number; txHash: Hex };

type EventName = ContractEventName<typeof gooseExecutorAbi>;
type Args<N extends EventName> = Extract<ParseEventLogsReturnType<typeof gooseExecutorAbi, N, true>[number], { eventName: N }>["args"];

const job = (id: number): AgentJob | null => JOBS[id] ?? null;

/**
 * What each executor event means for one account, by name. The keys are every event in the ABI, so a new event can't
 * be missed: the ones about the executor itself (pause, forwarders, delayed changes, pages, holidays) belong to no
 * account and map to null.
 */
const DECODE: { [N in EventName]: (a: Args<N>) => AgentEvent | null } = {
  JobOn: (a) => {
    const j = job(a.job);
    return j && { kind: "job-on", job: j, capRaw: a.cap, end: a.end };
  },
  JobOff: (a) => {
    const j = job(a.job);
    const reason = OFF_REASONS[a.reason];
    return j && reason ? { kind: "job-off", job: j, reason } : null;
  },
  Saved: (a) => ({ kind: "saved", amountRaw: a.amount }),
  ProtectRepaid: (a) => ({
    kind: "repaid",
    amountRaw: a.amount,
    hfBefore: a.hfBefore,
    hfAfter: a.hfAfter,
    reason: a.reason === WEEKEND_SHIELD ? "weekend" : "watch",
  }),
  SellHeadsUp: (a) => ({ kind: "heads-up", hf: a.hf, sellValueRaw: a.sellValue, sellAfter: a.sellAfter }),
  SellHeadsUpCleared: (a) => ({ kind: "heads-up-cleared", hf: a.hf }),
  ProtectSold: (a) => ({ kind: "sold", sharesRaw: a.shares, repaidRaw: a.repaid, hfBefore: a.hfBefore, hfAfter: a.hfAfter, atOnce: a.atOnce }),
  KeepMixSet: (a) => ({ kind: "keep-mix", on: a.on }),
  MixSet: (a) => ({ kind: "mix", weightsBps: a.weights }),
  Rebalanced: (a) => ({ kind: "rebalanced", soldRaw: a.sold, boughtRaw: a.bought }),
  RebalanceSkipped: () => ({ kind: "rebalance-skipped" }),
  EntryConverted: (a) => ({ kind: "converted", coin: a.coin, amountInRaw: a.amountIn, usdcOutRaw: a.usdcOut }),
  EntryWaiting: (a) => ({ kind: "entry-waiting", coin: a.coin, amountInRaw: a.amountIn, retryAt: a.retryAt }),
  RunFailed: (a) => ({ kind: "run-failed", reason: a.reason, fails: a.fails }),
  RunDeferred: () => ({ kind: "run-deferred" }),
  PageOpened: () => null,
  Paused: () => null,
  ForwarderSet: () => null,
  CodehashSet: () => null,
  OwnerSet: () => null,
  HolidaySet: () => null,
  ChangeQueued: () => null,
  ChangeApplied: () => null,
  ChangeCancelled: () => null,
};

/**
 * One account's agent history from GooseExecutor's logs (no indexer, D12: every event about an account is indexed
 * by it). Logs from any other contract are ignored, so nothing can pose as the executor, and so are events about
 * another account or about the executor itself. Oldest first, as the chain has them.
 */
export function decodeAgentLogs(logs: readonly Log[], executor: Address, account: Address): AgentLog[] {
  const ours = logs.filter((l) => isAddressEqual(l.address, executor));
  return parseEventLogs({ abi: gooseExecutorAbi, logs: ours }).flatMap((l) => {
    const args = l.args as Record<string, unknown>;
    if (typeof args.account !== "string" || !isAddressEqual(args.account as Address, account)) return [];
    const event = (DECODE[l.eventName] as (a: unknown) => AgentEvent | null)(l.args);
    if (!event || l.blockNumber === null || l.logIndex === null || l.transactionHash === null) return [];
    return [{ ...event, key: `${l.transactionHash}:${l.logIndex}`, blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash }];
  });
}
