"use client";

import { useState } from "react";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { SubHeader, WhiteCard } from "@/components/gg/Screen";
import { AmountInput } from "@/components/gg/AmountInput";
import { BottomBar } from "@/components/gg/BottomBar";
import { StatusPill } from "@/components/gg/Status";
import { ShieldIcon } from "@/components/gg/icons";
import { FaceIdButton, TxDone, TxError } from "@/components/gg/TxUi";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { useGuardian } from "@/hooks/useGuardian";
import { useTx } from "@/hooks/useTx";
import { useSheetSubject } from "@/hooks/useSheetSubject";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { planGuardian, GUARDIAN_DEFAULTS } from "@/lib/guardian/plan";
import { buildAddSavingsCalls, buildWithdrawSavingsCalls } from "@/lib/guardian/permission";
import { USDC } from "@/lib/tokens/registry";
import { formatUsd } from "@/lib/formatting";

export default function GuardianPage() {
  return <RequireAccount>{(address) => <Guardian address={address} />}</RequireAccount>;
}

const CAPS = [25, 50, 100, 250];

function Guardian({ address }: { address: `0x${string}` }) {
  const { isConnected } = useAccount();
  const { data } = usePosition(address);
  const g = useGuardian(address);
  const tx = useTx();
  const [cap, setCap] = useState(50);
  const sheet = useSheetSubject<"add" | "withdraw">();

  if (!data) return <div className="px-5 pt-[54px]"><div aria-busy className="h-[520px] animate-pulse rounded-[22px] bg-chip" /></div>;

  const on = g.status === "on";
  const unconfigured = g.status === "unconfigured";
  const stress = planGuardian({
    collateralUsd: data.collateralUsd * (1 - GUARDIAN_DEFAULTS.stressDrop),
    avgCf: data.avgCf,
    debtUsd: data.debtUsd,
    savingsUsd: data.savingsUsd,
    capLeftUsd: on && g.record ? Number(g.record.capRaw) / 1e6 : cap,
    weekendWindow: false,
  });

  if (tx.phase === "done") {
    return (
      <div className="flex min-h-dvh flex-col gap-4 px-5 pb-[34px] pt-[54px]">
        <SubHeader label="Guardian" back="/credit" />
        <TxDone
          title={on ? "Guardian is on" : "Guardian is off"}
          body={on ? "If your loan slips into Watch, Guardian repays from your savings. Your stocks stay put." : "Guardian can no longer act on your account."}
          txHash={tx.txHash}
          onDone={() => {
            if (!on) g.clear();
            tx.reset();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 pt-[54px]">
      <SubHeader label="Guardian" back="/credit" />

      <WhiteCard className="flex flex-col gap-3 p-[18px]">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex size-[42px] shrink-0 items-center justify-center rounded-[21px] bg-brand text-ink"><ShieldIcon size={20} /></span>
          <div className="flex flex-1 flex-col">
            <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em]">Guardian</h1>
            <span className="text-[13px] text-ink-mid">Your stocks are never auto-sold</span>
          </div>
          <span
            className={`inline-flex h-6 items-center gap-1.5 rounded-[12px] px-2.5 text-xs font-bold ${on ? "bg-safe-bg text-safe" : "bg-chip text-ink-mid"}`}
          >
            <span aria-hidden className={`size-1.5 rounded-full ${on ? "bg-safe" : "bg-subtle"}`} />
            {unconfigured ? "Coming soon" : on ? "On" : g.status === "loading" ? "…" : "Off"}
          </span>
        </div>
        <p className="m-0 text-[14px] leading-snug text-ink-mid">
          If your loan slips into <b className="text-watch-text">Watch</b>, Guardian repays part of it from your savings to bring
          you back to <b className="text-safe">Safe</b> — before Aave’s liquidators can sell your stocks at a discount.
        </p>
      </WhiteCard>

      <WhiteCard className="flex flex-col gap-3 p-[18px]">
        <div className="flex items-center justify-between">
          <span className="label">Savings buffer</span>
          <span className="num text-xs text-subtle">earns {(data.savingsApr * 100).toFixed(2)}% · Aave</span>
        </div>
        <div className="num text-[38px] font-semibold leading-none tracking-[-0.04em]">{formatUsd(data.savingsUsd)}</div>
        <p className="m-0 text-[13px] text-ink-mid">Guardian only ever pays from here, never from your cash or stocks.</p>
        <div className="grid grid-cols-2 gap-2.5">
          <button type="button" onClick={() => sheet.show("add")} disabled={data.usdcBalance <= 0} className="h-11 rounded-[22px] bg-ink text-[14px] font-semibold text-on-ink disabled:opacity-45">
            Add from cash
          </button>
          <button type="button" onClick={() => sheet.show("withdraw")} disabled={data.savingsUsd <= 0} className="h-11 rounded-[22px] bg-chip text-[14px] font-semibold disabled:opacity-45">
            Move to cash
          </button>
        </div>
      </WhiteCard>

      <WhiteCard className="flex flex-col gap-3 p-[18px]">
        <span className="label">Most Guardian can repay per day</span>
        <div role="radiogroup" aria-label="Daily limit" className="grid grid-cols-4 gap-2">
          {CAPS.map((c) => {
            const active = on && g.record ? Number(g.record.capRaw) / 1e6 === c : cap === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={on}
                onClick={() => setCap(c)}
                className={`num h-10 rounded-[20px] text-sm ${active ? "bg-ink font-semibold text-on-ink" : "bg-chip font-medium text-ink-2"} disabled:cursor-default`}
              >
                ${c}
              </button>
            );
          })}
        </div>
        {on && <p className="m-0 text-xs text-subtle">To change the limit, turn Guardian off and on again.</p>}
      </WhiteCard>

      <Preview data={data} stress={stress} />

      <WhiteCard className="p-[18px] text-[14px] leading-snug">
        <div className="mb-2 font-semibold">What Guardian can do</div>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-ink-mid">
          <li>✓ Move USDC from your savings back to your own account</li>
          <li>✓ Use it to repay your own loan</li>
        </ul>
        <div className="mb-2 mt-4 font-semibold">What it can never do</div>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-ink-mid">
          <li>✕ Send money anywhere else, or pay anyone else’s loan</li>
          <li>✕ Sell, move or lock your stocks</li>
          <li>✕ Borrow, or touch your cash</li>
          <li>✕ Spend more than your daily limit</li>
        </ul>
        <p className="m-0 mt-3 text-xs text-subtle">
          Enforced on-chain by JAW’s permission manager and the GuardianChecker contract, not by our servers. Turn it off any
          time; once off, it can never act again.
        </p>
      </WhiteCard>

      {unconfigured && (
        <p role="status" className="m-0 rounded-2xl bg-chip px-4 py-3 text-[13px] text-ink-mid">
          Guardian isn’t live yet: its contract is waiting for an independent security audit. You can already build a savings
          buffer.
        </p>
      )}
      {!unconfigured && !on && data.savingsUsd <= 0 && (
        <p role="status" className="m-0 text-[13px] text-watch-text">Add savings first — Guardian pays from your savings buffer.</p>
      )}
      <TxError error={tx.error} />

      <BottomBar>
        {on ? (
          <button
            type="button"
            disabled={tx.busy || !isConnected}
            onClick={() => {
              if (tx.phase === "failed") tx.reset();
              void tx.run(address, g.disableCalls(), "Couldn’t turn Guardian off right now. Try again.");
            }}
            className="h-[52px] rounded-[26px] bg-chip text-[15px] font-semibold disabled:opacity-45"
          >
            {tx.busy ? "Confirming…" : "Turn off Guardian"}
          </button>
        ) : (
          <FaceIdButton
            label={`Turn on Guardian · up to $${cap}/day`}
            phase={tx.phase}
            preview={!isConnected}
            disabled={unconfigured || g.status === "loading" || data.savingsUsd <= 0}
            onClick={() => {
              if (tx.phase === "failed") tx.reset();
              void tx.run(address, g.enableCalls(BigInt(cap) * 1_000_000n), "Couldn’t turn Guardian on right now. Try again.");
            }}
          />
        )}
      </BottomBar>

      {sheet.subject && (
        <SavingsSheet key={sheet.key} open={sheet.open} address={address} data={data} mode={sheet.subject} onClose={sheet.close} />
      )}
    </div>
  );
}

function Preview({ data, stress }: { data: PositionData; stress: ReturnType<typeof planGuardian> }) {
  let text: string;
  if (data.debtUsd <= 0) text = "You don’t owe anything, so there’s nothing to protect yet.";
  else if (stress.action === "repay")
    text = `If your stocks fell 15% today, Guardian would repay about ${formatUsd(stress.amountUsd)} from savings${
      stress.limitedBy === "savings" ? " (all of your savings — consider adding more)" : stress.limitedBy === "cap" ? " (your daily limit)" : ""
    } and bring you back to ${stress.hfAfter >= 1.5 ? "Safe" : "a better position"}.`;
  else if (stress.reason === "no-savings") text = "If your stocks fell 15% today you’d be in Watch, and with no savings Guardian couldn’t help.";
  else text = "Even if your stocks fell 15% today, your loan would stay Safe.";
  return (
    <WhiteCard className="flex items-start gap-3 p-[18px]">
      <StatusPill status={data.status} />
      <p className="m-0 flex-1 text-[14px] leading-snug text-ink-2">{text}</p>
    </WhiteCard>
  );
}

function SavingsSheet({
  open, address, data, mode, onClose,
}: { open: boolean; address: `0x${string}`; data: PositionData; mode: "add" | "withdraw"; onClose: () => void }) {
  const { isConnected } = useAccount();
  const tx = useTx();
  const [raw, setRaw] = useState("");
  const max = mode === "add" ? data.usdcBalance : data.savingsUsd;
  const amount = Math.max(0, Number(raw) || 0);
  const all = mode === "withdraw" && amount >= data.savingsUsd - 1e-6;
  const tooMuch = amount > max + 1e-9;

  return (
    <SheetShell open={open} onOpenChange={(next) => !next && onClose()} title={mode === "add" ? "Add to savings" : "Move savings to cash"}>
      <SheetSteps stepKey={tx.phase === "done" ? "done" : "amount"} className="flex flex-col gap-3">
        {tx.phase === "done" ? (
          <TxDone title="Done" body={mode === "add" ? "Your savings buffer is bigger and earning." : "The USDC is back in your cash."} txHash={tx.txHash} onDone={onClose} />
        ) : (
          <>
            <div className="flex flex-col gap-2 rounded-2xl border border-ink bg-card p-3.5">
              <span className="text-xs text-subtle">{mode === "add" ? `Cash available: ${formatUsd(data.usdcBalance)}` : `In savings: ${formatUsd(data.savingsUsd)}`}</span>
              <div className="flex items-center gap-2">
                <span className="text-[22px] font-semibold text-subtle">$</span>
                <AmountInput autoFocus value={raw} onValue={setRaw} className="text-[30px] font-semibold leading-none tracking-[-0.03em]" />
                <button type="button" onClick={() => setRaw(String(Math.floor(max * 100) / 100))} className="h-7 rounded-[14px] bg-chip px-2.5 text-xs font-semibold text-ink-mid">
                  MAX
                </button>
              </div>
            </div>
            {tooMuch && <p role="status" className="m-0 text-[13px] text-act">That’s more than you have.</p>}
            <TxError error={tx.error} />
            <FaceIdButton
              label={mode === "add" ? `Save ${formatUsd(amount)} with Face ID` : `Move ${all ? "all" : formatUsd(amount)} with Face ID`}
              phase={tx.phase}
              preview={!isConnected}
              disabled={amount <= 0 || tooMuch}
              onClick={() => {
                if (tx.phase === "failed") tx.reset();
                const amountRaw = parseUnits(amount.toFixed(USDC.decimals), USDC.decimals);
                void tx.run(
                  address,
                  mode === "add" ? buildAddSavingsCalls(address, amountRaw) : buildWithdrawSavingsCalls(address, amountRaw, all),
                  undefined,
                  [{ kind: mode === "add" ? "save" : "unsave", symbol: "USDC", amount }],
                );
              }}
            />
          </>
        )}
      </SheetSteps>
    </SheetShell>
  );
}
