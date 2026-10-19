"use client";

import type { ReactNode } from "react";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { Button } from "./kit/Button";
import { StatusBar, StatusPill } from "./Status";
import { AAVE_LINE_HF, CREDIT_CAP, RISK } from "@/config/risk";
import { useBackingFactorsRead, type PositionData } from "@/hooks/usePosition";
import { PROTECT_LINE } from "@/lib/agents/list";
import { formatUsd } from "@/lib/formatting";
import { healthMargins, healthParts } from "@/lib/risk/health";
import { STATUS_LABEL, type Status } from "@/lib/risk/status";

const hf = (n: number) => n.toFixed(2);
/** A fall in whole percents, rounded down: the margin is never shown as more than it is. */
const pct = (f: number) => `${Math.floor(f * 100 + 1e-9)}%`;

/**
 * The scale, from the top: where each band starts and what happens in it. Act is a warning only; Protect's line, under
 * it, is where Protect steps in (Adrian, 2026-10-19), still in Act, so its row wears Act's pill.
 */
const SCALE: { key: string; status: Exclude<Status, "none">; range: string; line: string }[] = [
  { key: "safe", status: "safe", range: `${RISK.safeMin} and up`, line: "Nothing to do." },
  {
    key: "watch",
    status: "watch",
    range: `${RISK.watchMin} to ${RISK.safeMin}`,
    line: `Nothing is sold. New credit and free up stop at ${CREDIT_CAP.minHf}.`,
  },
  {
    key: "act",
    status: "act",
    range: `Under ${RISK.watchMin}`,
    line: `A warning. Protect steps in at ${PROTECT_LINE}.`,
  },
  {
    key: "protect",
    status: "act",
    range: `Under ${PROTECT_LINE}`,
    line: "Protect repays from your cash, then sells if needed.",
  },
];

/** How far the stocks can fall, together, before Aave's line (and Act, while the credit is above it). */
function marginLine(health: number): string {
  const m = healthMargins(health);
  if (health <= AAVE_LINE_HF)
    return "Under Aave’s line. Part of your stocks can be sold now. Repay to get back over it.";
  if (health < RISK.watchMin) return `In Act. If your stocks fall ${pct(m.toAave)} more, Aave can sell part of them.`;
  return `Your stocks can fall ${pct(m.toAave)} before Aave’s line, ${pct(m.toAct)} before Act.`;
}

/**
 * "My credit status", from Credit's ⓘ on Home: the credit's health and how far the stocks can fall before Aave's line;
 * how the health is worked out on Aave's rules (each stock's value × the share Aave counts, ÷ what's owed); and the
 * scale, Safe, Watch, Act and Protect's line at 1.03, down to Aave's line at 1.0. With nothing owed, the scale only.
 */
export function StatusSheet({
  open,
  onClose,
  status,
  data,
}: {
  open: boolean;
  onClose: () => void;
  status: Status;
  data: PositionData;
}) {
  const owes = status !== "none" && data.debtUsd > 0;
  const { cfs } = useBackingFactorsRead(open && owes ? data.holdings : undefined);
  const parts = owes ? healthParts(data.holdings, cfs, data.debtUsd) : null;
  const health = owes ? data.healthFactor : null;
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      look="info"
      title="My credit status"
      titleAccessory={<StatusPill status={status} size="sm" />}
      description={
        owes
          ? "How far your credit is from stocks being sold, on Aave’s rules."
          : "Nothing is owed, so there’s no status yet. It starts with your first credit."
      }
    >
      <SheetSteps stepKey="status" className="num flex flex-col gap-3 leading-[normal]">
        {health !== null && (
          <Card>
            <div className="flex items-baseline justify-between">
              <span className="text-[14px] font-medium text-ink-mid">Health</span>
              <span className="text-[30px] font-semibold tracking-[-0.03em]">{hf(health)}</span>
            </div>
            <StatusBar healthFactor={health} label={`Now ${STATUS_LABEL[status]}`} />
            <p className="m-0 text-[14px] font-medium leading-snug text-ink">{marginLine(health)}</p>
          </Card>
        )}
        {owes && (
          <Card>
            <span className="label">How it’s worked out</span>
            {parts ? (
              <>
                <dl className="m-0 flex flex-col gap-2">
                  {parts.parts.map((p) => (
                    <Line
                      key={p.symbol}
                      label={p.name}
                      middle={`${formatUsd(p.valueUsd)} × ${Math.round(p.cf * 100)}%`}
                      value={formatUsd(p.backsUsd)}
                    />
                  ))}
                </dl>
                <dl className="m-0 flex flex-col gap-2 border-t border-line-field pt-2.5">
                  <Line label="Backs your credit" value={formatUsd(parts.backsUsd)} />
                  <Line label="÷ You owe" value={formatUsd(data.debtUsd)} />
                  <Line label="= Health" value={health === null ? "–" : hf(health)} strong />
                </dl>
                <p className="m-0 text-[12px] leading-snug text-subtle">
                  Aave counts a share of each stock’s value, the % beside it.
                </p>
              </>
            ) : (
              <div aria-busy className="h-[92px] animate-pulse rounded-[14px] bg-chip" />
            )}
          </Card>
        )}
        <Card>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {SCALE.map((r) => (
              <li key={r.key} className="flex items-start gap-2.5">
                <span className="w-[58px] shrink-0">
                  <StatusPill status={r.status} size="sm" />
                </span>
                <span className="flex flex-col gap-0.5 text-[13px] leading-snug">
                  <span className="font-semibold text-ink">{r.range}</span>
                  <span className="text-ink-2">{r.line}</span>
                </span>
              </li>
            ))}
            <li className="flex items-start gap-2.5 border-t border-line-field pt-3">
              <span className="w-[58px] shrink-0">
                <span className="inline-flex h-[22px] items-center rounded-[11px] bg-ink px-2 text-[11px] font-semibold text-on-ink">
                  {AAVE_LINE_HF.toFixed(1)}
                </span>
              </span>
              <span className="flex flex-col gap-0.5 text-[13px] leading-snug">
                <span className="font-semibold text-ink">Aave’s line</span>
                <span className="text-ink-2">Under it, Aave can sell part of your stocks to repay what you owe.</span>
              </span>
            </li>
          </ul>
        </Card>
        <Button variant="dark" onClick={onClose} className="mt-1 w-full">
          Got it
        </Button>
      </SheetSteps>
    </SheetShell>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 rounded-[22px] bg-card p-4 shadow-card-elev">{children}</div>;
}

/** One line of the sum: what it is, an optional working ("$5.01 × 79%"), and the dollars. */
function Line({ label, middle, value, strong }: { label: string; middle?: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline gap-2 text-[14px] ${strong ? "font-semibold text-ink" : "text-ink-2"}`}>
      <dt className="flex min-w-0 grow items-baseline justify-between gap-2">
        <span className="truncate">{label}</span>
        {middle && <span className="shrink-0 text-[12.5px] font-normal text-ink-mid">{middle}</span>}
      </dt>
      <dd className="m-0 w-[72px] shrink-0 text-right font-semibold text-ink">{value}</dd>
    </div>
  );
}
