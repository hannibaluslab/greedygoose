"use client";

import { maxUint160 } from "viem";
import { AgentMark } from "../activity/Activity";
import { ChevronRight } from "../kit/icons";
import { StockAvatar } from "../kit/StockAvatar";
import { useAgentFeed } from "@/hooks/useAgentFeed";
import { useAgents } from "@/hooks/useAgents";
import { useAgentSettings } from "@/hooks/useAgentSettings";
import { useNowSec } from "@/hooks/useNowSec";
import { usePosition, type PositionData } from "@/hooks/usePosition";
import { AGENTS_LIVE, GOOSE_EXECUTOR } from "@/lib/agents/config";
import { agentStatus } from "@/lib/agents/list";
import { rebalanceOptions } from "@/lib/agents/mix";
import { defaultNumbers, rebalanceOutlook, type OutlookInput } from "@/lib/agents/next";
import { startCapRaw } from "@/lib/agents/permissions";
import {
  rebalanceCard,
  type MixSlot,
  type PillTone,
  type RebalanceCardModel,
  type RebalanceFooter,
  type Side,
} from "@/lib/agents/rebalanceCard";
import { EQUITIES } from "@/lib/tokens/registry";

/*
 * Rebalance's card on the Agents overview, as picked on the boards (7a's on-target card, "Coin hop" for trades due):
 * the whole card is one button that opens Rebalance's sheet. RebalanceCard reads the account; RebalanceCardView takes
 * the plain model (lib/agents/rebalanceCard.ts), so the dev gallery draws every state.
 */

type Account = `0x${string}`;

/** Rebalance's card for `account`, from its own reads: the registry, JAW's list, the position and the agents' feed. */
export function RebalanceCard({ account, onOpen }: { account: Account; onOpen: () => void }) {
  const agents = useAgents(account);
  const settings = useAgentSettings(account);
  const { data: position } = usePosition(account);
  const feed = useAgentFeed(account);
  const nowSec = useNowSec();
  // The registry's mix and numbers are read once an executor is set; until then the card runs on the deploy defaults.
  const ready = !!position && nowSec > 0 && (!!settings || !GOOSE_EXECUTOR);
  const model = ready ? cardFor(position, nowSec, agents, settings, feed) : null;
  return <RebalanceCardView model={model} onOpen={onOpen} />;
}

function cardFor(
  position: PositionData,
  nowSec: number,
  agents: ReturnType<typeof useAgents>,
  settings: ReturnType<typeof useAgentSettings>,
  feed: ReturnType<typeof useAgentFeed>,
): RebalanceCardModel | null {
  const capMax = agents.capMaxRaw;
  const numbers = settings?.numbers ?? defaultNumbers(rebalanceOptions());
  const mixBps = settings?.mixBps ?? null;
  const rebalanceDay = settings?.rebalanceDay ?? 0;
  const outlook: OutlookInput = {
    nowSec,
    holdings: position.holdings,
    mixBps,
    capMaxRaw: capMax,
    rebalanceDay,
    debtUsd: position.debtUsd,
    totalBackingUsd: position.totalBackingUsd,
    avgCf: position.avgCf,
    left: { rebalance: agents.left.rebalance },
    // The grant it runs with, else the one it starts on: the executor's CAP_MAX (no amount limit).
    capRaw: { rebalance: agents.terms.rebalance?.capRaw ?? startCapRaw("rebalance", capMax ?? maxUint160) },
    numbers,
  };
  // Off without the user turning it off: its grant ran out, or the executor switched it off.
  const last = feed.switched.rebalance;
  const stopped =
    agents.status.rebalance !== "off" || last?.byUser
      ? 0
      : Math.max(agents.ranOut.rebalance ?? 0, last && !last.on ? last.at : 0);
  return rebalanceCard({
    live: AGENTS_LIVE,
    nowSec,
    status: agentStatus("rebalance", agents.status),
    waiting: agents.toFinish.includes("rebalance"),
    stoppedAt: stopped > 0 ? stopped : null,
    endsAt: agents.terms.rebalance?.end ?? null,
    fails: agents.fails,
    cooldownUntil: agents.cooldownUntil,
    rebalanceDay,
    holdings: position.holdings,
    mixBps,
    options: numbers.rebalance,
    outlook: rebalanceOutlook(outlook),
  });
}

const CARD =
  "flex w-full flex-col rounded-[22px] bg-card p-[18px] text-left text-ink shadow-[0_1px_2px_rgba(14,13,11,0.04),0_6px_20px_rgba(14,13,11,0.06)]";

const PILL: Record<PillTone, string> = {
  on: "bg-pos-soft text-pos",
  neutral: "bg-card-bone text-ink-mid",
  needs: "bg-needs-soft text-needs-ink",
  due: "bg-due-soft text-due-ink",
};

/** The card from its model; null draws its frame while the Rebalancer's state loads. It opens the sheet either way. */
export function RebalanceCardView({ model, onOpen }: { model: RebalanceCardModel | null; onOpen?: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={model?.label ?? "Rebalance. Open"}
      aria-busy={!model || undefined}
      className={`${CARD} transition-transform active:scale-[0.98]`}
    >
      <span className="flex h-8 items-center gap-2.5">
        <AgentMark agent="Rebalance" size={32} />
        <span className="min-w-0 grow truncate text-[17px] font-semibold">Rebalance</span>
        {model ? (
          <span
            className={`flex h-6 shrink-0 items-center whitespace-nowrap rounded-xl px-2.5 text-xs font-bold ${PILL[model.pill.tone]}`}
          >
            {model.pill.text}
          </span>
        ) : (
          <span className="h-6 w-14 animate-pulse rounded-xl bg-card-bone" />
        )}
        <ChevronRight size={14} className="shrink-0 text-ink-mid" />
      </span>
      {model ? (
        <>
          <MixPicture slots={model.slots} faded={model.faded} />
          <Footer footer={model.footer} />
        </>
      ) : (
        <>
          <span className="mt-4 h-24 w-full animate-pulse rounded-[17px] bg-card-bone" />
          <span className="mt-3 h-7 w-28 animate-pulse rounded-[14px] bg-card-bone" />
        </>
      )}
    </button>
  );
}

