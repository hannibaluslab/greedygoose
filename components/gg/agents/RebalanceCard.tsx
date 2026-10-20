"use client";

import { AgentMark } from "../activity/Activity";
import { ChevronRight } from "../kit/icons";
import { StockAvatar } from "../kit/StockAvatar";
import { useRebalanceCard } from "@/hooks/useRebalanceCard";
import {
  mixScale,
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

/** Rebalance's card for `account`, from its reads (useRebalanceCard, the same model its sheet's pill and line use). */
export function RebalanceCard({ account, onOpen }: { account: Account; onOpen: () => void }) {
  return <RebalanceCardView model={useRebalanceCard(account)} onOpen={onOpen} />;
}

const CARD =
  "flex w-full flex-col rounded-[22px] bg-card p-[18px] text-left text-ink shadow-[0_1px_2px_rgba(14,13,11,0.04),0_6px_20px_rgba(14,13,11,0.06)]";

const PILL: Record<PillTone, string> = {
  on: "bg-pos-soft text-pos",
  neutral: "bg-card-bone text-ink-mid",
  needs: "bg-needs-soft text-needs-ink",
  due: "bg-due-soft text-due-ink",
};

/** Rebalance's state as a pill ("On", "Needs you", "Ends soon"), on its card and beside its sheet's title. */
export function RebalancePill({ model }: { model: RebalanceCardModel | null }) {
  if (!model) return <span aria-hidden className="h-6 w-14 shrink-0 animate-pulse rounded-xl bg-card-bone" />;
  return (
    <span
      className={`flex h-6 shrink-0 items-center whitespace-nowrap rounded-xl px-2.5 text-xs font-bold ${PILL[model.pill.tone]}`}
    >
      {model.pill.text}
    </span>
  );
}

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
        <RebalancePill model={model} />
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
 * BUY or SELL under a traded slot. All from the model, so it reads the same at every phone width. With 1–4 stocks
 * everything is drawn ×1.5 (`mixScale`, board 7l); 5–7 keep the boards' size.
 */
function MixPicture({ slots, faded }: { slots: readonly MixSlot[]; faded: boolean }) {
  const k = mixScale(slots.length);
  const labelled = slots.some((s) => s.side !== null);
  const pctLine = k > 1 ? 18 : 16;
  const slotW = 34 * k;
  const slotH = 72 * k;
  const logo = Math.round(25 * k);
  const ghost = 26 * k;
  const top = pctLine + (labelled ? 8 : 4);
  const mid = top + slotH / 2;
  const x = (i: number) => `${50 + (i - (slots.length - 1) / 2) * STEP_PCT * k}%`;
  const at = (i: number, half: number) => ({ left: `calc(${x(i)} - ${half}px)` });
  return (
    <span
      aria-hidden
      className={`num relative mt-4 block w-full ${faded ? "opacity-60" : ""}`}
      style={{ height: top + slotH + (labelled ? 20 : 4) }}
    >
      {slots.map(
        (s, i) =>
          s.targetBps !== null && (
            <span
              key={s.reserveId}
              className="absolute w-12 text-center font-mono font-bold tracking-[0.4px]"
              style={{ ...at(i, 24), top: top - pctLine - 2, fontSize: k > 1 ? 15 : 13, lineHeight: `${pctLine}px` }}
            >
              {pctText(s.targetBps)}
            </span>
          ),
      )}
      {slots.map((s, i) => (
        <span
          key={s.reserveId}
          className={`absolute ${FILL[s.side ?? "none"]}`}
          style={{ ...at(i, slotW / 2), top, width: slotW, height: slotH, borderRadius: slotW / 2 }}
        />
      ))}
      <svg className="absolute inset-x-0" style={{ top: mid - 0.5 }} width="100%" height="1">
        <line x1="0" x2="100%" y1="0.5" y2="0.5" stroke="var(--pos)" strokeOpacity={0.5} strokeDasharray="2 3" />
      </svg>
      {slots.map(
        (s, i) =>
          s.side && (
            <svg
              key={s.reserveId}
              className="absolute"
              style={{ ...at(i, ghost / 2), top: mid - ghost / 2 }}
              width={ghost}
              height={ghost}
            >
              <circle
                cx={ghost / 2}
                cy={ghost / 2}
                r={ghost / 2 - 0.5}
                fill="var(--bg-card)"
                stroke="var(--ink-mid)"
                strokeDasharray="2 2.2"
              />
            </svg>
          ),
      )}
      {slots.map((s, i) => (
        <span
          key={s.reserveId}
          className="absolute rounded-full ring-1 ring-card"
          style={{ ...at(i, logo / 2), top: mid - logo / 2 - s.offset * BAND_PX * k }}
        >
          <StockAvatar symbol={EQUITIES[s.reserveId].symbol} size={logo} />
        </span>
      ))}
      {slots.map(
        (s, i) =>
          s.side && (
            <span
              key={s.reserveId}
              className={`absolute w-12 text-center font-mono font-bold leading-3 tracking-[0.6px] ${s.side === "buy" ? "text-pos" : "text-neg"}`}
              style={{ ...at(i, 24), top: top + slotH + 5, fontSize: k > 1 ? 11 : 10 }}
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
 * On target and the next check, the top-ups going in or the trades due and when (the boards' footer), or the state's
 * words. Each side keeps to one line; on a phone narrower than the boards' the right one goes under the left.
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
  if (footer.kind === "trades" || footer.kind === "invest") {
    // Top-ups going in: green, with money going down into the mix. Trades: amber, with the two-way arrows.
    const invest = footer.kind === "invest";
    return (
      <span className="num mt-6 flex flex-wrap items-center justify-between gap-2 whitespace-nowrap">
        <span className={`${PILL_ROW} gap-1.5 px-3 ${invest ? "bg-pos-soft text-pos" : "bg-due-soft text-due-ink"}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path
              d={invest ? "M6 1.5v8M2.5 6.5L6 10l3.5-3.5" : "M1.5 4h8l-2-2M10.5 8h-8l2 2"}
              fill="none"
              stroke="currentColor"
              strokeWidth={invest ? 1.6 : 1.5}
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
  }
  return (
    <>
      <span className="mt-3.5 text-[15px] font-medium leading-5">{footer.line1}</span>
      {footer.line2 && <span className="num mt-1 text-sm leading-[19px] text-ink-mid">{footer.line2}</span>}
    </>
  );
}
