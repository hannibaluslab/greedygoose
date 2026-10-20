"use client";

import { useState } from "react";
import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { ManageCard, SaveFooter } from "@/components/gg/Manage";
import { ComingSoon } from "@/components/gg/Agents";
import { Switch } from "@/components/gg/kit/Switch";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { usePosition } from "@/hooks/usePosition";
import { useProtectSave } from "@/hooks/useProtectSave";
import { usePrepare, type TxPhase, type TxPlan, type TxPrep } from "@/hooks/useTx";
import { AGENTS_LIVE } from "@/lib/agents/config";
import { PROTECT_LINE } from "@/lib/agents/list";
import {
  protectSteps,
  savedChoice,
  stepCount,
  withRegistration,
  type ProtectChoice,
  type ProtectSaved,
  type ProtectJob,
  type ProtectStep,
} from "@/lib/agents/protect";
import type { AgentStatus } from "@/lib/agents/status";
import { inWords } from "@/lib/formatting";
import { EQUITIES } from "@/lib/tokens/registry";
import { ORDER, SaveSummary, SellChoices, saveState } from "./ProtectSettingsParts";

const running = (s: AgentStatus) => s === "on" || s === "starting";

/**
 * Protect's settings, for the agent sheet's settings slot: repay from cash (always first), selling backing stock as its
 * own switch (Job.ProtectSell), what it sells first (`setKeepMix`) and the never-sell list (stocks left out of a new
 * sell grant). No limit to type (Adrian, 2026-10-19): both grants are at the executor's CAP_MAX. Everything comes from
 * the chain through the agents' hooks; saving opens JAW's sheet once a change (`useProtectSave`). Without an executor
 * it renders the real figures and saves nothing ("Not live yet").
 */
export function ProtectSettings({ account, onDone }: { account: `0x${string}`; onDone?: () => void }) {
  const { address } = useAccount();
  const { data } = usePosition(account);
  const agents = useAgents(account);
  const settings = useAgentSettings(account);
  const fee = useFeeSupport();
  const live = AGENTS_LIVE;
  const [round, setRound] = useState(0);
  const saving = useProtectSave(account, agents, () => {
    toast.success("Protect is saved");
    setRound((r) => r + 1); // the screen starts again from what the chain now says
    onDone?.();
  });

  if (
    !data ||
    (live &&
      (agents.status.protect === "loading" ||
        agents.status.sell === "loading" ||
        !settings ||
        agents.capMaxRaw === null))
  ) {
    return <ProtectSettingsSkeleton />;
  }
  const { protect, sell } = agents.terms;
  const saved: ProtectSaved = {
    repayOn: running(agents.status.protect) && !!protect,
    sell: running(agents.status.sell) && sell?.limitsRaw ? { limitsRaw: sell.limitsRaw } : null,
    keepMix: settings?.keepMix ?? null,
  };
  return (
    <ProtectSettingsView
      key={round}
      live={live}
      preview={!address || !isAddressEqual(address, account)}
      saved={saved}
      backsUsd={EQUITIES.map((e) =>
        data.holdings[e.reserveId].backingRaw > 0n ? data.holdings[e.reserveId].backingUsd : 0,
      )}
      pricesRaw={EQUITIES.map((e) => data.holdings[e.reserveId].priceRaw)}
      capMaxRaw={agents.capMaxRaw}
      // Turning selling off revokes each sell grant JAW lists that hasn’t ended (useAgents.turnOff): one JAW sheet each.
      sellGrants={agents.faceIdsOff(["sell"])}
      registering={saving.registering}
      feeBlocked={!!address && fee.state === "unsupported"}
      waiting={fee.loading || agents.busy}
      phase={saving.phase}
      error={saving.error}
      busy={saving.busy}
      prep={saving.prep}
      settingPlan={saving.settingPlan}
      onSave={saving.save}
    />
  );
}

function ProtectSettingsSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-3.5">
      <div className="h-[118px] animate-pulse rounded-[22px] bg-chip" />
      <div className="h-[58px] animate-pulse rounded-[22px] bg-chip" />
    </div>
  );
}

export type ProtectSettingsViewProps = {
  /** An executor is configured; without one nothing saves ("Not live yet"). */
  live: boolean;
  /** Not signed in as this account (the dev preview): nothing signs. */
  preview: boolean;
  saved: ProtectSaved;
  /** What each stock backs now, in dollars, by reserve id (0 = backs nothing). */
  backsUsd: readonly number[];
  /** Aave's prices by reserve id (8 decimals), for a sell grant's stock limits. */
  pricesRaw: readonly bigint[];
  /** The executor's CAP_MAX: every grant of Protect's is at it (no amount limit). */
  capMaxRaw: bigint | null;
  /** Sell grants JAW lists that haven’t ended: one JAW sheet each to switch selling off. */
  sellGrants: number;
  /** This sheet's grants waiting for a batch that didn't go through: Save sends it (useProtectSave `registering`). */
  registering?: readonly ProtectJob[];
  feeBlocked: boolean;
  /** Something still loading or signing elsewhere (fee support, an agent switch). */
  waiting?: boolean;
  phase: TxPhase;
  error: string | null;
  busy: boolean;
  /** The write's store (useProtectSave's `prep`) and "Sells first"'s batch, so Save's first sheet is ready before the tap. */
  prep?: TxPrep;
  settingPlan?: (on: boolean) => TxPlan | null;
  onSave: (steps: ProtectStep[]) => void;
};

