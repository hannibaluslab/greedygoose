"use client";

import { useCallback, useRef, useState } from "react";
import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { ComingSoon } from "@/components/gg/Agents";
import { TxButton, TxError } from "@/components/gg/TxUi";
import { MixCard } from "./MixCard";
import { TopUpsCard } from "./TopUpsCard";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useManageSave, type MixSave } from "@/hooks/useManageSave";
import { usePosition } from "@/hooks/usePosition";
import { useTopUps } from "@/hooks/useTopUps";
import { usePrepare, type TxPhase, type TxPlan, type TxPrep } from "@/hooks/useTx";
import { aprToApy } from "@/lib/aave/math";
import { AGENTS_LIVE } from "@/lib/agents/config";
import { mixWeights, startingMix, type MixHolding, type MixRow } from "@/lib/agents/mix";
import { stockLimitsRaw } from "@/lib/agents/permissions";
import { rebalanceSave, savedText, type RebalanceTerms, type SavePlan } from "@/lib/agents/rebalanceSettings";
import {
  TOP_UPS_NOT_YET,
  chainFacts,
  choiceFrom,
  settingFrom,
  topUpsView,
  type TopUpsChoice,
  type TopUpsFacts,
  type TopUpsSetting,
} from "@/lib/agents/topUps";
import { rateText } from "@/lib/cashSetup";

/**
 * The Rebalancer's settings, the body of its sheet (boards 7e–7h): My mix and Top-ups go into my mix, then Save, which
 * shows only when something changed. It has no amount limit (decision 9), with no field to type. While it's off, saving
 * turns it on. Everything comes from hooks, so it drops into the sheet with `<RebalanceSettings account={account} />`.
 * Saving is one batch, one Face ID (useManageSave, useAgents `changePlan`): the mix when it changed and a new grant
 * when one is needed, approved and registered, with the grant it replaces revoked. The body prepares it in render, so
 * the tap opens JAW's sheet with nothing awaited first. Without a Guard it renders live data and saves nothing.
 * Top-ups are read on Base (useTopUps): with no Guard the switch says "Not available yet."; turning them on puts the
 * wallet's cash into savings first and then `setTopUps` in Save's batch, with earning's grant when it's off. Switching
 * them takes no new Rebalancer grant.
 */
