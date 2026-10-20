"use client";

import { useCallback, useState } from "react";
import { isAddressEqual, maxUint160 } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { CardTitle, ManageCard, MixSlider } from "@/components/gg/Manage";
import { ComingSoon } from "@/components/gg/Agents";
import { StockAvatar, tickerOf } from "@/components/gg/kit/StockAvatar";
import { TxButton, TxError } from "@/components/gg/TxUi";
import { PlusIcon } from "@/components/gg/kit/icons";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useManageSave } from "@/hooks/useManageSave";
import { usePosition } from "@/hooks/usePosition";
import { usePrepare, type TxPhase, type TxPlan, type TxPrep } from "@/hooks/useTx";
import { AGENTS_LIVE } from "@/lib/agents/config";
import {
  MIX_WHOLE,
  mixWeights,
  nowPercents,
  previewTrades,
  rebalanceOptions,
  setMixRow,
  startingMix,
  type MixHolding,
  type MixRow,
} from "@/lib/agents/mix";
import { stockLimitsRaw } from "@/lib/agents/permissions";
import { rebalanceSave, tradeLines, type RebalanceTerms, type SavePlan } from "@/lib/agents/rebalanceSettings";
import { toUsd } from "@/lib/cash";
import { formatUsdShort, formatUsdTrim } from "@/lib/formatting";
import type { RebalanceOptions } from "@/lib/agents/rules/rebalance";
import { EQUITIES } from "@/lib/tokens/registry";

/**
 * The Rebalancer's settings, the body of its agent sheet (agents-redesign spec): your mix, when it runs and its next
 * trades from its own rule (lib/agents/rules/rebalance.ts) on live holdings. It has no amount limit: its grant is at the
 * executor's CAP_MAX, with no field to type. The sheet says what it never does. While it's off, saving switches it on.
 * Everything comes from hooks, so it drops into the sheet with `<RebalanceSettings account={account} />`.
 * Saving is a new grant on JAW's own screen when needed, then one batch with the mix and its registration, or the
 * mix alone through useTx (useManageSave). Without an executor it renders live data and saves nothing ("Not live yet").
 */
export function RebalanceSettings({ account, onDone }: { account: `0x${string}`; onDone?: () => void }) {
  const { data } = usePosition(account);
  const agents = useAgents(account);
  const settings = useAgentSettings(account);
  const { address, isConnected } = useAccount();
  const fee = useFeeSupport();
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
      options={settings?.options ?? rebalanceOptions()}
      terms={agents.terms.rebalance}
      capMaxRaw={agents.capMaxRaw}
      configured={configured}
      connected={isConnected}
      preview={!address || !isAddressEqual(address, account)}
      running={status === "on" || status === "starting"}
      feeBlocked={isConnected && fee.state === "unsupported"}
      feeLoading={fee.loading}
      busy={agents.busy || saving.busy}
      waiting={saving.registering}
      phase={saving.phase}
      error={saving.error}
      prep={saving.prep}
      settingPlan={saving.settingPlan}
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
    <div aria-busy className="flex flex-col gap-2.5">
      <div className="h-[260px] animate-pulse rounded-[22px] bg-chip" />
      <div className="h-[130px] animate-pulse rounded-[22px] bg-chip" />
      <div className="h-[110px] animate-pulse rounded-[22px] bg-chip" />
    </div>
  );
}

/** A stock as the settings see it: the mix's free shares at Aave's price, and what backs credit. */
export type SettingsHolding = MixHolding & { backingUsd: number };

type SaveRequest = { weights: number[]; capRaw: bigint; plan: SavePlan };

