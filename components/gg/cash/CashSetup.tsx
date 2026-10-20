"use client";

import { useState, type ReactNode } from "react";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { ActivityAvatar } from "../activity/Activity";
import { TxDone, TxError } from "../TxUi";
import { TrendUpIcon } from "../kit/icons";
import { useConvert, useConvertQuotes } from "@/hooks/useConvert";
import { NOT_FAIR, planPrefix, type ConvertQuote } from "@/lib/tx/plans";
import type { useCashSetup } from "@/hooks/useCashSetup";
import { usePrepare, type TxPhase } from "@/hooks/useTx";
import { AGENTS_LIVE } from "@/lib/agents/config";
import { askAutomatic, type Arrived, type ArrivedView } from "@/lib/cashSetup";
import { formatUsd } from "@/lib/formatting";
import { USDC } from "@/lib/tokens/registry";

/*
 * Earning and other dollars becoming cash, where the user meets them (D20), on one card each: "Your $100 arrived · Start
 * earning" on Home while the wallet's cash isn't earning (board 2g; its batch puts it in savings, Adrian 2026-10-15),
 * and "You received 120 USDT · Finish setting up · Turn into cash" on Home and Pay. No agent, limit or switch, and no
 * confirm step of ours: each button names its action and opens JAW's own sheet straight away, which shows the Review
 * and asks for Face ID. Plain values in, so the dev gallery draws every state.
 */

const usd = (raw: bigint) => formatUsd(Number(raw) / 10 ** USDC.decimals);

const SMALL_CARD = "flex flex-col gap-2 rounded-[22px] bg-card p-3.5 shadow-card-elev";
const PILL =
  "flex h-9 shrink-0 items-center gap-1.5 rounded-[18px] bg-ink px-3.5 text-sm font-semibold text-on-ink disabled:opacity-45";

/**
 * The one card D20's two moments share (board 2g, Adrian 2026-10-20: "just the same card, you received, finish set up,
 * cta. that is it"): an icon, a title, one line and the button that names its action, straight to JAW's sheet. Under it
 * only an error, or why it can't go ahead. While JAW's sheet is open, the card adds nothing.
 */
function SetupCard({
  aria,
  icon,
  title,
  line,
  action,
  phase,
  checking = false,
  blocked = false,
  note,
  error,
  preview,
  onTap,
}: {
  aria: string;
  icon: ReactNode;
  title: string;
  line: string;
  action: string;
  phase: TxPhase;
  /** The batch is still being prepared (useTx): "Checking…" until it's ready. */
  checking?: boolean;
  /** The batch can't go ahead (`error` says why). */
  blocked?: boolean;
  /** Why it can't be signed now; null when it can. */
  note?: string | null;
  error: string | null;
  preview: boolean;
  onTap: () => void;
}) {
  const busy = phase === "simulating" || phase === "signing" || phase === "pending";
  const waiting = checking && !busy && phase !== "done";
  const label = phase === "simulating" || waiting ? "Checking…" : phase === "pending" ? "Confirming on Base…" : action;
  const small = preview ? "Preview mode. Sign in to do this." : note;
  return (
    <section aria-label={aria} className={SMALL_CARD}>
      <div className="flex items-center gap-2.5">
        {icon}
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="num text-[15px] font-semibold leading-[1.3]">{title}</span>
          <span className="num text-[13px] leading-[1.3] text-ink-2">{line}</span>
        </span>
        <button
          type="button"
          onClick={onTap}
          disabled={busy || waiting || blocked || preview || !!note || phase === "done"}
          aria-busy={busy || waiting}
          data-tx={waiting ? "checking" : busy ? phase : undefined}
          className={PILL}
        >
          {label}
        </button>
      </div>
      <TxError error={error} />
      {small && <p className="m-0 text-xs text-subtle">{small}</p>}
    </section>
  );
}

/**
 * Home's card while the wallet's cash isn't earning (board 2g): "Your $100 arrived · Start earning 4.6% on it.", or
 * "$40 isn't earning" beside savings that already earn. Its button moves that cash into savings in one batch on JAW's
 * sheet (useStartEarning), named for the action only; while the agents are live the same Face ID has new cash earn on
 * its own.
 */
export function StartEarningCard({
  title,
  line,
  phase,
  checking,
  blocked,
  note,
  error,
  preview,
  onStart,
}: {
  title: string;
  line: string;
  phase: TxPhase;
  checking?: boolean;
  blocked?: boolean;
  note?: string | null;
  error: string | null;
  preview: boolean;
  onStart: () => void;
}) {
  return (
    <SetupCard
      aria="Start earning"
      icon={
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-ink">
          <TrendUpIcon size={15} />
        </span>
      }
      title={title}
      line={line}
      action="Start earning"
      phase={phase}
      checking={checking}
      blocked={blocked}
      note={note}
      error={error}
      preview={preview}
      onTap={onStart}
    />
  );
}

/**
 * Other dollars in the account that nothing converts on its own, on the same card: "You received 120 USDT", "Finish
 * setting up" while its one Face ID also has the next ones convert on their own (else "Not in your cash yet"), and
 * "Turn into cash" (one user-signed batch, lib/swap/entry.ts, at 99.5% of face value or better; a coin under that stays
 * as it is). Nothing else on the card.
 */