export function RebalanceSettings({ account, onDone }: { account: `0x${string}`; onDone?: () => void }) {
  const { data } = usePosition(account);
  const agents = useAgents(account);
  const settings = useAgentSettings(account);
  const { address, isConnected } = useAccount();
  const fee = useFeeSupport();
  const topUps = chainFacts(useTopUps(account));
  // What the toast says once the Save lands, taken at the tap (`savedText`): the reads after it no longer know.
  const said = useRef("Saved");
  const onSaved = useCallback(() => {
    toast.success(said.current);
    onDone?.();
  }, [onDone]);
  const saving = useManageSave(account, agents, onSaved);
  const configured = AGENTS_LIVE;
  const status = agents.status.rebalance;
  const running = status === "on" || status === "starting";
  /**
   * What a Save sends: the mix when it changed, top-ups when they changed (`setTopUps`, and turning them on saves the
   * wallet's cash first), and a new grant when needed, which may sell each stock in the mix.
   */
  const toSave = ({ weights, plan, topUps: chosen }: SaveRequest): MixSave => ({
    weights,
    mixChanged: plan.mixChanged,
    topUps: chosen,
    topUpsChanged: plan.topUpsChanged,
    topUpsTurningOn: !!chosen?.on && topUps.saved?.on === false,
    grant: plan.needsGrant ? { job: "rebalance", limitsRaw: stockLimitsRaw(weights.map((w) => w > 0)) } : null,
  });

  if (!data || (configured && (!settings || status === "loading"))) return <RebalanceSettingsSkeleton />;
  const holdings = data.holdings;
  return (
    <RebalanceSettingsView
      holdings={holdings}
      saved={settings?.mixBps ?? null}
      terms={agents.terms.rebalance}
      configured={configured}
      connected={isConnected}
      preview={!address || !isAddressEqual(address, account)}
      running={running}
      earningOff={agents.status.save === "off"}
      topUps={{
        ...topUps,
        // Top-ups go in only while Rebalance runs: stopped, or still to finish, no note says when they go in.
        waiting: status === "on" ? topUps.waiting : null,
        rate: rateText(aprToApy(data.savingsApr)),
        debtUsd: data.debtUsd,
        protectSells: agents.status.sell === "on",
      }}
      feeBlocked={isConnected && fee.state === "unsupported"}
      feeLoading={fee.loading}
      busy={saving.busy}
      phase={saving.phase}
      error={saving.error}
      prep={saving.prep}
      planFor={(r) => saving.planFor(toSave(r))}
      onSave={(r) => {
        said.current = savedText(r.plan, running);
        saving.save(toSave(r));
      }}
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
 * What Save asks for: the mix, the plan, and top-ups as chosen (null until the Guard's setting is read): `setTopUps`
 * when `plan.topUpsChanged`.
 */
type SaveRequest = { weights: number[]; plan: SavePlan; topUps: TopUpsSetting | null };

/** Before the account's numbers are in (the gallery's not-live state): nothing owed, no rate yet. */
const NO_TOP_UPS: TopUpsFacts = { ...TOP_UPS_NOT_YET, rate: null, debtUsd: 0, protectSells: false };

/** The settings drawn from plain values, so the dev gallery can show each state. */
export function RebalanceSettingsView({
  holdings,
  saved,
  terms,
  configured,
  connected,
  preview = !connected,
  running,
  earningOff = false,
  topUps = NO_TOP_UPS,
  feeBlocked,
  feeLoading,
  busy,
  phase,
  error,
  prep,
  planFor,
  onSave,
  draft,
  draftTopUps,
}: {
  holdings: readonly SettingsHolding[];
  /** The registry's mix, BPS by reserve id (all 0 before one is saved); null before it is read. */
  saved: readonly number[] | null;
  terms: RebalanceTerms;
  configured: boolean;
  connected: boolean;
  /** Not signed in as this account (the dev preview): nothing signs. */
  preview?: boolean;
  running: boolean;
  /** Earning (the Save job) is off: turning top-ups on grants it in the same batch, and the allows line says so. */
  earningOff?: boolean;
  /** Top-ups go into my mix: the Guard's side and the account's numbers its card reads. */
  topUps?: TopUpsFacts;
  feeBlocked: boolean;
  feeLoading: boolean;
  busy: boolean;
  phase: TxPhase;
  error: string | null;
  /** The write's store (useManageSave's `prep`) and the Save's one batch, so it's ready before the tap. */
  prep?: TxPrep;
  planFor?: (r: SaveRequest) => TxPlan | null;
  onSave: (r: SaveRequest) => void;
  /** Opens on an edit (the dev gallery's states). */
  draft?: MixRow[];
  draftTopUps?: TopUpsChoice;
}) {
  const [edited, setEdited] = useState<MixRow[] | null>(draft ?? null);
  const [chosen, setChosen] = useState<TopUpsChoice | null>(draftTopUps ?? null);

  const rows = edited ?? startingMix(holdings, saved);
  const weights = mixWeights(rows);
  // Top-ups on screen: what the Guard has, until the user changes it.
  const choice = chosen ?? choiceFrom(topUps.saved);
  const topUpsSetting = settingFrom(topUps.saved, choice);

  const plan = rebalanceSave({
    configured,
    connected,
    saved,
    weights,
    terms,
    running,
    topUps: { saved: topUps.saved, chosen: choice },
    earningOff,
    waitingUsd: topUps.waiting?.usd ?? null,
    feeBlocked,
    feeLoading,
    busy,
  });
  // Save's one batch (the settings that changed and any new grant) is prepared while the body is idle, so the tap opens
  // JAW's sheet with nothing awaited first.
  const request: SaveRequest = { weights, plan, topUps: topUpsSetting };
  const prepared = usePrepare(prep, plan.canSave && !preview && planFor ? planFor(request) : null);

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
          // "Turn on" while it's off and saving grants it, which switches it on; switching top-ups off alone is a Save.
          action={running || !plan.needsGrant ? "Save" : "Turn on"}
          phase={phase}
          error={error ?? prepared.error}
          checking={prepared.checking}
          disabled={!plan.canSave || busy || prepared.blocked}
          preview={preview}
          onClick={() => onSave(request)}
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
 * Save at the foot of the sheet, only when something changed (`plan.steps` > 0): one batch, one Face ID, whatever it
 * carries. Above it, what a new grant lets Rebalance do (`plan.allows`: JAW's batch sheet shows no words of ours), a
 * waiting top-up the Save leaves as cash (`plan.keeps`), and the last write's error.
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
      {plan.allows && plan.steps > 0 && <p className="m-0 px-1 text-[13px] leading-[1.4] text-ink-2">{plan.allows}</p>}
      {plan.keeps && <p className="m-0 px-1 text-[13px] leading-[1.4] text-ink-2">{plan.keeps}</p>}
      <TxError error={error} />
      {plan.steps > 0 && (
        <TxButton
          label={action}
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
