"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { CardTitle, LimitChips, ManageCard, ManageSkeleton, ManageTop, MixCard, SaveFooter } from "@/components/gg/Manage";
import { MarketList, MarketRow } from "@/components/gg/Market";
import { SheetShell } from "@/components/sheets/SheetShell";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useManageSave } from "@/hooks/useManageSave";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { MIX_WHOLE, mixWeights, nowPercents, previewTrades, rebalanceOptions, startingMix, whatHappens, type MixRow } from "@/lib/agents/mix";
import { limitRaw, STOCK_LIMIT_USD, stockLimitsRaw } from "@/lib/agents/permissions";
import { buildSetMixCalls } from "@/lib/agents/settings";
import { toUsd } from "@/lib/cash";
import { formatUsdShort, formatUsdTrim } from "@/lib/formatting";
import { EQUITIES } from "@/lib/tokens/registry";

export default function ManagePage() {
  return <RequireAccount>{(address) => <ManageMix address={address} />}</RequireAccount>;
}

function ManageMix({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  const agents = useAgents(address);
  const settings = useAgentSettings(address);
  if (!data || (GOOSE_EXECUTOR && (!settings || agents.status.rebalance === "loading"))) return <ManageSkeleton />;
  return <MixForm address={address} data={data} agents={agents} settings={settings} />;
}

/**
 * Design board "9 · Manage · Your mix" (Manage.dc.html). The mix is GooseExecutor's registry (`setMix`, one Face ID
 * through useTx); the weekly limit is the Rebalancer's JAW grant (`rebalanceGrant` through useAgents, its own JAW
 * screen). "What happens" is the Rebalancer's own rule (lib/guardian/rebalance.ts) on today's free stock. Without an
 * executor everything renders and nothing saves ("Not live yet").
 */
function MixForm({
  address, data, agents, settings,
}: {
  address: `0x${string}`;
  data: PositionData;
  agents: ReturnType<typeof useAgents>;
  settings: ReturnType<typeof useAgentSettings>;
}) {
  const { isConnected } = useAccount();
  const router = useRouter();
  const fee = useFeeSupport();
  const onSaved = useCallback(() => {
    toast.success("Your mix is saved");
    router.push("/home");
  }, [router]);
  const saving = useManageSave(address, agents, onSaved);
  const [edited, setEdited] = useState<MixRow[] | null>(null);
  const [chosenUsd, setChosenUsd] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const configured = !!GOOSE_EXECUTOR;
  const status = agents.status.rebalance;
  const terms = agents.terms.rebalance;
  const holdings = data.holdings;
  const saved = settings?.mixBps ?? null;
  const rows = edited ?? startingMix(holdings, saved);
  const weights = mixWeights(rows);
  const whole = rows.length > 0 && weights.reduce((a, b) => a + b, 0) === MIX_WHOLE;
  const options = settings?.options ?? rebalanceOptions();

  // The limit: the grant's while the Rebalancer has one, the boards' $500 a week before.
  const limitUsd = chosenUsd ?? (terms ? toUsd(terms.capRaw) : STOCK_LIMIT_USD.rebalance.start);
  const capRaw = limitRaw(limitUsd, agents.capMaxRaw ?? BigInt(limitUsd) * 10n ** 6n);
  const trades = whole ? previewTrades({ holdings, rows, capRaw, capMaxRaw: agents.capMaxRaw, options }) : [];
  const backingUsd = holdings.reduce((a, h) => a + h.lockedUsd, 0);
  const now = nowPercents(holdings, rows);

  // What saving needs: the mix in the registry if it changed; a new grant if there's none, the limit changed, or a
  // stock in the mix has no sell limit in it.
  const sellable = weights.map((w) => w > 0);
  const mixChanged = configured && saved !== null && weights.some((w, r) => w !== saved[r]);
  const needsGrant =
    configured && (!terms || terms.capRaw !== capRaw || sellable.some((s, r) => s && !((terms.limitsRaw?.[r] ?? 0n) > 0n)));
  const feeBlocked = isConnected && fee.state === "unsupported";
  const canSave =
    configured && isConnected && whole && (mixChanged || needsGrant) && agents.capMaxRaw !== null && !feeBlocked && !fee.loading && !agents.busy;

  const save = () =>
    saving.save({
      calls: mixChanged ? buildSetMixCalls(address, weights) : null,
      grant: needsGrant
        ? {
            job: "rebalance",
            capRaw,
            limitsRaw: stockLimitsRaw(capRaw, agents.capMaxRaw!, EQUITIES.map((e) => holdings[e.reserveId].priceRaw), sellable),
          }
        : null,
    });

  const note = !configured
    ? "Not live yet"
    : feeBlocked
      ? "Your account can’t pay network fees in USDC on Base right now."
      : mixChanged && needsGrant
        ? "Two Face IDs: your mix, then its limit on JAW’s screen."
        : needsGrant
          ? status === "off"
            ? "Saving turns the Rebalancer on through JAW’s screen."
            : "Its new limit goes through JAW’s screen."
          : null;

  const notInMix = EQUITIES.filter((e) => !rows.some((r) => r.reserveId === e.reserveId));
  const add = (reserveId: number) => {
    setEdited([...rows, { reserveId, bps: 0 }]);
    setAdding(false);
  };

  return (
    <div className="flex min-h-dvh flex-col gap-2.5 px-5 pb-[34px] pt-[54px]">
      <ManageTop title="Agents" tab="mix" />

      <MixCard
        lines={rows.map((r, i) => ({ ...r, symbol: EQUITIES[r.reserveId].symbol, name: EQUITIES[r.reserveId].name, nowPct: now[i] }))}
        onChange={(reserveId, bps) => setEdited(rows.map((r) => (r.reserveId === reserveId ? { ...r, bps } : r)))}
        onAdd={notInMix.length > 0 ? () => setAdding(true) : undefined}
        happens={
          <>
            {whatHappens(rows, trades, holdings)}
            {backingUsd >= 0.01 && ` Only free shares count: the ${formatUsdShort(backingUsd)} backing your credit stays put.`}
          </>
        }
      />

      <ManageCard>
        <CardTitle title="Its limit" sub="Can sell up to" />
        <LimitChips label="The Rebalancer can sell up to, a week" options={STOCK_LIMIT_USD.rebalance.options} value={limitUsd} onChange={setChosenUsd} per="a week" size="sm" />
        <span className="text-xs leading-[1.4] text-subtle">
          Sells what grew too big to buy what fell short. <span className="whitespace-nowrap">Never uses your cash or credit.</span>
        </span>
      </ManageCard>

      <ManageCard>
        <CardTitle title="When it rebalances" sub="Once a day, after the market opens" />
        <span className="text-xs leading-[1.4] text-subtle">
          Trades only when a stock drifts too far from its target, and moves it part of the way back. Skips anything under{" "}
          {formatUsdTrim(toUsd(options.minTradeRaw))}.
        </span>
      </ManageCard>

      <div className="flex shrink-0 items-center justify-center gap-1.5 text-sm font-medium leading-[normal]">
        {/* GooseExecutor has no pause for one account (its pause stops every run): nothing to call yet. */}
        <button type="button" disabled className="flex h-8 items-center px-2 text-ink-mid disabled:opacity-45">Pause the Rebalancer</button>
        <span aria-hidden className="text-subtle">·</span>
        <button
          type="button"
          disabled={!isConnected || agents.busy || (status !== "on" && status !== "starting")}
          onClick={() => void agents.turnOff("rebalance").catch(() => {})}
          className="flex h-8 items-center px-2 text-ink-mid disabled:opacity-45"
        >
          Turn off
        </button>
      </div>

      <SaveFooter phase={saving.phase} disabled={!canSave || saving.busy} preview={configured && !isConnected} onSave={save} error={saving.error} note={note} />

      <SheetShell open={adding} onOpenChange={setAdding} title="Add a stock" description="Pick one for your mix." topPx={188}>
        <MarketList>
          {notInMix.map((e) => {
            const h = holdings[e.reserveId];
            return (
              <MarketRow key={e.symbol} symbol={e.symbol} name={e.name} priceUsd={h.priceUsd} ownedUsd={h.freeUsd + h.lockedUsd} onClick={() => add(e.reserveId)} />
            );
          })}
        </MarketList>
      </SheetShell>
    </div>
  );
}
