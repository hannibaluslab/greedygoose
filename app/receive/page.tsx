"use client";

import Link from "next/link";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { AddressQr } from "@/components/gg/AddressQr";
import { BackIcon, CopyIcon } from "@/components/gg/icons";
import { usePosition } from "@/hooks/usePosition";
import { shortAddress } from "@/lib/formatting";

export default function ReceivePage() {
  return <RequireAccount>{(address) => <AddMoney address={address} />}</RequireAccount>;
}

/**
 * Design board "Add money" (AddMoney.dc.html), the Pay tab. Until the name lookup is wired (Header) it shows the
 * address, and until the Entry agent converts other coins only USDC on Base lands as cash, so the label says so.
 * Money starts earning once Save sweeps it into savings, so the board's "earning interest right away" waits for Save.
 * Auto top up is parked (PARKED.md).
 */
function AddMoney({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      toast("Address copied");
    } catch {
      toast("Couldn’t copy. Press and hold the address instead.");
    }
  };

  return (
    <div className="relative flex min-h-dvh flex-col gap-5 px-5 pt-[60px] leading-[normal]">
      <div className="flex items-center gap-3">
        <Link href="/home" aria-label="Back" className="-ml-3 flex size-11 items-center justify-center text-ink"><BackIcon /></Link>
        <h1 className="m-0 text-[28px] font-semibold tracking-[-0.02em]">Add money</h1>
      </div>

      <div className="flex flex-col gap-3.5 rounded-[22px] bg-card p-5">
        <span className="font-mono text-xs uppercase tracking-[0.08em] text-ink-mid">Send USDC on Base to your address</span>
        <div className="flex items-center justify-between gap-3">
          <span className="num select-all text-2xl font-semibold tracking-[-0.02em]">{shortAddress(address)}</span>
          <button type="button" onClick={copy} aria-label="Copy address" className="flex size-11 shrink-0 items-center justify-center rounded-[22px] bg-chip text-ink">
            <CopyIcon />
          </button>
        </div>
        <AddressQr address={address} />
        <p className="m-0 text-sm leading-[1.45] text-ink-mid">
          {data?.cash.saveOn ? "It lands as dollars and starts earning interest right away." : "It lands as dollars in your cash."}
        </p>
      </div>

      <div className="flex flex-col gap-1.5 rounded-[22px] bg-card-bone px-5 py-[18px]">
        <span className="text-[15px] font-semibold">Already hold stocks with JAW?</span>
        <p className="m-0 text-sm leading-[1.45] text-ink-2">
          They are already here. Any supported stock in your JAW account shows up on Home, ready to back credit.
        </p>
      </div>

      <TabBar />
    </div>
  );
}
