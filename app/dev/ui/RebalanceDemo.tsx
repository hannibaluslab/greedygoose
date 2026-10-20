"use client";

import { useSyncExternalStore } from "react";
import { isAddress } from "viem";
import {
  RebalanceSettings,
  RebalanceSettingsView,
  type SettingsHolding,
} from "@/components/gg/agents/RebalanceSettings";
import type { MixRow } from "@/lib/agents/mix";
import { EQUITIES } from "@/lib/tokens/registry";

// Sample figures for the gallery only: the old Manage board's NVIDIA, Apple and Tesla at 43/26/30 of their free shares,
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
    backingUsd: e.reserveId === 6 ? 3_300 : 0,
  };
});
const SAVED = EQUITIES.map((e) => ({ 5: 4_300, 0: 2_700, 6: 3_000 })[e.reserveId as 0 | 5 | 6] ?? 0);
const TARGET: MixRow[] = [
  { reserveId: 5, bps: 5_000 },
  { reserveId: 0, bps: 2_500 },
  { reserveId: 6, bps: 2_500 },
];
/** The executor's CAP_MAX here: the Rebalancer's grant is at it (no amount limit). */
const CAP_MAX = 10_000_000_000n;
const TERMS = { capRaw: CAP_MAX, limitsRaw: EQUITIES.map((e) => (SAVED[e.reserveId] > 0 ? 1n : 0n)) };
/** A grant from before the Rebalancer had no amount limit, $100 a week: the next Save grants it again. */
const CAPPED = { ...TERMS, capRaw: 100_000_000n };
const noop = () => {};
const noopSubscribe = () => () => {};
const previewAs = () => {
  const as = new URLSearchParams(window.location.search).get("as");
  return as && isAddress(as) ? as : null;
};

const STATES = [
  { key: "not-live", title: "Not live yet (no executor)", configured: false, saved: null, terms: null, draft: TARGET },
  { key: "new-mix", title: "New mix · Save", configured: true, saved: SAVED, terms: TERMS, draft: TARGET },
  {
    key: "not-whole",
    title: "Not 100% yet",
    configured: true,
    saved: SAVED,
    terms: TERMS,
    draft: [TARGET[0], TARGET[1], { reserveId: 6, bps: 2_000 }],
  },
  {
    key: "on-target",
    title: "On target · nothing to save",
    configured: true,
    saved: SAVED,
    terms: TERMS,
    draft: undefined,
  },
  {
    key: "capped",
    title: "A capped grant from before · a new grant, one Face ID",
    configured: true,
    saved: SAVED,
    terms: CAPPED,
    draft: undefined,
  },
  {
    key: "switch-on",
    title: "Off · first mix switches it on",
    configured: true,
    saved: EQUITIES.map(() => 0),
    terms: null,
    draft: TARGET,
  },
] as const;

type RebalanceState = (typeof STATES)[number]["key"];

/** RebalanceSettings' body in one state, from fixtures: what the Agents gallery's Rebalance sheet holds. */
export function RebalanceStateBody({ state }: { state: RebalanceState }) {
  const s = STATES.find((x) => x.key === state)!;
  return (
    <RebalanceSettingsView
      holdings={HOLDINGS}
      saved={s.saved}
      terms={s.terms}
      capMaxRaw={s.configured ? CAP_MAX : null}
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
  );
}

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
          <RebalanceStateBody state={s.key} />
        </div>
      ))}
    </div>
  );
}
