"use client";

import { useCallback, useState } from "react";
import { isAddressEqual, maxUint160 } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { ComingSoon } from "@/components/gg/Agents";
import { TxButton, TxError } from "@/components/gg/TxUi";
import { MixCard } from "./MixCard";
import { TopUpsCard } from "./TopUpsCard";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useManageSave } from "@/hooks/useManageSave";
import { useNowSec } from "@/hooks/useNowSec";
import { usePosition } from "@/hooks/usePosition";
import { usePrepare, type TxPhase, type TxPlan, type TxPrep } from "@/hooks/useTx";
import { aprToApy } from "@/lib/aave/math";
import { AGENTS_LIVE } from "@/lib/agents/config";
import { mixWeights, startingMix, type MixHolding, type MixRow } from "@/lib/agents/mix";
import { stockLimitsRaw } from "@/lib/agents/permissions";
import { rebalanceSave, type RebalanceTerms, type SavePlan } from "@/lib/agents/rebalanceSettings";
import {
  TOP_UPS_NOT_YET,
  choiceFrom,
  settingFrom,
  topUpsView,
  type TopUpsChoice,
  type TopUpsFacts,
  type TopUpsSetting,
} from "@/lib/agents/topUps";
import { rateText } from "@/lib/cashSetup";
import { EQUITIES } from "@/lib/tokens/registry";

/** Top-ups as the executor has them (useAgentSettings once it counts them, M5); until then not available. */
type TopUpsChain = Pick<TopUpsFacts, "available" | "earningFirst" | "saved" | "waiting">;

/**
 * The Rebalancer's settings, the body of its sheet (boards 7e–7h): My mix and Top-ups go into my mix, then Save, which
 * shows only when something changed. It has no amount limit: its grant is at the executor's CAP_MAX, with no field to
 * type. While it's off, saving turns it on. Everything comes from hooks, so it drops into the sheet with
 * `<RebalanceSettings account={account} />`.
 * Saving is a new grant on JAW's own screen when needed, then one batch with the settings and its registration, or the
 * settings alone through useTx (useManageSave). Without an executor it renders live data and saves nothing.
 * Top-ups wait for the executor that counts them (M4): until `topUps` says they're available, the switch says so.
 */
export function RebalanceSettings({
  account,
  onDone,
  topUps = TOP_UPS_NOT_YET,
}: {
  account: `0x${string}`;
  onDone?: () => void;
  topUps?: TopUpsChain;
}) {
  const { data } = usePosition(account);
  const agents = useAgents(account);
  const settings = useAgentSettings(account);
  const { address, isConnected } = useAccount();
  const fee = useFeeSupport();
  const nowSec = useNowSec();
  const onSaved = useCallback(() => {
    toast.success("Your mix is saved");
    onDone?.();
  }, [onDone]);
  const saving = useManageSave(account, agents, onSaved);
  const configured = AGENTS_LIVE;
  const status = agents.status.rebalance;

  if (!data || (configured && (!settings || status === "loading"))) return <RebalanceSettingsSkeleton />;
  const holdings = data.holdings;
  return (
    <RebalanceSettingsView
      holdings={holdings}
      saved={settings?.mixBps ?? null}
      terms={agents.terms.rebalance}
      capMaxRaw={agents.capMaxRaw}
      configured={configured}
      connected={isConnected}
      preview={!address || !isAddressEqual(address, account)}
      running={status === "on" || status === "starting"}
      topUps={{
        ...topUps,
        rate: rateText(aprToApy(data.savingsApr)),
        debtUsd: data.debtUsd,
        protectSells: agents.status.sell === "on",
        nowSec,
      }}
      feeBlocked={isConnected && fee.state === "unsupported"}
      feeLoading={fee.loading}
      busy={agents.busy || saving.busy}
      waiting={saving.registering}
      phase={saving.phase}
      error={saving.error}
      prep={saving.prep}
      settingPlan={saving.settingPlan}
      // M5 passes `topUps` on: setTopUps in the batch when it changed, and the grant's withdraw while it's on.
      onSave={({ weights, capRaw, plan }) =>
        saving.save({
          weights,
          mixChanged: plan.mixChanged,
          grant: plan.needsGrant
            ? {
                job: "rebalance",
                capRaw,
                limitsRaw: stockLimitsRaw(
                  capRaw,
                  agents.capMaxRaw!,
                  EQUITIES.map((e) => holdings[e.reserveId].priceRaw),
                  weights.map((w) => w > 0),
                ),
              }
            : null,
        })
      }
    />
  );
}

/** Until the reads are in. */
function RebalanceSettingsSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-3">
      <div className="h-[260px] animate-pulse rounded-[22px] bg-chip" />
      <div className="h-[72px] animate-pulse rounded-[22px] bg-chip" />
    </div>
  );
}

/** A stock as the settings see it: the mix's free shares at Aave's price, and what backs credit. */
export type SettingsHolding = MixHolding & { backingUsd: number };

/**
 * What Save asks for: the mix, the grant's cap, the plan, and top-ups as chosen (null until the executor counts them):
 * `setTopUps` when `plan.topUpsChanged`, and the grant carries the savings withdraw while `on`.
 */
type SaveRequest = { weights: number[]; capRaw: bigint; plan: SavePlan; topUps: TopUpsSetting | null };

