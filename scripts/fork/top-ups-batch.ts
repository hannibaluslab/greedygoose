/**
 * The app's own bytes for Rebalance's top-ups, for contracts/test/TopUpsAppFork.t.sol: the fork runs exactly the batch
 * this TypeScript builds, the way the sheet builds it (rebalanceSave, then what RebalanceSettings asks useManageSave
 * for, rebalanceChange), granted the way useAgents `changePlan` grants (jobGrant, jawPermission) and put together by
 * agentChangePlan with the allowlist. Nothing is signed or sent. Forge calls it through vm.ffi with
 * NEXT_PUBLIC_GOOSE_EXECUTOR set to the fork's executor; it prints abi.encode(calls, grants) on stdout.
 *
 *   on  account start salt capMax prices save   Save on Rebalance's sheet: a 50/50 Apple/NVIDIA mix, top-ups on with
 *                                                Keep $500, earning's grant too while `save` is "off" (P3)
 *   off account start salt capMax prices        Turn off Rebalance: its grant revoked, top-ups off (Keep kept)
 *
 * `start` and `salt` stand in for lib/agents/picks.ts (the device's clock less five minutes, and 256 random bits);
 * the Rebalancer's grant takes `salt`, earning's `salt + 1`. `prices` are Aave's, 8 decimals, comma-separated.
 */
import { encodeAbiParameters, type Address } from "viem";
import { contractPermission, jawPermission } from "@/lib/agents/oneTapGrant";
import { GRANT_SECONDS, jobGrant, stockLimitsRaw, type AgentJob, type StockLimits } from "@/lib/agents/permissions";
import { rebalanceChange, rebalanceSave, type MixSave } from "@/lib/agents/rebalanceSettings";
import { encodePermission } from "@/lib/agents/register";
import { buildSetTopUpsCalls } from "@/lib/agents/settings";
import { keepRawOf } from "@/lib/agents/topUps";
import { agentChangePlan } from "@/lib/tx/plans";
import type { Call } from "@/lib/aave/tx";

const [mode, account, startArg, saltArg, capMaxArg, pricesArg, saveArg] = process.argv.slice(2) as [
  "on" | "off",
  Address,
  string,
  string,
  string,
  string,
  string | undefined,
];
const executor = process.env.NEXT_PUBLIC_GOOSE_EXECUTOR as Address;
const start = Number(startArg);
const salt = BigInt(saltArg);
const capMaxRaw = BigInt(capMaxArg);
const prices = pricesArg.split(",").map(BigInt);
/** Apple 50%, NVIDIA 50%, by reserve id. */
const WEIGHTS = [5_000, 0, 0, 0, 0, 5_000, 0];
const KEEP_USD = 500;

/** The Rebalancer's grant at CAP_MAX for the mix, with its stock limits at Aave's price (RebalanceSettings `toSave`). */
const rebalanceAsk = (topUps: boolean) => ({
  job: "rebalance" as const,
  capRaw: capMaxRaw,
  limitsRaw: stockLimitsRaw(
    capMaxRaw,
    capMaxRaw,
    prices,
    WEIGHTS.map((w) => w > 0),
  ),
  topUps,
});

/** A grant as `changePlan` builds it: the job's template, a year from the pick. */
const grantOf = (g: { job: AgentJob; capRaw: bigint; limitsRaw?: StockLimits; topUps?: boolean }, i: number) =>
  jawPermission(account, executor, start + GRANT_SECONDS, jobGrant(g.job, g.capRaw, g.limitsRaw, g.topUps), {
    start,
    salt: salt + BigInt(i),
  });

async function batch(): Promise<{ calls: Call[]; grants: ReturnType<typeof grantOf>[] }> {
  const deps = { ownerCalls: () => Promise.resolve([]) };
  if (mode === "off") {
    const held = grantOf(rebalanceAsk(true), 0);
    const settings = buildSetTopUpsCalls(account, false, keepRawOf(KEEP_USD));
    const plan = agentChangePlan(account, { grants: [], revokes: [contractPermission(held)], settings }, deps);
    return { calls: await (plan.calls as () => Promise<Call[]>)(), grants: [held] };
  }
  // The sheet: no mix saved and Rebalance off; top-ups chosen on with Keep $500.
  const saved = { on: false, keepUsd: KEEP_USD };
  const chosen = { on: true, keepUsd: KEEP_USD };
  const plan = rebalanceSave({
    configured: true,
    connected: true,
    saved: WEIGHTS.map(() => 0),
    weights: WEIGHTS,
    terms: null,
    capMaxRaw,
    running: false,
    topUps: { saved, chosen },
    earningOff: saveArg === "off",
    feeBlocked: false,
    feeLoading: false,
    busy: false,
  });
  if (!plan.canSave || !plan.needsGrant || !plan.mixChanged || !plan.topUpsChanged) throw new Error("Nothing to save");
  const save: MixSave = {
    weights: WEIGHTS,
    mixChanged: plan.mixChanged,
    topUps: chosen,
    topUpsChanged: plan.topUpsChanged,
    grant: rebalanceAsk(true),
  };
  const change = rebalanceChange(account, save, { save: saveArg === "off" ? "off" : "on", capMaxRaw });
  if (!change) throw new Error("No change");
  const grants = change.grants.map(grantOf);
  const tx = agentChangePlan(account, { grants, settings: change.settings }, deps);
  return { calls: await (tx.calls as () => Promise<Call[]>)(), grants };
}

function print({ calls, grants }: Awaited<ReturnType<typeof batch>>) {
  process.stdout.write(
    encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
        },
        { type: "bytes[]" },
      ],
      [
        calls.map((c) => ({ target: c.to, value: c.value, data: c.data })),
        grants.map((g) => encodePermission(contractPermission(g))),
      ],
    ),
  );
}

batch().then(print, (e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
