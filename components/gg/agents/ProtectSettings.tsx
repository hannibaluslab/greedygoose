"use client";

import { useState } from "react";
import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { CardTitle, ManageCard, SaveFooter } from "@/components/gg/Manage";
import { ComingSoon } from "@/components/gg/Agents";
import { LimitField, neverMoreThan } from "@/components/gg/kit/LimitField";
import { Switch } from "@/components/gg/kit/Switch";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { usePosition } from "@/hooks/usePosition";
import { useProtectSave } from "@/hooks/useProtectSave";
import { usePrepare, type TxPhase, type TxPlan, type TxPrep } from "@/hooks/useTx";
import { AGENTS_LIVE } from "@/lib/agents/config";
import { limitRaw, testCapNote } from "@/lib/agents/permissions";
import {
  protectSteps,
  savedChoice,
  stepCount,
  type ProtectChoice,
  type ProtectSaved,
  type ProtectStep,
} from "@/lib/agents/protect";
import type { AgentStatus } from "@/lib/agents/status";
import { toUsd } from "@/lib/cash";
import { formatUsdTrim, inWords } from "@/lib/formatting";
import { EQUITIES } from "@/lib/tokens/registry";
import { LimitNotes, ORDER, SaveSummary, SellChoices, saveState } from "./ProtectSettingsParts";

const running = (s: AgentStatus) => s === "on" || s === "starting";

/**
 * Protect's settings, for the agent sheet's settings slot: repay from cash (always first) at a daily limit, selling
 * backing stock as its own switch (Job.ProtectSell), what it sells first (`setKeepMix`) and the never-sell list (stocks
 * left out of a new sell grant). Everything comes from the chain through the agents' hooks; saving opens JAW's sheet
 * once a change (`useProtectSave`). Without an executor it renders the real figures and saves nothing ("Not live yet").
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
    repayCapRaw: running(agents.status.protect) && protect ? protect.capRaw : null,
    sell: running(agents.status.sell) && sell?.limitsRaw ? { capRaw: sell.capRaw, limitsRaw: sell.limitsRaw } : null,
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
  capMaxRaw: bigint | null;
  /** Sell grants JAW lists that haven’t ended: one JAW sheet each to switch selling off. */
  sellGrants: number;
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
  // A Custom limit that isn't a number of dollars yet: nothing to save until it is.
  const [limitTyped, setLimitTyped] = useState(true);
  const start = savedChoice(saved);
  const choice: ProtectChoice = { ...start, ...chosen };
  const set = (c: Partial<ProtectChoice>) => setChosen((p) => ({ ...p, ...c }));

  const capMax = capMaxRaw ?? BigInt(choice.limitUsd) * 10n ** 6n;
  const plan = protectSteps(saved, choice, { capMaxRaw: capMax, pricesRaw });
  const steps = live ? plan.steps : [];
  const count = stepCount(steps, sellGrants);
  const limitUsd = toUsd(limitRaw(choice.limitUsd, capMax));
  // Selling's own limit while untouched (a grant from before can differ), Protect's otherwise.
  const sellUsd = saved.sell && chosen.limitUsd === undefined ? toUsd(saved.sell.capRaw) : limitUsd;
  const names = (ids: readonly number[]) =>
    inWords(EQUITIES.filter((e) => ids.includes(e.reserveId)).map((e) => e.name));

  // While repaying from cash is off, saving switches Protect on (protectSteps).
  const off = saved.repayCapRaw === null;
  const { canSave, note } = saveState({
    live,
    ready: limitTyped && !preview && !waiting && !busy && capMaxRaw !== null,
    feeBlocked,
    blocked: plan.blocked,
    changes: steps.length,
  });
  // Save's first JAW sheet is "Sells first" when it changed: its batch is prepared while the body is idle.
  const first = steps[0];
  const prepared = usePrepare(prep, canSave && first?.kind === "keepMix" && settingPlan ? settingPlan(first.on) : null);

  const neverChanged = choice.never.length !== start.never.length || choice.never.some((r) => !start.never.includes(r));
  const lines = steps.flatMap((s) => {
    if (s.kind === "keepMix") return [`Sells first: ${ORDER.find((o) => o.keepMix === s.on)!.label}`];
    if (s.kind === "revoke") return ["Selling: off"];
    const upTo = `up to ${formatUsdTrim(toUsd(s.capRaw))} a day`;
    if (s.job === "protect") return [`Repay from your cash: ${saved.repayCapRaw === null ? "on, " : ""}${upTo}`];
    const never =
      !saved.sell || neverChanged ? [`Never sell: ${choice.never.length > 0 ? names(choice.never) : "none"}`] : [];
    return [`Selling: ${saved.sell ? "" : "on, "}${upTo}`, ...never];
  });

  // The never-sell list: what backs the credit now, and anything already on the list.
  const listedStocks = EQUITIES.filter((e) => backsUsd[e.reserveId] > 0 || choice.never.includes(e.reserveId));
  const toggleNever = (reserveId: number, on: boolean) =>
    set({ never: on ? [...choice.never, reserveId] : choice.never.filter((r) => r !== reserveId) });

  return (
    <div className="flex flex-col gap-3.5 leading-[normal]">
      <ManageCard className="flex flex-col gap-3 px-4 py-3.5">
        <CardTitle title="Daily limit" sub={neverMoreThan("Protect", "day")} />
        <LimitField
          label="Daily limit"
          value={choice.limitUsd}
          onChange={(usd) => {
            setLimitTyped(usd !== null);
            if (usd !== null) set({ limitUsd: usd });
          }}
        />
        <LimitNotes capNote={limitTyped ? testCapNote(choice.limitUsd, capMaxRaw) : null} offNow={live && off} />
      </ManageCard>

      <ManageCard className="flex flex-col px-4 py-0.5">
        <div className="flex flex-col gap-0.5 py-[13px]">
          <span className="text-[15px] font-semibold">Repay from your cash</span>
          <span className="text-xs leading-[1.35] text-subtle">
            Only in Act, and always first. Your cash pays before any stock is sold.
          </span>
        </div>
        <div className="flex items-center gap-3 border-t border-hairline py-[13px]">
          <div className="flex grow flex-col gap-0.5">
            <span className="text-[15px] font-semibold">Sell stock if cash isn’t enough</span>
            <span className="text-xs leading-[1.35] text-subtle">
              Only stock that backs your credit, up to {formatUsdTrim(sellUsd)} a day
            </span>
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

      {live && limitTyped && <SaveSummary off={off} lines={lines} />}

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
