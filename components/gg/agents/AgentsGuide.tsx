"use client";

import type { ReactNode } from "react";
import { AgentMark } from "../activity/Activity";
import { Button } from "../kit/Button";
import { GuideIcon } from "../kit/icons";
import { SheetShell, SheetSteps } from "../kit/SheetShell";
import { LevelBar } from "./ProtectCard";
import { MixPicture } from "./RebalanceCard";
import { CASH_AGENT } from "@/config/risk";
import { AGENTS_GUIDE as G } from "@/lib/agents/guide";
import type { MixSlot } from "@/lib/agents/rebalanceCard";

/*
 * "How it works" on the Agents tab (Adrian, 2026-10-20, board 7m): a button beside the title opens a sheet that says
 * how Protect and Rebalance work, each with its own picture from its card: Protect's bar while it brings the credit
 * back, and a three-stock mix with one stock to sell and one to buy.
 */

/** The button beside the Agents title. */
export function AgentsGuideButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-2xl bg-card-bone pl-2.5 pr-3 text-[13px] font-semibold text-ink transition-transform active:scale-[0.97]"
    >
      <GuideIcon size={14} />
      {G.button}
    </button>
  );
}

/** Protect stepping in: the credit just under its line, on its way back to the target. */
const PROTECT_BAR = {
  hf: CASH_AGENT.triggerHf - 0.01,
  line: CASH_AGENT.triggerHf,
  target: CASH_AGENT.targetHf,
  guarded: true,
  working: true,
  dropPct: null,
};

/** Apple short of its 30%, NVIDIA past its 50%, Tesla on its 20%. */
const MIX: MixSlot[] = [
  { reserveId: 0, targetBps: 3_000, offset: -1, side: "buy" },
  { reserveId: 5, targetBps: 5_000, offset: 1, side: "sell" },
  { reserveId: 6, targetBps: 2_000, offset: 0, side: null },
];

export function AgentsGuideSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      look="info"
      title={G.title}
      description={G.lead}
    >
      <SheetSteps stepKey="agents-guide" className="flex flex-col gap-3 leading-[normal]">
        <Agent agent="Protect" tag={G.protect.tag} steps={G.protect.steps} note={G.protect.note}>
          <LevelBar bar={PROTECT_BAR} />
        </Agent>
        <Agent agent="Rebalance" tag={G.rebalance.tag} steps={G.rebalance.steps} note={G.rebalance.note}>
          <MixPicture slots={MIX} faded={false} />
        </Agent>
        <p className="m-0 rounded-[22px] bg-card-bone px-[18px] py-4 text-sm leading-5 text-ink">{G.both}</p>
        <Button variant="dark" size="lg" onClick={onClose}>
          {G.done}
        </Button>
      </SheetSteps>
    </SheetShell>
  );
}

function Agent({
  agent,
  tag,
  steps,
  note,
  children,
}: {
  agent: "Protect" | "Rebalance";
  tag: string;
  steps: readonly string[];
  note: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={agent} className="flex flex-col rounded-[22px] bg-card p-[18px] shadow-card-elev">
      <div className="flex items-center gap-2.5">
        <AgentMark agent={agent} size={32} />
        <div className="flex flex-col">
          <span className="text-[17px] font-semibold leading-[21px]">{agent}</span>
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-mid">{tag}</span>
        </div>
      </div>
      {children}
      <ol className="m-0 mt-3.5 flex list-none flex-col gap-2.5 p-0">
        {steps.map((s, i) => (
          <li key={s} className="flex items-start gap-2.5">
            <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-ground font-mono text-[11px] font-medium">
              {i + 1}
            </span>
            <span className="text-[15px] leading-[21px]">{s}</span>
          </li>
        ))}
      </ol>
      <p className="m-0 mt-3.5 text-[13px] leading-[18px] text-ink-mid">{note}</p>
    </section>
  );
}
