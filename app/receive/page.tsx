"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { AddressQr } from "@/components/gg/AddressQr";
import { ArrivedCard, ConvertSheet } from "@/components/gg/CashSetup";
import { BackIcon, CopyIcon } from "@/components/gg/icons";
import { useAccountName } from "@/hooks/useAccountName";
import { useCashSetup } from "@/hooks/useCashSetup";
import { useEntryBalances } from "@/hooks/useEntryBalances";
import { usePosition } from "@/hooks/usePosition";
import { aprToApy } from "@/lib/aave/math";
import { arrivedCoins, arrivedView, rateText, type Arrived } from "@/lib/cashSetup";
import { shortAddress } from "@/lib/formatting";

export default function ReceivePage() {
  return <RequireAccount>{(address) => <AddMoney address={address} />}</RequireAccount>;
}

/**
 * Design board "Add money" (AddMoney.dc.html), the Pay tab, saying what's true now (D20): the dollars it takes on Base,
 * that they arrive as cash, and the rate they earn once earning is set up (the live rate; nothing about earning
 * before then). Other dollars that nothing converts on its own get "Turn into cash", as on Home. The QR and the copy
 * button give the address, which every wallet reads. Auto top up is parked (PARKED.md).
 */
function AddMoney({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  const { data: name } = useAccountName(address);
  const setup = useCashSetup(address);
  const arrived = arrivedView(arrivedCoins(useEntryBalances(address)), setup.entry);
  const [converting, setConverting] = useState<{ coins: Arrived[]; open: boolean; key: number } | null>(null);
  const earning = setup.save === "on" || setup.save === "starting";
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

      {arrived.kind === "ask" && <ArrivedCard text={arrived.text} onConvert={() => setConverting({ coins: arrived.coins, open: true, key: Date.now() })} />}

      <div className="flex flex-col gap-3.5 rounded-[22px] bg-card p-5">
        <span className="font-mono text-xs uppercase tracking-[0.08em] text-ink-mid">Send dollars to your name</span>
        <div className="flex items-center justify-between gap-3">
          <span className="num flex min-w-0 flex-col gap-0.5">
            <span className="select-all truncate text-2xl font-semibold tracking-[-0.02em]">{name ?? shortAddress(address)}</span>
            {name && <span className="select-all text-xs text-subtle">{shortAddress(address)}</span>}
          </span>
          <button type="button" onClick={copy} aria-label="Copy address" className="flex size-11 shrink-0 items-center justify-center rounded-[22px] bg-chip text-ink">
            <CopyIcon />
          </button>
        </div>
        <AddressQr address={address} />
        <p className="num m-0 text-sm leading-[1.45] text-ink-mid">
          USDC, USDT, USDe or USDS on Base.{" "}
          {earning && data ? `They arrive as cash and earn ${rateText(aprToApy(data.savingsApr))}.` : "They arrive as cash."}
        </p>
      </div>

      <div className="flex flex-col gap-1.5 rounded-[22px] bg-card-bone px-5 py-[18px]">
        <span className="text-[15px] font-semibold">Already hold stocks with JAW?</span>
        <p className="m-0 text-sm leading-[1.45] text-ink-2">
          They are already here. Any supported stock in your JAW account shows up on Home, ready to back credit.
        </p>
      </div>

      <TabBar />
      {converting && (
        <ConvertSheet
          key={converting.key}
          open={converting.open}
          onClose={() => setConverting({ ...converting, open: false })}
          user={address}
          coins={converting.coins}
          setup={setup}
        />
      )}
    </div>
  );
}
