"use client";

import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { TabHeader } from "@/components/gg/Screen";
import { ActivityAvatar, describeActivity } from "@/components/gg/Activity";
import { useActivity, type ActivityRow } from "@/hooks/useActivity";
import type { ActivityItem } from "@/lib/activity/decode";
import { txUrl } from "@/lib/chain";

export default function ActivityPage() {
  return <RequireAccount>{(address) => <Activity address={address} />}</RequireAccount>;
}

const when = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

function Activity({ address }: { address: `0x${string}` }) {
  const { rows, isLoading, isError, refetch } = useActivity(address);

  return (
    <div className="relative flex min-h-dvh flex-col gap-4 px-5 pt-[54px]">
      <TabHeader title="Activity" />
      {isLoading ? (
        <div aria-busy className="h-[300px] animate-pulse rounded-[22px] bg-chip" />
      ) : isError ? (
        <div className="rounded-[22px] bg-card p-4 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
          <p role="alert" className="m-0 text-[15px]">We couldn’t load your activity.</p>
          <button type="button" onClick={() => refetch()} className="mt-3 h-11 rounded-full bg-chip px-4 font-semibold">Try again</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-[22px] bg-card p-4 text-[15px] text-ink-mid shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
          Nothing yet. Buys, backing, credit and repayments made in GreedyGoose show up here.
        </div>
      ) : (
        <ol className="num m-0 list-none rounded-[22px] bg-card px-[18px] py-0.5 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
          {rows.map((row, i) => (
            <Row key={row.key} row={row} last={i === rows.length - 1} />
          ))}
        </ol>
      )}
      <TabBar />
    </div>
  );
}

function Row({ row, last }: { row: ActivityRow; last: boolean }) {
  const items = row.items.length ? row.items : [{ kind: "send", symbol: "USDC", amount: 0 } as ActivityItem];
  const main = items[0];
  const d = describeActivity(main);
  const extra = items.length - 1;
  return (
    <li className={`flex items-center gap-2.5 px-0.5 py-3.5 ${last ? "" : "border-b border-[#e7e1d2]"}`}>
      <ActivityAvatar symbol={main.symbol} size={40} />
      <div className="min-w-0 grow">
        <div className="truncate text-[15px] font-semibold leading-[1.25]">
          {row.items.length ? d.title : "Transaction"}
          {extra > 0 && <span className="font-medium text-subtle"> +{extra} more</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ink-mid">
          <span>{when(row.time)}</span>
          {row.status !== "done" && (
            <span className={`rounded-full px-2 py-px text-[11px] font-semibold ${row.status === "pending" ? "bg-[#f6ead0] text-watch-text" : "bg-act-bg text-act"}`}>
              {row.status === "pending" ? "Confirming" : "Failed"}
            </span>
          )}
          {row.hash && (
            <a href={txUrl(row.hash)} target="_blank" rel="noreferrer" className="text-subtle underline">Base</a>
          )}
        </div>
      </div>
      {row.items.length > 0 && (
        <div className="max-w-[45%] text-right text-[14px] font-semibold leading-[1.25]">
          {d.sign}
          {d.amount}
        </div>
      )}
    </li>
  );
}