/** Before the account's numbers are in (the gallery's not-live state): nothing owed, no rate yet. */
const NO_TOP_UPS: TopUpsFacts = { ...TOP_UPS_NOT_YET, rate: null, debtUsd: 0, protectSells: false, nowSec: 0 };

/** The settings drawn from plain values, so the dev gallery can show each state. */
export function RebalanceSettingsView({
  holdings,
  saved,
  terms,
  capMaxRaw,
  configured,
  connected,
  preview = !connected,
  running,
  topUps = NO_TOP_UPS,
  feeBlocked,
  feeLoading,
  busy,
  waiting = false,
  phase,
  error,
  prep,
  settingPlan,
  onSave,
  draft,
  draftTopUps,
}: {
  holdings: readonly SettingsHolding[];
  /** The registry's mix, BPS by reserve id (all 0 before one is saved); null before it is read. */
  saved: readonly number[] | null;
  terms: RebalanceTerms;
  capMaxRaw: bigint | null;
  configured: boolean;
  connected: boolean;
  /** Not signed in as this account (the dev preview): nothing signs. */
  preview?: boolean;
  running: boolean;
  /** Top-ups go into my mix: the executor's side and the account's numbers its card reads. */
  topUps?: TopUpsFacts;
  feeBlocked: boolean;
  feeLoading: boolean;
  busy: boolean;
  /** This sheet's grant waits for its batch: Save sends it (useManageSave `registering`). */
  waiting?: boolean;
  phase: TxPhase;
  error: string | null;
  /**
   * The write's store (useManageSave's `prep`) and the settings batch, so Save's batch is ready before the tap: the mix,
   * and top-ups when they changed (null otherwise).
   */
  prep?: TxPrep;
  settingPlan?: (weights: readonly number[], topUps: TopUpsSetting | null) => TxPlan | null;
  onSave: (r: SaveRequest) => void;
  /** Opens on an edit (the dev gallery's states). */
  draft?: MixRow[];
  draftTopUps?: TopUpsChoice;
}) {
  const [edited, setEdited] = useState<MixRow[] | null>(draft ?? null);
  const [chosen, setChosen] = useState<TopUpsChoice | null>(draftTopUps ?? null);

  const rows = edited ?? startingMix(holdings, saved);
  const weights = mixWeights(rows);
  // Top-ups on screen: what the executor has, until the user changes it.
  const choice = chosen ?? choiceFrom(topUps.saved);
  const topUpsSetting = settingFrom(topUps.saved, choice);

  // No amount limit: the grant is at the executor's CAP_MAX. Until it's read nothing saves (rebalanceSave).
  const capRaw = capMaxRaw ?? maxUint160;
  const plan = rebalanceSave({
    configured,
    connected,
    saved,
    weights,
    terms,
    capMaxRaw,
    running,
    waiting,
    topUps: { saved: topUps.saved, chosen: choice },
    feeBlocked,
    feeLoading,
    busy,
  });
  // Save's only JAW sheet is the settings when they changed and nothing is granted or waiting (else they ride in the
  // batch after the grant): their batch is prepared while the body is idle, so the tap opens it. Top-ups ride in it
  // only when they changed.
  const settingsAlone = (plan.mixChanged || plan.topUpsChanged) && !plan.needsGrant && !waiting;
  const prepared = usePrepare(
    prep,
    plan.canSave && !preview && settingsAlone && settingPlan
      ? settingPlan(weights, plan.topUpsChanged ? topUpsSetting : null)
      : null,
  );

  return (
    <div className="flex flex-col gap-3 leading-[normal]">
      <MixCard holdings={holdings} rows={rows} onRows={setEdited} />
      <TopUpsCard
        view={topUpsView({ ...topUps, ...choice })}
        on={choice.on}
        keepUsd={choice.keepUsd}
        busy={busy}
        onToggle={(on) => setChosen({ ...choice, on })}
        onKeep={(keepUsd) => setChosen({ ...choice, keepUsd })}
      />
      {configured ? (
        <SaveArea
          plan={plan}
          // "Turn on" while it's off: saving switches it on.
          action={running ? "Save" : "Turn on"}
          phase={phase}
          error={error ?? prepared.error}
          checking={prepared.checking}
          disabled={!plan.canSave || busy || prepared.blocked}
          preview={preview}
          onClick={() => onSave({ weights, capRaw, plan, topUps: topUpsSetting })}
        />
      ) : (
        // Ruling 22: no Save while the agents aren't live.
        <div className="flex justify-center pt-1">
          <ComingSoon />
        </div>
      )}
    </div>
  );
}

/**
 * Save at the foot of the sheet, only when something changed (`plan.steps` > 0), with "· 2 steps" in it when a new
 * grant opens JAW's sheet twice (board 7f); the last write's error above it.
 */
function SaveArea({
  plan,
  action,
  phase,
  error,
  checking,
  disabled,
  preview,
  onClick,
}: {
  plan: SavePlan;
  action: string;
  phase: TxPhase;
  error: string | null;
  checking: boolean;
  disabled: boolean;
  preview: boolean;
  onClick: () => void;
}) {
  if (plan.steps === 0 && !error) return null;
  return (
    <div className="flex flex-col gap-2 pt-1">
      <TxError error={error} />
      {plan.steps > 0 && (
        <TxButton
          label={plan.steps > 1 ? `${action} · ${plan.steps} steps` : action}
          phase={phase}
          checking={checking}
          note={plan.note}
          disabled={disabled}
          preview={preview}
          onClick={onClick}
        />
      )}
    </div>
  );
}