/** The settings drawn from plain values, so the dev gallery can show each state. */
export function RebalanceSettingsView({
  holdings,
  saved,
  options,
  terms,
  capMaxRaw,
  configured,
  connected,
  preview = !connected,
  running,
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
}: {
  holdings: readonly SettingsHolding[];
  /** The registry's mix, BPS by reserve id (all 0 before one is saved); null before it is read. */
  saved: readonly number[] | null;
  options: RebalanceOptions;
  terms: RebalanceTerms;
  capMaxRaw: bigint | null;
  configured: boolean;
  connected: boolean;
  /** Not signed in as this account (the dev preview): nothing signs. */
  preview?: boolean;
  running: boolean;
  feeBlocked: boolean;
  feeLoading: boolean;
  busy: boolean;
  /** This sheet's grant waits for its batch: Save sends it (useManageSave `registering`). */
  waiting?: boolean;
  phase: TxPhase;
  error: string | null;
  /** The write's store (useManageSave's `prep`) and the `setMix` batch for a mix, so Save's batch is ready before the tap. */
  prep?: TxPrep;
  settingPlan?: (weights: readonly number[]) => TxPlan | null;
  onSave: (r: SaveRequest) => void;
  /** Opens on an edit (the dev gallery's states). */
  draft?: MixRow[];
}) {
  const [edited, setEdited] = useState<MixRow[] | null>(draft ?? null);
  const [adding, setAdding] = useState(false);

  const rows = edited ?? startingMix(holdings, saved);
  const weights = mixWeights(rows);
  const sum = weights.reduce((a, b) => a + b, 0);
  const whole = rows.length > 0 && sum === MIX_WHOLE;

  // No amount limit: the grant is at the executor's CAP_MAX. Until it's read, the preview runs on the most a grant
  // could hold, and nothing saves (rebalanceSave).
  const capRaw = capMaxRaw ?? maxUint160;
  const trades = whole ? previewTrades({ holdings, rows, capRaw, capMaxRaw, options }) : [];
  const lines = tradeLines(trades, holdings);
  const now = nowPercents(holdings, rows);
  const backingUsd = holdings.reduce((a, h) => a + h.backingUsd, 0);
  const plan = rebalanceSave({
    configured,
    connected,
    saved,
    weights,
    terms,
    capMaxRaw,
    running,
    feeBlocked,
    feeLoading,
    busy,
    waiting,
  });
  // Save's only JAW sheet is the mix when it changed and nothing is granted or waiting (else the mix rides in the batch
  // after the grant): its batch is prepared while the body is idle, so the tap opens it.
  const mixAlone = plan.mixChanged && !plan.needsGrant && !waiting;
  const prepared = usePrepare(prep, plan.canSave && !preview && mixAlone && settingPlan ? settingPlan(weights) : null);

  const notInMix = EQUITIES.filter((e) => !rows.some((r) => r.reserveId === e.reserveId));
  const add = (reserveId: number) => {
    setEdited([...rows, { reserveId, bps: 0 }]);
    setAdding(false);
  };
  // Never past 100% in all: a target stops where the other stocks' leave off (setMixRow).
  const setBps = (reserveId: number, bps: number) => setEdited(setMixRow(rows, reserveId, bps));

  return (
    <div className="flex flex-col gap-2.5 leading-[normal]">
      <ManageCard>
        <div className="flex items-start justify-between gap-3">
          <CardTitle title="My mix" sub="A target for each stock" />
          {/* Ruling 24: no "Adds up to" before a stock is in the mix. */}
          {rows.length > 0 && (
            <span
              role="status"
              className={`flex h-6 shrink-0 items-center whitespace-nowrap rounded-xl px-2.5 text-xs font-semibold ${whole ? "bg-pos-soft text-pos" : "bg-watch-soft text-watch-text"}`}
            >
              Adds up to {Math.round(sum / 100)}%
            </span>
          )}
        </div>
        {rows.length === 0 && <p className="m-0 text-[13px] text-ink-mid">Add a stock to start your mix.</p>}
        {rows.map((r, i) => {
          const e = EQUITIES[r.reserveId];
          return (
            <div key={r.reserveId} className="flex items-center gap-2.5">
              <StockAvatar symbol={e.symbol} size={30} font={tickerOf(e.symbol).length > 4 ? 7 : 8.5} />
              <div className="flex w-[78px] shrink-0 flex-col">
                <span className="whitespace-nowrap text-sm font-semibold">{e.name}</span>
                <span className="num text-[11px] text-subtle">{now[i] === null ? "none now" : `now ${now[i]}%`}</span>
              </div>
              <MixSlider name={e.name} bps={r.bps} onChange={(bps) => setBps(r.reserveId, bps)} />
              <span className="num w-[38px] shrink-0 text-right text-[15px] font-semibold">
                {Math.round(r.bps / 100)}%
              </span>
            </div>
          );
        })}
        <AddStock notInMix={notInMix} adding={adding} onOpen={() => setAdding(true)} onAdd={add} />
      </ManageCard>

      <NextTrades whole={whole} empty={rows.length === 0} lines={lines} backingUsd={backingUsd} />

      <ManageCard>
        <CardTitle title="When it runs" sub="Once a market day, after the open" />
        <span className="text-xs leading-[1.4] text-subtle">
          Only when a stock drifts too far from its target, and then part of the way back. Skips trades under{" "}
          {formatUsdTrim(toUsd(options.minTradeRaw))}.
        </span>
        <span className="text-xs leading-[1.4] text-subtle">
          Rebalance never spends your cash. Only the network fee comes from it.
        </span>
      </ManageCard>

      {configured ? (
        <div className="flex flex-col gap-2 pt-1">
          <TxError error={error ?? prepared.error} />
          <TxButton
            label={running ? "Save" : "Switch on"}
            phase={phase}
            checking={prepared.checking}
            steps={plan.steps}
            note={plan.note}
            disabled={!plan.canSave || busy || prepared.blocked}
            preview={preview}
            onClick={() => onSave({ weights, capRaw, plan })}
          />
        </div>
      ) : (
        // Ruling 22: no Save while the agents aren't live.
        <div className="flex justify-center pt-1">
          <ComingSoon />
        </div>
      )}
    </div>
  );
}

