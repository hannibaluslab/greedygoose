/**
 * The app's own bytes for Rebalance's top-ups, for the GooseGuard fork tests: the fork runs exactly the batch this
 * TypeScript builds, the way the sheet builds it (rebalanceSave, then what RebalanceSettings asks useManageSave for,
 * rebalanceChange, with the wallet's cash saved first when top-ups turn on), granted the way useAgents `changePlan`
 * grants (jobGrant, jawPermission) and put together by agentChangePlan with the allowlist. Nothing is signed or sent.
 * Forge calls it through vm.ffi with NEXT_PUBLIC_GOOSE_GUARD set to the fork's GooseGuard; it prints
 * abi.encode(calls, grants) on stdout.
 *
 *   on  account start salt save walletRaw   Save on Rebalance's sheet: a 50/50 Apple/NVIDIA mix, top-ups on with Keep
 *                                           $500, the wallet's cash saved first, earning's grant too while `save` is
 *                                           "off" (P3)
 *   off account start salt                  Turn off Rebalance: its grant revoked and unregistered, top-ups off (Keep
 *                                           kept)
 *
 * `start` and `salt` stand in for lib/agents/picks.ts (the earlier of the device's clock and Base's, less five minutes,
 * and 256 random bits); the Rebalancer's grant takes `salt`, earning's `salt + 1`.
 */
import { encodeAbiParameters, type Address, type Hex } from "viem";
import { contractPermission, jawPermission } from "@/lib/agents/oneTapGrant";
import { GRANT_SECONDS, jobGrant, stockLimitsRaw, type AgentJob, type StockLimits } from "@/lib/agents/permissions";
import { rebalanceChange, rebalanceSave, type MixSave } from "@/lib/agents/rebalanceSettings";
import { buildUnregisterCalls, encodePermission } from "@/lib/agents/register";
import { buildSetTopUpsCalls } from "@/lib/agents/settings";
import { keepRawOf } from "@/lib/agents/topUps";
import { startEarningPlan, startEarningPrefix } from "@/lib/startEarning";
import { agentChangePlan } from "@/lib/tx/plans";
import type { Call } from "@/lib/aave/tx";

const [mode, account, startArg, saltArg, saveArg, walletArg] = process.argv.slice(2) as [
  "on" | "off",
  Address,
  string,
  string,
  string | undefined,
  string | undefined,
];
const guard = process.env.NEXT_PUBLIC_GOOSE_GUARD as Address;
const start = Number(startArg);
const salt = BigInt(saltArg);
/** Apple 50%, NVIDIA 50%, by reserve id. */
const WEIGHTS = [5_000, 0, 0, 0, 0, 5_000, 0];
const KEEP_USD = 500;

/** The Rebalancer's grant for the mix: it may sell each stock in it, with no limit (RebalanceSettings `toSave`). */
const rebalanceAsk = { job: "rebalance" as const, limitsRaw: stockLimitsRaw(WEIGHTS.map((w) => w > 0)) };

/** A grant as `changePlan` builds it: the job's template, a year from the pick. */
const grantOf = (g: { job: AgentJob; limitsRaw?: StockLimits }, i: number) =>
  jawPermission(account, guard, start + GRANT_SECONDS, jobGrant(g.job, g.limitsRaw), {
    start,
    salt: salt + BigInt(i),
  });

async function batch(): Promise<{ calls: Call[]; grants: ReturnType<typeof grantOf>[] }> {
  // The fork account is deployed: getCode answers with code, as on Base.
  const deps = { getCode: () => Promise.resolve("0x6001" as Hex), ownerCalls: () => Promise.resolve([]) };
  if (mode === "off") {
    const held = grantOf(rebalanceAsk, 0);
    const settings = [
      ...buildSetTopUpsCalls(account, false, keepRawOf(KEEP_USD)),
      ...buildUnregisterCalls(account, ["rebalance"]),
    ];
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
    topUpsTurningOn: true,
    grant: rebalanceAsk,
  };
  const change = rebalanceChange(account, save, { save: saveArg === "off" ? "off" : "on" });
  if (!change) throw new Error("No change");
  const grants = change.grants.map(grantOf);
  // Turning top-ups on saves the wallet's cash first (useManageSave), read again as the card read it.
  const walletRaw = BigInt(walletArg ?? "0");
  const supply = startEarningPlan(account, walletRaw, () => Promise.resolve(walletRaw));
  const prefix = supply ? startEarningPrefix(supply) : undefined;
  const tx = agentChangePlan(account, { grants, settings: change.settings, prefix }, deps);
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