export function ArrivedCard({
  text,
  quotes,
  setsUp = false,
  phase,
  checking = false,
  blocked = false,
  error,
  preview,
  onConvert,
}: {
  text: string;
  /** null while the venues are read. */
  quotes: readonly ConvertQuote[] | null;
  /** Its Face ID also has the next ones convert on their own (useCashSetup `automaticPlan`). */
  setsUp?: boolean;
  phase: TxPhase;
  /** The batch is still being prepared (useTx): "Checking…" until it's ready. */
  checking?: boolean;
  /** The batch can't go ahead (`error` says why). */
  blocked?: boolean;
  error: string | null;
  preview: boolean;
  onConvert: () => void;
}) {
  const fair = quotes?.filter((q) => q.fair) ?? [];
  return (
    <SetupCard
      aria={`You received ${text}`}
      icon={<ActivityAvatar symbol={USDC.symbol} size={32} />}
      title={`You received ${text}`}
      line={setsUp ? "Finish setting up" : "Not in your cash yet"}
      action="Turn into cash"
      phase={phase}
      checking={checking || !quotes}
      blocked={blocked || (!!quotes && fair.length === 0)}
      error={error ?? (quotes && fair.length === 0 ? NOT_FAIR : null)}
      preview={preview}
      onTap={onConvert}
    />
  );
}

/**
 * Turn into cash's state, for whichever screen shows its card (Home's menu, the Top up sheet): the card's props while
 * there's something to convert (null otherwise), and once its batch lands what came in. While the agents are live and
 * nothing converts on its own yet, the same Face ID also has the next ones convert on their own (Adrian, 2026-10-20:
 * "turn into cash means next time automatically"): the Entry grant rides in the conversion's batch (useCashSetup
 * `automaticPlan`). The card keeps the coins it was signed for while JAW's sheet is open, so it doesn't change under
 * the user as balances re-read. `active` false (the sheet it sits in is closed or sliding away): nothing is prepared.
 */
export function useTurnIntoCash(
  user: `0x${string}`,
  view: ArrivedView,
  setup: ReturnType<typeof useCashSetup>,
  active = true,
) {
  const tx = useConvert();
  // What was signed for, and whether it also converts the next ones: settled at the tap, so the grant switching it on
  // doesn't change the words under the user.
  const [held, setHeld] = useState<{
    text: string;
    coins: Arrived[];
    sent: readonly ConvertQuote[];
    auto: boolean;
  } | null>(null);
  const landed = tx.phase === "done" && !!held;
  const pinned = (tx.busy || landed) && !!held;
  const live = view.kind === "ask" ? { text: view.text, coins: view.coins } : null;
  const shown = pinned ? held : live;
  const quotes = useConvertQuotes(shown?.coins ?? [], !!shown && !pinned);
  // Whether this tap also has the next ones convert on their own.
  const auto = askAutomatic(setup.entry, AGENTS_LIVE);
  // What the card's button would sign now, prepared while it's idle so the tap opens JAW's sheet at once: the
  // conversion, and with it the Entry grant when it asks.
  const convert = active && shown && !pinned && quotes.data ? tx.planFor(user, quotes.data) : null;
  const plan = convert && (auto ? setup.automaticPlan(planPrefix(convert)) : convert);
  const prep = usePrepare(tx.prep, plan);
  const close = () => {
    setHeld(null);
    tx.reset();
  };
  const card: Parameters<typeof ArrivedCard>[0] | null =
    shown && !landed
      ? {
          text: shown.text,
          quotes: quotes.data ?? (quotes.isError ? [] : null),
          phase: tx.phase,
          // A batch with the Entry grant waits for what it's built from (the executor's registry): checking until then.
          checking: plan ? prep.checking : !!convert,
          blocked: prep.blocked,
          error: tx.error ?? prep.error,
          preview: setup.preview,
          setsUp: !!(pinned ? held?.auto : auto),
          onConvert: () => {
            if (!plan) return;
            if (tx.phase === "failed") tx.reset();
            const all = quotes.data ?? [];
            setHeld({ text: shown.text, coins: shown.coins, sent: all.filter((q) => q.fair), auto });
            void tx.sign(plan);
          },
        }
      : null;
  return { card, landed, held, txHash: tx.txHash, close };
}

/** "Turn into cash" in a screen of its own (the Top up sheet): its card, then "It's cash now" once it lands. */
export function TurnIntoCash({
  user,
  view,
  setup,
  active = true,
}: {
  user: `0x${string}`;
  view: ArrivedView;
  setup: ReturnType<typeof useCashSetup>;
  /** False while the sheet it sits in slides away: nothing is prepared then. */
  active?: boolean;
}) {
  const t = useTurnIntoCash(user, view, setup, active);
  return (
    <>
      {t.card && <ArrivedCard {...t.card} />}
      <ConvertedSheet open={t.landed} held={t.held} txHash={t.txHash} onClose={t.close} />
    </>
  );
}

/** Once the conversion lands: "It's cash now" with what came in, and that the next ones convert on their own if so. */
export function ConvertedSheet({
  open,
  held,
  txHash,
  onClose,
}: {
  open: boolean;
  held: { sent: readonly ConvertQuote[]; auto: boolean } | null;
  txHash: ReturnType<typeof useConvert>["txHash"];
  onClose: () => void;
}) {
  const got = held?.sent.reduce((t, q) => t + q.outRaw, 0n) ?? 0n;
  const next = held?.auto ? " Next time it happens on its own." : "";
  return (
    <SheetShell open={open} onOpenChange={(next) => !next && onClose()} title="Turn into cash">
      <SheetSteps stepKey="done" className="flex flex-col gap-3.5">
        <TxDone
          title="It’s cash now"
          body={`About ${usd(got)} is in your cash.${next}`}
          txHash={txHash}
          onDone={onClose}
        />
      </SheetSteps>
    </SheetShell>
  );
}
