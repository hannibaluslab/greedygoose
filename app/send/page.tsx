"use client";

import { RequireAccount } from "@/components/wallet/RequireAccount";
import { SendHeader, SendScreen } from "@/components/gg/Send";
import { TabBar } from "@/components/gg/TabBar";
import { usePosition } from "@/hooks/usePosition";

/** The Send tab (D16: it replaced Pay, 2026-10-15). Receive, which Pay was, opens from its header and from Home's Top up. */
export default function SendPage() {
  return <RequireAccount>{(address) => <Send address={address} />}</RequireAccount>;
}

function Send({ address }: { address: `0x${string}` }) {
  const { data, isError, refetch } = usePosition(address);
  if (data) return <SendScreen user={address} data={data} />;
  return (
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 pt-[calc(env(safe-area-inset-top)+8px)] leading-[normal]">
      <SendHeader />
      {isError ? (
        <div className="flex flex-col items-start gap-2 pt-1">
          <p className="m-0 text-[15px] text-ink-mid">We couldn’t read your account from Base.</p>
          <button type="button" onClick={() => void refetch()} className="h-11 rounded-[22px] bg-chip px-4 text-sm font-semibold">
            Try again
          </button>
        </div>
      ) : (
        <div aria-busy className="flex flex-col gap-3">
          <span className="sr-only" role="status">Loading…</span>
          <div className="h-[118px] animate-pulse rounded-[16px] bg-chip" />
          <div className="h-[92px] animate-pulse rounded-[16px] bg-chip" />
          <div className="h-[84px] animate-pulse rounded-[12px] bg-chip" />
        </div>
      )}
      <TabBar />
    </div>
  );
}