/** "Add a stock" under the mix, then the stocks not in it to pick from. */
function AddStock({
  notInMix,
  adding,
  onOpen,
  onAdd,
}: {
  notInMix: readonly { symbol: string; name: string; reserveId: number }[];
  adding: boolean;
  onOpen: () => void;
  onAdd: (reserveId: number) => void;
}) {
  return (
    <>
      {notInMix.length > 0 && !adding && (
        <button
          type="button"
          onClick={onOpen}
          className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[18px] border-[1.5px] border-dashed border-line-strong text-[13px] font-semibold text-ink"
        >
          <PlusIcon size={14} strokeWidth={2.2} />
          Add a stock
        </button>
      )}
      {adding && (
        <div role="group" aria-label="Add a stock" className="flex flex-wrap gap-1.5">
          {notInMix.map((e) => (
            <button
              key={e.symbol}
              type="button"
              onClick={() => onAdd(e.reserveId)}
              className="flex h-[34px] items-center gap-1.5 rounded-[17px] bg-pill pl-1 pr-3 text-[13px] font-semibold text-ink"
            >
              <StockAvatar symbol={e.symbol} size={26} font={tickerOf(e.symbol).length > 4 ? 6 : 7.5} />
              {e.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** What it would trade if it ran today, at today's prices: nothing until the mix adds up, then each buy and sale. */
function NextTrades({
  whole,
  empty,
  lines,
  backingUsd,
}: {
  whole: boolean;
  empty: boolean;
  lines: ReturnType<typeof tradeLines>;
  backingUsd: number;
}) {
  return (
    <ManageCard>
      <CardTitle title="Its next trades" sub="If it ran today, at today’s prices" />
      {!whole ? (
        <p className="m-0 text-[13px] leading-[1.4] text-ink-mid">
          {empty ? "None until your mix has a stock." : "Make your mix add up to 100% to see its trades."}
        </p>
      ) : lines.length === 0 ? (
        <p className="m-0 text-[13px] leading-[1.4] text-ink-mid">
          Nothing to trade. Every stock is close to its target.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {lines.map((l, i) => (
            <li
              key={`${l.buy}-${l.reserveId}`}
              className={`flex items-center gap-2.5 py-2 ${i > 0 ? "border-t border-hairline" : ""}`}
            >
              <StockAvatar
                symbol={EQUITIES[l.reserveId].symbol}
                size={26}
                font={tickerOf(EQUITIES[l.reserveId].symbol).length > 4 ? 6 : 7.5}
              />
              <span className="grow text-sm">
                <span className="text-ink-mid">{l.buy ? "Buys" : "Sells"}</span>{" "}
                <span className="font-semibold">{l.name}</span>
              </span>
              <span className="num text-[15px] font-semibold">{formatUsdTrim(l.usd)}</span>
            </li>
          ))}
        </ul>
      )}
      {backingUsd >= 0.01 && (
        <span className="text-xs leading-[1.4] text-subtle">
          Counts only free shares. The {formatUsdShort(backingUsd)} backing your credit stays put.
        </span>
      )}
    </ManageCard>
  );
}
