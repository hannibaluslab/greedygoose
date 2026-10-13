"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { SubHeader } from "@/components/gg/Screen";
import { UnlockSheet } from "@/components/gg/UnlockSheet";
import { StockAvatar } from "@/components/gg/StockAvatar";
import { ChevronRight, LockIcon } from "@/components/gg/icons";
import { useCollateralFactors, usePosition } from "@/hooks/usePosition";
import { EQUITIES } from "@/lib/tokens/registry";
import { formatShares, formatUsd } from "@/lib/formatting";

export default function UnlockPage() {
  return <RequireAccount>{(address) => <Unlock address={address} />}</RequireAccount>;
}

function Unlock({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  const cfs = useCollateralFactors(data?.holdings);
  const [selected, setSelected] = useState<string | null>(useSearchParams().get("s"));
  const locked = data?.holdings.filter((h) => h.lockedUsd >= 0.01) ?? [];
  const stock = EQUITIES.find((e) => e.symbol === selected);
  const holding = data?.holdings.find((h) => h.symbol === selected);

  return (
    <div className="flex min-h-dvh flex-col gap-4 px-5 pb-[34px] pt-[54px]">
      <SubHeader label="Collateral" back="/portfolio" />
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em]">Unlock stocks</h1>
        <p className="m-0 text-sm text-muted">Take collateral back to your account. Aave keeps enough to cover what you owe.</p>
      </div>
      {!data ? (
        <div aria-busy className="h-[300px] animate-pulse rounded-[22px] bg-chip" />
      ) : locked.length === 0 ? (
        <div className="rounded-[22px] bg-card p-4 text-[15px] shadow-[0_1px_3px_rgba(14,13,11,0.06)]">Nothing is locked as collateral.</div>
      ) : (
        <ul className="num m-0 list-none rounded-[22px] bg-card px-[18px] py-0.5 shadow-[0_1px_3px_rgba(14,13,11,0.06)]">
          {locked.map((h, i) => (
            <li key={h.symbol} className={i < locked.length - 1 ? "border-b border-[#e7e1d2]" : ""}>
              <button type="button" onClick={() => setSelected(h.symbol)} className="flex w-full items-center gap-2.5 px-0.5 py-3.5 text-left">
                <StockAvatar symbol={h.symbol} size={40} />
                <div className="min-w-0 grow">
                  <div className="text-[15px] font-semibold leading-tight">{h.name}</div>
                  <div className="mt-0.5 inline-flex items-center gap-1 text-[13px] font-medium text-muted"><LockIcon size={9} />{formatShares(h.lockedShares)} locked</div>
                </div>
                <div className="text-[15px] font-semibold">{formatUsd(h.lockedUsd)}</div>
                <ChevronRight className="shrink-0 text-[#b9b3a6]" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {stock && holding && data && (
        <UnlockSheet user={address} stock={stock} holding={holding} data={data} cf={cfs?.[stock.symbol]} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