/** The slots' spacing as a share of the picture's width: 43.67px on the board's 322px. */
const STEP_PCT = (43.67 / 322) * 100;
/** One band from the target line, in px. */
const BAND_PX = 22;

const FILL: Record<Side | "none", string> = { sell: "bg-sell-soft", buy: "bg-pos-soft", none: "bg-ground" };
const pctText = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/**
 * The mix: each stock's target on top, its slot (tinted when the next check sells or buys it), the dashed target line
 * through the slots' middles, a ghost where a traded stock goes back to, its logo placed by its drift in bands, and
 * BUY or SELL under a traded slot. All from the model, so it reads the same at every phone width.
 */
function MixPicture({ slots, faded }: { slots: readonly MixSlot[]; faded: boolean }) {
  const labelled = slots.some((s) => s.side !== null);
  const top = labelled ? 24 : 20;
  const mid = top + 36;
  const x = (i: number) => `${50 + (i - (slots.length - 1) / 2) * STEP_PCT}%`;
  const at = (i: number, half: number) => ({ left: `calc(${x(i)} - ${half}px)` });
  return (
    <span
      aria-hidden
      className={`num relative mt-4 block w-full ${faded ? "opacity-60" : ""}`}
      style={{ height: labelled ? 116 : 96 }}
    >
      {slots.map(
        (s, i) =>
          s.targetBps !== null && (
            <span
              key={s.reserveId}
              className="absolute w-12 text-center font-mono text-[13px] font-bold leading-4 tracking-[0.4px]"
              style={{ ...at(i, 24), top: top - 18 }}
            >
              {pctText(s.targetBps)}
            </span>
          ),
      )}
      {slots.map((s, i) => (
        <span
          key={s.reserveId}
          className={`absolute h-[72px] w-[34px] rounded-[17px] ${FILL[s.side ?? "none"]}`}
          style={{ ...at(i, 17), top }}
        />
      ))}
      <svg className="absolute inset-x-0" style={{ top: mid - 0.5 }} width="100%" height="1">
        <line x1="0" x2="100%" y1="0.5" y2="0.5" stroke="var(--pos)" strokeOpacity={0.5} strokeDasharray="2 3" />
      </svg>
      {slots.map(
        (s, i) =>
          s.side && (
            <svg key={s.reserveId} className="absolute" style={{ ...at(i, 13), top: mid - 13 }} width="26" height="26">
              <circle cx="13" cy="13" r="12.5" fill="var(--bg-card)" stroke="var(--ink-mid)" strokeDasharray="2 2.2" />
            </svg>
          ),
      )}
      {slots.map((s, i) => (
        <span
          key={s.reserveId}
          className="absolute rounded-full ring-1 ring-card"
          style={{ ...at(i, 12.5), top: mid - 12.5 - s.offset * BAND_PX }}
        >
          <StockAvatar symbol={EQUITIES[s.reserveId].symbol} size={25} />
        </span>
      ))}
      {slots.map(
        (s, i) =>
          s.side && (
            <span
              key={s.reserveId}
              className={`absolute top-[101px] w-12 text-center font-mono text-[10px] font-bold leading-3 tracking-[0.6px] ${s.side === "buy" ? "text-pos" : "text-neg"}`}
              style={at(i, 24)}
            >
              {s.side === "buy" ? "BUY" : "SELL"}
            </span>
          ),
      )}
    </span>
  );
}

const PILL_ROW = "inline-flex h-7 items-center rounded-[14px] text-[13px] font-semibold";

/**
 * On target and the next check, the trades due and when (the boards' footer), or the state's words. Each side keeps to
 * one line; on a phone narrower than the boards' the right one goes under the left.
 */
function Footer({ footer }: { footer: RebalanceFooter }) {
  if (footer.kind === "on-target")
    return (
      <span className="num mt-3 flex flex-wrap items-center justify-between gap-2 whitespace-nowrap">
        <span className={`${PILL_ROW} gap-1.5 bg-pos-soft px-3 text-pos`}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path
              d="M2.5 6.5L5 9l4.5-5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          On target
        </span>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-ink-mid">Next check</span>
          {footer.next}
        </span>
      </span>
    );
  if (footer.kind === "trades")
    return (
      <span className="num mt-6 flex flex-wrap items-center justify-between gap-2 whitespace-nowrap">
        <span className={`${PILL_ROW} gap-1.5 bg-due-soft px-3 text-due-ink`}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path
              d="M1.5 4h8l-2-2M10.5 8h-8l2 2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {footer.text}
        </span>
        <span className={`${PILL_ROW} gap-[5px] bg-brand px-[11px] text-ink`}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M6 3.4V6l1.8 1.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          {footer.when}
        </span>
      </span>
    );
  return (
    <>
      <span className="mt-3.5 text-[15px] font-medium leading-5">{footer.line1}</span>
      {footer.line2 && <span className="num mt-1 text-sm leading-[19px] text-ink-mid">{footer.line2}</span>}
    </>
  );
}
