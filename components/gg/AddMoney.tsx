"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AddressQr } from "./AddressQr";
import { TabBar } from "./TabBar";
import { BackIcon, CopyIcon } from "./icons";
import { shortAddress } from "@/lib/formatting";

/**
 * Design board "Add money" (AddMoney.dc.html), Receive (it was the Pay tab until Send replaced Pay), saying what's true now (D20): the dollars it takes on Base,
 * that they arrive as cash, and the rate they earn once earning is set up (`rate`, the live one; nothing about earning
 * before then). `arrived` is the "Turn into cash" card for other dollars nothing converts on its own. The QR and the
 * copy button give the address, which every wallet reads. Auto top up is parked (PARKED.md).
 */
export function AddMoneyView({
  address, name, rate, arrived, onCopy, back = "/home",
}: {
  address: `0x${string}`;
  /** The account's JAW name, once read. */
  name: string | null;
  /** "3.9%" while the cash earns; null before earning is set up. */
  rate: string | null;
  arrived?: ReactNode;
  onCopy: () => void;
  /** Where Back goes: Home, or Send when it opened from there. */
  back?: string;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col gap-5 px-5 pt-[calc(env(safe-area-inset-top)+14px)] leading-[normal]">
      <div className="flex items-center gap-3">
        <Link href={back} aria-label="Back" className="-ml-3 flex size-11 items-center justify-center text-ink"><BackIcon /></Link>
        <h1 className="m-0 text-[28px] font-semibold tracking-[-0.02em]">Add money</h1>
      </div>

      {arrived}

      <div className="flex flex-col gap-3.5 rounded-[22px] bg-card p-5">
        <span className="font-mono text-xs uppercase tracking-[0.08em] text-ink-mid">Send dollars to your name</span>
        <div className="flex items-center justify-between gap-3">
          <span className="num flex min-w-0 flex-col gap-0.5">
            <span className="select-all truncate text-2xl font-semibold tracking-[-0.02em]">{name ?? shortAddress(address)}</span>
            {name && <span className="select-all text-xs text-subtle">{shortAddress(address)}</span>}
          </span>
          <button type="button" onClick={onCopy} aria-label="Copy address" className="flex size-11 shrink-0 items-center justify-center rounded-[22px] bg-chip text-ink">
            <CopyIcon />
          </button>
        </div>
        <AddressQr address={address} />
        <p className="num m-0 text-sm leading-[1.45] text-ink-mid">
          USDC, USDT, USDe or USDS on Base. {rate ? `They arrive as cash and earn ${rate}.` : "They arrive as cash."}
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