/** The settings drawn from plain values, so the dev gallery can show each state. */
export function ProtectSettingsView({
  live,
  preview,
  saved,
  backsUsd,
  pricesRaw,
  capMaxRaw,
  sellGrants,
  registering = [],
  feeBlocked,
  waiting = false,
  phase,
  error,
  busy,
  prep,
  settingPlan,
  onSave,
}: ProtectSettingsViewProps) {
  const [chosen, setChosen] = useState<Partial<ProtectChoice>>({});
  const start = savedChoice(saved);
  const choice: ProtectChoice = { ...start, ...chosen };
  const set = (c: Partial<ProtectChoice>) => setChosen((p) => ({ ...p, ...c }));

  // Until CAP_MAX is read nothing can save (`ready` below), so the steps only say what's blocked.
  const plan = protectSteps(saved, choice, { capMaxRaw: capMaxRaw ?? 0n, pricesRaw });
  const steps = live ? plan.steps : [];
  const count = stepCount(steps, sellGrants, registering);
  const names = (ids: readonly number[]) =>
    inWords(EQUITIES.filter((e) => ids.includes(e.reserveId)).map((e) => e.name));

  // While repaying from cash is off, saving switches Protect on (protectSteps).
  const off = !saved.repayOn;
  const { canSave, note } = saveState({
    live,
    ready: !preview && !waiting && !busy && capMaxRaw !== null,
    feeBlocked,
    blocked: plan.blocked,
    // A batch this sheet still owes counts as something to save: Save sends it.
    changes: withRegistration(steps, registering).length,
  });
  // Save's first JAW sheet is "Sells first" when it changed and nothing is granted (else it rides in the last batch): its
  // batch is prepared while the body is idle.
  const first = withRegistration(steps, registering)[0];
  const prepared = usePrepare(prep, canSave && first?.kind === "keepMix" && settingPlan ? settingPlan(first.on) : null);

  const neverChanged = choice.never.length !== start.never.length || choice.never.some((r) => !start.never.includes(r));
  const lines = steps.flatMap((s) => {
    if (s.kind === "keepMix") return [`Sells first: ${ORDER.find((o) => o.keepMix === s.on)!.label}`];
    if (s.kind === "revoke") return ["Selling: off"];
    if (s.kind === "register") return [];
    if (s.job === "protect") return ["Repay from your cash: on"];
    const never =
      !saved.sell || neverChanged ? [`Never sell: ${choice.never.length > 0 ? names(choice.never) : "none"}`] : [];
    return [...(saved.sell ? [] : ["Selling: on"]), ...never];
  });

  // The never-sell list: what backs the credit now, and anything already on the list.
  const listedStocks = EQUITIES.filter((e) => backsUsd[e.reserveId] > 0 || choice.never.includes(e.reserveId));
  const toggleNever = (reserveId: number, on: boolean) =>
    set({ never: on ? [...choice.never, reserveId] : choice.never.filter((r) => r !== reserveId) });

  return (
    <div className="flex flex-col gap-3.5 leading-[normal]">
      <ManageCard className="flex flex-col px-4 py-0.5">
        <div className="flex flex-col gap-0.5 py-[13px]">
          <span className="text-[15px] font-semibold">Repay from your cash</span>
          <span className="text-xs leading-[1.35] text-subtle">
            Only under {PROTECT_LINE}, and always first. Your cash pays before any stock is sold.
          </span>
        </div>
        <div className="flex items-center gap-3 border-t border-hairline py-[13px]">
          <div className="flex grow flex-col gap-0.5">
            <span className="text-[15px] font-semibold">Sell stock if cash isn’t enough</span>
            <span className="text-xs leading-[1.35] text-subtle">Only stock that backs your credit</span>
          </div>
          <Switch
            label="Sell stock if cash isn’t enough"
            checked={choice.sellOn}
            onChange={(on) => set({ sellOn: on })}
            disabled={!live}
          />
        </div>

        {choice.sellOn && (
          <SellChoices
            keepMix={choice.keepMix}
            onKeepMix={(keepMix) => set({ keepMix })}
            never={choice.never}
            onNever={toggleNever}
            listedStocks={listedStocks}
            backsUsd={backsUsd}
          />
        )}
      </ManageCard>

      {live && <SaveSummary off={off} lines={lines} />}

      {live ? (
        <SaveFooter
          label={off ? "Switch on" : "Save"}
          phase={phase}
          checking={prepared.checking}
          steps={count}
          disabled={!canSave || prepared.blocked}
          preview={preview}
          onSave={() => onSave(steps)}
          error={error ?? prepared.error}
          note={note}
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
