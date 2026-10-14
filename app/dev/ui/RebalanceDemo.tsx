"use client";

import { useSyncExternalStore } from "react";
import { isAddress } from "viem";
import { RebalanceSettings, RebalanceSettingsView, type SettingsHolding } from "@/components/gg/agents/RebalanceSettings";
import { rebalanceOptions, type MixRow } from "@/lib/agents/mix";
import { EQUITIES } from "@/lib/tokens/registry";

// Sample figures for the gallery only: the Manage board's NVIDIA, Apple and Tesla at 43/26/30 of their free shares,
// with $3,300 of Tesla backing credit. The trades come from the Rebalancer's own rule on these figures.
const FREE = [
  { reserveId: 5, usd: 4_300, price: 178.57 },
  { reserveId: 0, usd: 2_600, price: 222.22 },
  { reserveId: 6, usd: 3_000, price: 378.38 },
];
const HOLDINGS: SettingsHolding[] = EQUITIES.map((e) => {
  const f = FREE.find((x) => x.reserveId === e.reserveId);
  return {
    reserveId: e.reserveId,
    priceRaw: BigInt(Math.round((f?.price ?? 100) * 1e8)),
    freeRaw: f ? BigInt(Math.round((f.usd / f.price) * 1e8)) : 0n,
    lockedUsd: e.reserveId === 6 ? 3_300 : 0,
  };
});
const SAVED = EQUITIES.map((e) => ({ 5: 4_300, 0: 2_700, 6: 3_000 })[e.reserveId as 0 | 5 | 6] ?? 0);
const TARGET: MixRow[] = [
  { reserveId: 5, bps: 5_000 },
  { reserveId: 0, bps: 2_500 },
  { reserveId: 6, bps: 2_500 },
];
const TERMS = { capRaw: 500_000_000n, limitsRaw: EQUITIES.map((e) => (SAVED[e.reserveId] > 0 ? 1n : 0n)) };
const noop = () => {};
const noopSubscribe = () => () => {};
const previewAs = () => {
  const as = new URLSearchParams(window.location.search).get("as");
  return as && isAddress(as) ? as : null;
};

const STATES = [
  { key: "not-live", title: "Not live yet (no executor)", configured: false, saved: null, terms: null, draft: TARGET },
  { key: "one-face-id", title: "New mix · one Face ID", configured: true, saved: SAVED, terms: TERMS, draft: TARGET },
  { key: "not-whole", title: "Not 100% yet", configured: true, saved: SAVED, terms: TERMS, draft: [TARGET[0], TARGET[1], { reserveId: 6, bps: 2_000 }] },
  { key: "on-target", title: "On target · nothing to save", configured: true, saved: SAVED, terms: TERMS, draft: undefined },
  { key: "switch-on", title: "Off · first mix switches it on", configured: true, saved: EQUITIES.map(() => 0), terms: null, draft: TARGET },
] as const;

/** RebalanceSettings' body in each state, from fixtures (nothing reads the chain). */
export function RebalanceDemo() {
  const as = useSyncExternalStore(noopSubscribe, previewAs, () => null);
  return (
    <div className="flex flex-col gap-6">
      <div data-state="live" className="flex flex-col gap-2 rounded-[26px] bg-sheet p-3">
        <span className="text-xs font-semibold text-subtle">Live: the real component on ?as=</span>
        {as ? <RebalanceSettings account={as} /> : <span className="text-xs text-subtle">Add ?as=0x… to the URL.</span>}
      </div>
      {STATES.map((s) => (
        <div key={s.key} data-state={s.key} className="flex flex-col gap-2 rounded-[26px] bg-sheet p-3">
          <span className="text-xs font-semibold text-subtle">{s.title}</span>
          <RebalanceSettingsView
            holdings={HOLDINGS}
            saved={s.saved}
            options={rebalanceOptions()}
            terms={s.terms}
            capMaxRaw={s.configured ? 10_000_000_000n : null}
            configured={s.configured}
            connected
            running={!!s.terms}
            feeBlocked={false}
            feeLoading={false}
            busy={false}
            phase="idle"
            error={null}
            onSave={noop}
            draft={s.draft ? [...s.draft] : undefined}
          />
        </div>
      ))}
    </div>
  );
}
