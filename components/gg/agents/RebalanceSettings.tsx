"use client";

import { useCallback, useState } from "react";
import { isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { CardTitle, ManageCard, MixSlider } from "@/components/gg/Manage";
import { LimitChips, neverMoreThan } from "@/components/gg/LimitChips";
import { StockAvatar, tickerOf } from "@/components/gg/StockAvatar";
import { NETWORK_FEE_ROW } from "@/components/gg/Summary";
import { TxButton, TxError } from "@/components/gg/TxUi";
import { PlusIcon } from "@/components/gg/icons";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useManageSave } from "@/hooks/useManageSave";
import { usePosition } from "@/hooks/usePosition";
import { usePrepare, type TxPhase, type TxPlan, type TxPrep } from "@/hooks/useTx";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import {
  MIX_WHOLE,
  mixWeights,
  nowPercents,
  previewTrades,
  rebalanceOptions,
  startingMix,
  type MixHolding,
  type MixRow,
} from "@/lib/agents/mix";
import { limitRaw, LIMIT_USD, stockLimitsRaw, testCapNote } from "@/lib/agents/permissions";
import { rebalanceSave, tradeLines, type RebalanceTerms, type SavePlan } from "@/lib/agents/rebalanceSettings";
import { toUsd } from "@/lib/cash";
import { formatUsdShort, formatUsdTrim } from "@/lib/formatting";
import type { RebalanceOptions } from "@/lib/guardian/rebalance";
import { EQUITIES } from "@/lib/tokens/registry";

/**
 * The Rebalancer's settings, the body of its agent sheet (agents-redesign spec): your mix, its weekly limit, when it
 * runs and its next trades from its own rule (lib/guardian/rebalance.ts) on live holdings. The sheet says what it
 * never does. While it's off, saving switches it on.
 * Everything comes from hooks, so it drops into the sheet with `<RebalanceSettings account={account} />`.
 * Saving is `setMix` through useTx and, when needed, a new grant on JAW's own screen (useManageSave). Without an
 * executor it renders live data and saves nothing ("Not live yet").
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
  const configured = !!GOOSE_EXECUTOR;
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
export type SettingsHolding = MixHolding & { lockedUsd: number };

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
  const [chosenUsd, setChosenUsd] = useState<number | null>(null);
  // A Custom limit that isn't a number of dollars yet: nothing to save until it is.
  const [limitTyped, setLimitTyped] = useState(true);
  const [adding, setAdding] = useState(false);

  const rows = edited ?? startingMix(holdings, saved);
  const weights = mixWeights(rows);
  const sum = weights.reduce((a, b) => a + b, 0);
  const whole = rows.length > 0 && sum === MIX_WHOLE;

  // The limit: the grant's while it has one, $100 a week before (LIMIT_USD).
  const limitUsd = chosenUsd ?? (terms ? toUsd(terms.capRaw) : LIMIT_USD.rebalance.start);
  const capRaw = limitRaw(limitUsd, capMaxRaw ?? BigInt(limitUsd) * 10n ** 6n);
  const trades = whole ? previewTrades({ holdings, rows, capRaw, capMaxRaw, options }) : [];
  const lines = tradeLines(trades, holdings);
  const now = nowPercents(holdings, rows);
  const backingUsd = holdings.reduce((a, h) => a + h.lockedUsd, 0);
  const plan = rebalanceSave({
    configured,
    connected,
    saved,
    weights,
    terms,
    capRaw,
    capMaxRaw,
    running,
    feeBlocked,
    feeLoading,
    busy,
  });
  // Save's first JAW sheet is the mix when it changed: its batch is prepared while the body is idle, so the tap opens it.
  const prepared = usePrepare(
    prep,
    plan.canSave && limitTyped && !preview && plan.mixChanged && settingPlan ? settingPlan(weights) : null,
  );

  const notInMix = EQUITIES.filter((e) => !rows.some((r) => r.reserveId === e.reserveId));
  const add = (reserveId: number) => {
    setEdited([...rows, { reserveId, bps: 0 }]);
    setAdding(false);
  };
  const setBps = (reserveId: number, bps: number) =>
    setEdited(rows.map((r) => (r.reserveId === reserveId ? { ...r, bps } : r)));

  return (
    <div className="flex flex-col gap-2.5 leading-[normal]">
      <ManageCard>
        <div className="flex items-start justify-between gap-3">
          <CardTitle title="Your mix" sub="A target for each stock" />
          <span
            role="status"
            className={`flex h-6 shrink-0 items-center whitespace-nowrap rounded-xl px-2.5 text-xs font-semibold ${whole ? "bg-pos-soft text-pos" : "bg-watch-soft text-watch-text"}`}
          >
            Adds up to {Math.round(sum / 100)}%
          </span>
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
        {notInMix.length > 0 && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
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
                onClick={() => add(e.reserveId)}
                className="flex h-[34px] items-center gap-1.5 rounded-[17px] bg-pill pl-1 pr-3 text-[13px] font-semibold text-ink"
              >
                <StockAvatar symbol={e.symbol} size={26} font={tickerOf(e.symbol).length > 4 ? 6 : 7.5} />
                {e.name}
              </button>
            ))}
          </div>
        )}
      </ManageCard>

      <ManageCard>
        <CardTitle title="Its next trades" sub="If it ran today, at today’s prices" />
        {!whole ? (
          <p className="m-0 text-[13px] leading-[1.4] text-ink-mid">
            {rows.length === 0 ? "None until your mix has a stock." : "Make your mix add up to 100% to see its trades."}
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
            Counts only free shares: the {formatUsdShort(backingUsd)} backing your credit stays put.
          </span>
        )}
      </ManageCard>

      <ManageCard>
        <CardTitle title="Weekly limit" sub={neverMoreThan("Rebalance", "week")} />
        <LimitChips
          label="Weekly limit"
          options={LIMIT_USD.rebalance.options}
          value={limitUsd}
          onChange={(usd) => {
            setLimitTyped(usd !== null);
            if (usd !== null) setChosenUsd(usd);
          }}
          size="sm"
          custom
        />
        {limitTyped && testCapNote(limitUsd, capMaxRaw) && (
          <span className="text-xs leading-[1.4] text-subtle">{testCapNote(limitUsd, capMaxRaw)}</span>
        )}
      </ManageCard>

      <ManageCard>
        <CardTitle title="When it runs" sub="Once a market day, after the open" />
        <span className="text-xs leading-[1.4] text-subtle">
          Only when a stock drifts too far from its target, and then part of the way back. Skips trades under{" "}
          {formatUsdTrim(toUsd(options.minTradeRaw))}.
        </span>
      </ManageCard>

      <div className="flex flex-col gap-2 pt-1">
        <TxError error={error ?? prepared.error} />
        <div className="flex items-center justify-between px-1 text-[13px]">
          <span className="text-ink-mid">{NETWORK_FEE_ROW.label}</span>
          <span className="font-semibold">{NETWORK_FEE_ROW.value}</span>
        </div>
        <TxButton
          label={configured && !running ? "Switch on" : "Save"}
          phase={phase}
          checking={prepared.checking}
          steps={plan.steps}
          note={plan.note}
          disabled={!plan.canSave || !limitTyped || busy || prepared.blocked}
          preview={configured && preview}
          onClick={() => onSave({ weights, capRaw, plan })}
        />
      </div>
    </div>
  );
}
