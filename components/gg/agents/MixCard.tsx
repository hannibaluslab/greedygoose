"use client";

import { useState } from "react";
import { ManageCard, MixSlider } from "@/components/gg/Manage";
import { StockAvatar, tickerOf } from "@/components/gg/kit/StockAvatar";
import { PlusIcon } from "@/components/gg/kit/icons";
import {
  MIX_WHOLE,
  inHomeOrder,
  mixWeights,
  nowPercents,
  setMixRow,
  type MixHolding,
  type MixRow,
} from "@/lib/agents/mix";
import { EQUITIES } from "@/lib/tokens/registry";

/**
 * My mix: a target for each stock, which never adds up past 100%, and the share of the free stock each holds now. Its
 * rows keep Home's order (boards 7e–7h), an added stock too.
 */
export function MixCard({
  holdings,
  rows,
  onRows,
}: {
  holdings: readonly MixHolding[];
  rows: MixRow[];
  onRows: (rows: MixRow[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const sum = mixWeights(rows).reduce((a, b) => a + b, 0);
  const whole = rows.length > 0 && sum === MIX_WHOLE;
  const now = nowPercents(holdings, rows);
  const notInMix = EQUITIES.filter((e) => !rows.some((r) => r.reserveId === e.reserveId));
  const add = (reserveId: number) => {
    onRows(inHomeOrder([...rows, { reserveId, bps: 0 }]));
    setAdding(false);
  };
  return (
    <ManageCard>
      <div className="mb-0.5 flex items-center justify-between gap-3">
        <span className="text-[17px] font-semibold">My mix</span>
        {/* Ruling 24: no "Adds up to" before a stock is in the mix. */}
        {rows.length > 0 && (
          <span
            role="status"
            className={`flex h-6 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-xl px-2.5 text-xs font-semibold ${whole ? "bg-pos-soft text-pos" : "bg-watch-soft text-watch-text"}`}
          >
            {whole && <CheckMark />}
            Adds up to {Math.round(sum / 100)}%
          </span>
        )}
      </div>
      {rows.length === 0 && <p className="m-0 text-[13px] text-ink-mid">Add a stock to start your mix.</p>}
      {rows.map((r, i) => {
        const e = EQUITIES[r.reserveId];
        return (
          <div key={r.reserveId} className="flex items-center gap-2.5">
            <StockAvatar symbol={e.symbol} size={30} font={tickerOf(e.symbol).length > 4 ? 7 : 8.5} />
            <div className="flex w-[78px] shrink-0 flex-col">
              <span className="whitespace-nowrap text-sm font-semibold">{e.name}</span>
              <span className="num text-[11px] text-ink-mid">{now[i] === null ? "none now" : `now ${now[i]}%`}</span>
            </div>
            {/* Never past 100% in all: a target stops where the other stocks' leave off (setMixRow). */}
            <MixSlider name={e.name} bps={r.bps} onChange={(bps) => onRows(setMixRow(rows, r.reserveId, bps))} />
            <span className="num w-[38px] shrink-0 text-right text-[15px] font-semibold">
              {Math.round(r.bps / 100)}%
            </span>
          </div>
        );
      })}
      <AddStock notInMix={notInMix} adding={adding} onOpen={() => setAdding(true)} onAdd={add} />
    </ManageCard>
  );
}

/** The tick in "Adds up to 100%" (boards 7e–7h). */
function CheckMark() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

/** "Add a stock" under the mix, then the stocks not in it to pick from. */
function AddStock({
  notInMix,
  adding,
  onOpen,
  onAdd,
}: {
  notInMix: readonly { symbol: string; name: string; reserveId: number }[];
  adding: boolean;
  onOpen: () => void;
  onAdd: (reserveId: number) => void;
}) {
  return (
    <>
      {notInMix.length > 0 && !adding && (
        <button
          type="button"
          onClick={onOpen}
          className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[18px] border-[1.5px] border-dashed border-line-strong text-[13px] font-semibold text-ink"
        >
          <PlusIcon size={14} strokeWidth={2.2} />
          Add a stock
        </button>
      )}
      {adding && (
        <div role="group" aria-label="Add a stock" className="flex flex-wrap gap-1.5">
          {notInMix.map((e) => (
            <button
              key={e.symbol}
              type="button"
              onClick={() => onAdd(e.reserveId)}
              className="flex h-[34px] items-center gap-1.5 rounded-[17px] bg-pill pl-1 pr-3 text-[13px] font-semibold text-ink"
            >
              <StockAvatar symbol={e.symbol} size={26} font={tickerOf(e.symbol).length > 4 ? 6 : 7.5} />
              {e.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
