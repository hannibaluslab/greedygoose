"use client";

import { useState } from "react";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { SubHeader, WhiteCard } from "@/components/gg/Screen";
import { StockAvatar } from "@/components/gg/StockAvatar";
import { EQUITIES } from "@/lib/tokens/registry";

export default function ReceivePage() {
  return <RequireAccount>{(address) => <Receive address={address} />}</RequireAccount>;
}

function Receive({ address }: { address: `0x${string}` }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 pb-[34px] pt-[54px]">
      <SubHeader label="Receive" />
      <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em]">Receive stocks or USDC</h1>
      <WhiteCard className="flex flex-col gap-3 p-[18px]">
        <span className="label">Your address on Base</span>
        <code className="num break-all text-[15px]">{address}</code>
        <button type="button" onClick={copy} className="h-[52px] rounded-[26px] bg-ink text-[15px] font-semibold text-on-ink">
          {copied ? "Copied" : "Copy address"}
        </button>
      </WhiteCard>
      <WhiteCard className="flex flex-col gap-3 p-[18px]">
        <span className="label">Supported</span>
        <div className="flex flex-wrap gap-2">
          {EQUITIES.map((e) => (
            <span key={e.symbol} className="inline-flex items-center gap-2 rounded-full bg-ground py-1 pl-1 pr-3 text-[13px] font-medium">
              <StockAvatar symbol={e.symbol} size={24} />{e.name}
            </span>
          ))}
        </div>
        <p className="m-0 text-[13px] leading-snug text-muted">
          Send only on <strong className="text-ink">Base</strong>: Coinbase tokenized stocks and USDC. Anything else won’t show up here.
        </p>
      </WhiteCard>
    </div>
  );
}
