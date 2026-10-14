"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { Button } from "@/components/gg/Button";
import { ChoiceRow, LimitChips, ManageCard, ManageSkeleton, ManageTop, SaveFooter } from "@/components/gg/Manage";
import { StockAvatar } from "@/components/gg/StockAvatar";
import { Switch } from "@/components/gg/Switch";
import { ShieldIcon } from "@/components/gg/icons";
import { SheetShell } from "@/components/sheets/SheetShell";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useCreditForBuying } from "@/hooks/useCreditForBuying";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useManageSave } from "@/hooks/useManageSave";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { limitRaw, STOCK_LIMIT_USD, stockLimitsRaw } from "@/lib/agents/permissions";
import { buildSetKeepMixCalls } from "@/lib/agents/settings";
import { toUsd } from "@/lib/cash";
import { formatUsdShort, formatUsdTrim, inWords } from "@/lib/formatting";
import { EQUITIES } from "@/lib/tokens/registry";

export default function ManageCreditPage() {
  return <RequireAccount>{(address) => <ManageCredit address={address} />}</RequireAccount>;
}

function ManageCredit({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  const agents = useAgents(address);
  const settings = useAgentSettings(address);
  if (!data || (GOOSE_EXECUTOR && (!settings || agents.status.sell === "loading"))) return <ManageSkeleton />;
  return <CreditForm address={address} data={data} agents={agents} keepMixSaved={settings?.keepMix ?? null} />;
}

/** "Sells first" (ManageCredit): GooseExecutor's `keepMix` for Protect · sell. */
const ORDER = [
  { keepMix: false, label: "Most safety per dollar", sub: "Sells the least it takes to bring your credit back to Safe." },
  { keepMix: true, label: "Keep my mix", sub: "Sells the same share of each stock that backs your credit." },
] as const;

const NEVER_SELL_WARNING = "Protect won’t sell it, but Aave still can if your credit goes past its limit.";

/**
 * Design board "9b · Manage · Credit" (ManageCredit.dc.html), with the never-sell list the plan adds (board changes,
 * still to do). Protection's daily limit and its never-sell list are the Protect · sell JAW grant (`sellGrant` through
 * useAgents): a never-sell stock is left out of it, so JAW's manager refuses any batch that would sell it, and
 * GooseExecutor has no registry setter for the list. "Sells first" is the registry's `setKeepMix` (one Face ID through
 * useTx). "Use credit for buying" is this device's Buy sheet only. Without an executor everything renders and nothing
 * saves.
 */
function CreditForm({
  address, data, agents, keepMixSaved,
}: { address: `0x${string}`; data: PositionData; agents: ReturnType<typeof useAgents>; keepMixSaved: boolean | null }) {
  const { isConnected } = useAccount();
  const router = useRouter();
  const fee = useFeeSupport();
  const [creditForBuying, setCreditForBuying] = useCreditForBuying(address);
  const onSaved = useCallback(() => {
    toast.success("Protection is saved");
    router.push("/home");
  }, [router]);
  const saving = useManageSave(address, agents, onSaved);
  const [chosenUsd, setChosenUsd] = useState<number | null>(null);
  const [chosenKeepMix, setChosenKeepMix] = useState<boolean | null>(null);
  const [chosenNever, setChosenNever] = useState<number[] | null>(null);
  const [sheet, setSheet] = useState<"order" | "never" | null>(null);

  const configured = !!GOOSE_EXECUTOR;
  const status = agents.status.sell;
  const terms = agents.terms.sell;
  const holdings = data.holdings;

  // What the grant says today, what's on screen, and what saving needs.
  const neverSaved = terms?.limitsRaw ? EQUITIES.filter((e) => terms.limitsRaw![e.reserveId] === 0n).map((e) => e.reserveId) : [];
  const never = chosenNever ?? neverSaved;
  const keepMix = chosenKeepMix ?? keepMixSaved ?? false;
  const limitUsd = chosenUsd ?? (terms ? toUsd(terms.capRaw) : STOCK_LIMIT_USD.sell.start);
  const capRaw = limitRaw(limitUsd, agents.capMaxRaw ?? BigInt(limitUsd) * 10n ** 6n);
  const sellable = EQUITIES.map((e) => !never.includes(e.reserveId));
  const keepMixChanged = configured && keepMixSaved !== null && keepMix !== keepMixSaved;
  const needsGrant =
    configured && (!terms || terms.capRaw !== capRaw || sellable.some((s, r) => s !== ((terms.limitsRaw?.[r] ?? 0n) > 0n)));
  const nothingToSell = sellable.every((s) => !s);
  const feeBlocked = isConnected && fee.state === "unsupported";
  const canSave =
    configured &&
    isConnected &&
    !nothingToSell &&
    (keepMixChanged || needsGrant) &&
    agents.capMaxRaw !== null &&
    !feeBlocked &&
    !fee.loading &&
    !agents.busy;

  const save = () =>
    saving.save({
      calls: keepMixChanged ? buildSetKeepMixCalls(address, keepMix) : null,
      grant: needsGrant
        ? { job: "sell", capRaw, limitsRaw: stockLimitsRaw(capRaw, agents.capMaxRaw!, EQUITIES.map((e) => holdings[e.reserveId].priceRaw), sellable) }
        : null,
    });

  const note = !configured
    ? "Not live yet"
    : feeBlocked
      ? "Your account can’t pay network fees in USDC on Base right now."
      : nothingToSell
        ? "Leave at least one stock Protect may sell."
        : keepMixChanged && needsGrant
          ? "Two Face IDs: what it sells first, then its limits on JAW’s screen."
          : needsGrant
            ? status === "off"
              ? "Saving turns selling on through JAW’s screen."
              : "Its new limits go through JAW’s screen."
            : null;

  // The never-sell sheet lists what backs the credit now, and anything already on the list.
  const listed = EQUITIES.filter((e) => holdings[e.reserveId].lockedRaw > 0n || never.includes(e.reserveId));
  const neverNames = EQUITIES.filter((e) => never.includes(e.reserveId)).map((e) => e.name);
  const toggleNever = (reserveId: number, on: boolean) =>
    setChosenNever(on ? [...never, reserveId] : never.filter((r) => r !== reserveId));

  // Turning credit off turns Protection off with it: once nothing is owed, it revokes both Protect grants.
  const owed = data.debtUsd;
  const protectOn = (["protect", "sell"] as const).filter((j) => agents.status[j] === "on" || agents.status[j] === "starting");
  const offNote =
    owed > 0
      ? `Repay the ${formatUsdTrim(Math.ceil(owed))} first. Protection turns off with credit.`
      : protectOn.length > 0
        ? "Protection turns off with credit."
        : configured
          ? "Nothing to turn off: you owe nothing and Protection is off."
          : "Nothing to turn off: Protection isn’t live yet.";
  const turnOffCredit = async () => {
    for (const job of protectOn) await agents.turnOff(job);
  };

  return (
    <div className="flex min-h-dvh flex-col gap-3.5 px-5 pb-[34px] pt-[54px]">
      <ManageTop title="Manage" tab="credit" />

      <ManageCard className="flex flex-col px-4 pb-1 pt-4">
        <div className="flex items-center gap-3 pb-3.5">
          <span aria-hidden className="flex size-[42px] shrink-0 items-center justify-center rounded-[21px] bg-brand text-ink">
            <ShieldIcon size={20} strokeWidth={1.9} />
          </span>
          <span className="text-[17px] font-semibold">Protection</span>
        </div>
        <div className="flex flex-col gap-2.5 pb-3.5">
          <span className="text-[15px] font-semibold">Can sell up to</span>
          <LimitChips label="Protection can sell up to, a day" options={STOCK_LIMIT_USD.sell.options} value={limitUsd} onChange={setChosenUsd} per="a day" size="md" />
        </div>
        <ChoiceRow label="Sells first" value={ORDER.find((o) => o.keepMix === keepMix)!.label} onClick={() => setSheet("order")} />
        <ChoiceRow
          label="Never sells"
          value={neverNames.length === 0 ? "None" : neverNames.length > 2 ? `${neverNames.length} stocks` : inWords(neverNames)}
          onClick={() => setSheet("never")}
          note={neverNames.length > 0 ? NEVER_SELL_WARNING : undefined}
        />
        {/* GooseExecutor has no pause for one account (its pause stops every run): nothing to call yet. */}
        <button type="button" disabled className="flex h-11 items-center gap-2 border-t border-hairline text-sm font-semibold text-ink-mid disabled:opacity-45">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M9 5v14M15 5v14" />
          </svg>
          Pause Protection
        </button>
      </ManageCard>

      <ManageCard className="px-4 py-0.5">
        <div className="flex items-center gap-3 py-[13px]">
          <div className="flex grow flex-col gap-0.5">
            <span className="text-[15px] font-semibold">Use credit for buying</span>
            <span className="text-xs leading-[1.35] text-subtle">Only when a buy is bigger than your cash</span>
          </div>
          <Switch label="Use credit for buying" checked={creditForBuying} onChange={setCreditForBuying} />
        </div>
      </ManageCard>

      <div className="flex flex-col items-start gap-1 px-1 leading-[normal]">
        <button
          type="button"
          disabled={owed > 0 || protectOn.length === 0 || !isConnected || agents.busy}
          onClick={() => void turnOffCredit().catch(() => {})}
          className="text-sm font-semibold leading-[normal] text-ink-mid disabled:cursor-default"
        >
          Turn off credit
        </button>
        <span className="text-xs leading-[1.4] text-subtle">{offNote}</span>
      </div>

      <SaveFooter phase={saving.phase} disabled={!canSave || saving.busy} preview={configured && !isConnected} onSave={save} error={saving.error} note={note} />

      <SheetShell open={sheet === "order"} onOpenChange={(o) => setSheet(o ? "order" : null)} title="Sells first" description="When Protection has to sell, which stock goes first.">
        <div role="radiogroup" aria-label="Sells first" className="rounded-[16px] border border-line-field bg-card leading-[normal]">
          {ORDER.map((o) => (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={o.keepMix === keepMix}
              onClick={() => {
                setChosenKeepMix(o.keepMix);
                setSheet(null);
              }}
              className="flex w-full items-center gap-3 border-b border-line-field px-4 py-3 text-left text-ink last:border-b-0"
            >
              <span className="flex grow flex-col gap-[3px]">
                <span className="text-[15px] font-semibold">{o.label}</span>
                <span className="text-[13px] leading-[1.35] text-ink-mid">{o.sub}</span>
              </span>
              <span aria-hidden className={`flex size-[22px] shrink-0 items-center justify-center rounded-full ${o.keepMix === keepMix ? "bg-ink text-on-ink" : "border-[1.5px] border-line-strong"}`}>
                {o.keepMix === keepMix && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12l5 5 9-10" />
                  </svg>
                )}
              </span>
            </button>
          ))}
        </div>
      </SheetShell>

      <SheetShell open={sheet === "never"} onOpenChange={(o) => setSheet(o ? "never" : null)} title="Never sells" description={NEVER_SELL_WARNING}>
        <div className="flex flex-col gap-4">
          {listed.length === 0 ? (
            <p className="m-0 text-[15px] text-ink-mid">None of your stocks back your credit.</p>
          ) : (
            <div className="rounded-[16px] border border-line-field bg-card leading-[normal]">
              {listed.map((e) => {
                const h = holdings[e.reserveId];
                return (
                  <div key={e.symbol} className="flex items-center gap-3 border-b border-line-field px-4 py-3 last:border-b-0">
                    <StockAvatar symbol={e.symbol} size={30} />
                    <span className="flex grow flex-col gap-[3px]">
                      <span className="text-[15px] font-semibold">{e.name}</span>
                      <span className="num text-xs text-subtle">{h.lockedRaw > 0n ? `Backs ${formatUsdShort(h.lockedUsd)}` : "Backs nothing now"}</span>
                    </span>
                    <Switch label={`Never sell ${e.name}`} checked={never.includes(e.reserveId)} onChange={(on) => toggleNever(e.reserveId, on)} />
                  </div>
                );
              })}
            </div>
          )}
          <Button variant="dark" onClick={() => setSheet(null)}>Done</Button>
        </div>
      </SheetShell>
    </div>
  );
}
