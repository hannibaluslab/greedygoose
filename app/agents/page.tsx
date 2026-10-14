"use client";

import Link from "next/link";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { TabHeader } from "@/components/gg/Screen";
import { GuardianPill } from "@/components/gg/Status";
import { ActivityIcon, ChevronRight, ShieldIcon } from "@/components/gg/icons";
import { usePosition } from "@/hooks/usePosition";
import { useGuardian } from "@/hooks/useGuardian";
import { formatUsd } from "@/lib/formatting";

export default function AgentsPage() {
  return <RequireAccount>{(address) => <Agents address={address} />}</RequireAccount>;
}

/** Design board "7 · Agents" (Agents.dc.html). The Cash Agent card opens Guardian (app/guardian); the feed is Activity. */
function Agents({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  const g = useGuardian(address);
  const cap = g.status === "on" && g.record ? Number(g.record.capRaw) / 1e6 : null;

  return (
    <div className="relative flex min-h-dvh flex-col gap-4 px-5 pt-[54px]">
      <div className="flex flex-col gap-1">
        <TabHeader title="Agents" />
        <p className="m-0 text-sm text-ink-mid">They act for you, inside limits you sign with Face ID.</p>
      </div>

      <Link href="/guardian" className="flex flex-col gap-3 rounded-[22px] bg-card p-[18px] text-ink no-underline shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex size-[42px] shrink-0 items-center justify-center rounded-[21px] bg-brand text-ink">
            <ShieldIcon size={20} />
          </span>
          <span className="flex flex-1 flex-col">
            <span className="text-[17px] font-semibold">Cash Agent</span>
            <span className="text-[13px] text-ink-mid">Guardian</span>
          </span>
          <GuardianPill status={g.status} />
        </div>
        <p className="m-0 text-[14px] leading-snug text-ink-mid">
          If your credit slips into <b className="text-watch-text">Watch</b>, Guardian repays part of it from your savings
          {cap ? `, up to $${cap} a day` : ""}.
        </p>
        <div className="num flex items-center justify-between border-t border-hairline pt-3 text-[15px]">
          <span className="text-ink-mid">Savings</span>
          <span className="flex items-center gap-1 font-semibold">
            {data ? `${formatUsd(data.savingsUsd)} · earns ${(data.savingsApr * 100).toFixed(2)}%` : "…"}
            <ChevronRight className="text-subtle" />
          </span>
        </div>
      </Link>

      <Link href="/activity" className="flex items-center gap-3 rounded-[22px] bg-card px-4 py-3.5 text-ink no-underline shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-chip">
          <ActivityIcon size={18} />
        </span>
        <span className="flex flex-1 flex-col">
          <span className="text-[15px] font-semibold">Activity</span>
          <span className="text-[12.5px] text-ink-mid">Every move on your account, with a Base link</span>
        </span>
        <ChevronRight className="text-subtle" />
      </Link>

      <TabBar />
    </div>
  );
}
