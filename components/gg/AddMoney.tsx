"use client";

import type { ReactNode } from "react";
import { toast } from "sonner";
import { SheetShell } from "@/components/sheets/SheetShell";
import { AddressQr } from "./AddressQr";
import { TurnIntoCash } from "./CashSetup";
import { CopyIcon } from "./icons";
import { useAccountName } from "@/hooks/useAccountName";
import { useCashSetup } from "@/hooks/useCashSetup";
import { useEntryBalances } from "@/hooks/useEntryBalances";
import { usePosition } from "@/hooks/usePosition";
import { aprToApy } from "@/lib/aave/math";
import { arrivedCoins, arrivedView, rateText } from "@/lib/cashSetup";
import { shortAddress } from "@/lib/formatting";

type AddMoneyProps = {
  address: `0x${string}`;
  /** The account's JAW name, once read. */
  name: string | null;
  /** "3.9%" while the cash earns; null before earning is set up. */
  rate: string | null;
  arrived?: ReactNode;
  onCopy: () => void;
};

/**
 * Design board "Add money" (AddMoney.dc.html), Receive, saying what's true now (D20): the dollars it takes on Base,
 * that they arrive as cash, and the rate they earn once earning is set up (`rate`, the live one; nothing about earning
 * before then). `arrived` is the "Turn into cash" card for other dollars nothing converts on its own. The QR and the
 * copy button give the address, which every wallet reads. Auto top up is parked (PARKED.md).
 *
 * No SheetSteps around it: "Turn into cash" opens its own sheet once it lands ("Do this automatically next time?"),
 * which a step host would fold into this one without its title.
 */
function AddMoneyBody({ address, name, rate, arrived, onCopy }: AddMoneyProps) {
  return (
    <div className="flex flex-col gap-4 leading-[normal]">
      {arrived}

      <div className="flex flex-col gap-3.5 rounded-[22px] bg-card p-5 shadow-card-elev">
        <span className="font-mono text-xs uppercase tracking-[0.08em] text-ink-mid">Send dollars to your name</span>
        <div className="flex items-center justify-between gap-3">
          <span className="num flex min-w-0 flex-col gap-0.5">
            <span className="select-all truncate text-2xl font-semibold tracking-[-0.02em]">
              {name ?? shortAddress(address)}
            </span>
            {name && <span className="select-all text-xs text-subtle">{shortAddress(address)}</span>}
          </span>
          <button
            type="button"
            onClick={onCopy}
            aria-label="Copy address"
            className="flex size-11 shrink-0 items-center justify-center rounded-[22px] bg-chip text-ink"
          >
            <CopyIcon />
          </button>
        </div>
        <AddressQr address={address} />
        <p className="num m-0 text-sm leading-[1.45] text-ink-mid">
          USDC, USDT, USDe or USDS on Base. {rate ? `They arrive as cash and earn ${rate}.` : "They arrive as cash."}
        </p>
      </div>

      <div className="flex flex-col gap-1.5 rounded-[22px] bg-card-bone px-5 py-[18px]">
        <span className="text-[15px] font-semibold">Already hold stocks in this account?</span>
        <p className="m-0 text-sm leading-[1.45] text-ink-2">
          They are already here. Every supported stock in it shows up on Home, ready to back credit.
        </p>
      </div>
    </div>
  );
}

/** The Top up sheet, plain values in, so the dev gallery draws it with fixtures. */
export function TopUpSheetView({ open, onClose, ...body }: AddMoneyProps & { open: boolean; onClose: () => void }) {
  return (
    <SheetShell open={open} onOpenChange={(next) => !next && onClose()} title="Add money">
      <AddMoneyBody {...body} />
    </SheetShell>
  );
}

/**
 * Top up (Adrian, 2026-10-15: "top up and repay should open a sheet not a full page"): Receive as a sheet over the page
 * it opens from (Home's Top up, the Cash sheet, Send's Receive, the Trade sheet, Protect's heads-up). It was the
 * /receive page, which now redirects to Home with this sheet open. "Turn into cash" prepares only while it's open.
 */
export function TopUpSheet({ open, address, onClose }: { open: boolean; address: `0x${string}`; onClose: () => void }) {
  const { data } = usePosition(address);
  const { data: name } = useAccountName(address);
  const setup = useCashSetup(address);
  const arrived = arrivedView(arrivedCoins(useEntryBalances(address)), setup.entry);
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
    <TopUpSheetView
      open={open}
      onClose={onClose}
      address={address}
      name={name ?? null}
      rate={earning && data ? rateText(aprToApy(data.savingsApr)) : null}
      arrived={<TurnIntoCash user={address} view={arrived} setup={setup} active={open} />}
      onCopy={() => void copy()}
    />
  );
}
