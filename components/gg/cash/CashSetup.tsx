"use client";

import { useState } from "react";
import { toast } from "sonner";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { ActivityAvatar } from "../activity/Activity";
import { Summary, type SummaryRow } from "../home/Summary";
import { TxButton, TxDone, TxError } from "../TxUi";
import { TrendUpIcon } from "../icons";
import { useConvert, useConvertQuotes } from "@/hooks/useConvert";
import { NOT_FAIR, type ConvertQuote } from "@/lib/tx/plans";
import type { GrantView, useCashSetup } from "@/hooks/useCashSetup";
import { usePrepare, type TxPhase } from "@/hooks/useTx";
import { askAutomatic, arrivedText, type Arrived, type ArrivedView } from "@/lib/cashSetup";
import { formatCoin, formatUsd, inWords, stepsNote } from "@/lib/formatting";
import { USDC } from "@/lib/tokens/registry";
import type { EntryVenue } from "@/lib/tokens/stables";

/*
 * Earning and other dollars becoming cash, where the user meets them (D20): "Your $100 arrived · Start earning" on Home
 * while the wallet's cash isn't earning (board 2g; its batch puts it in savings, Adrian 2026-10-15), and "120 USDT arrived · Turn into cash" on Home and Pay, then "Do this
 * automatically next time?". No agent, limit or switch, and no confirm step of ours: each button names its action and
 * opens JAW's own sheet straight away, which shows the Review and asks for Face ID. Plain values in, so the dev gallery
 * draws every state.
 */

const usd = (raw: bigint) => formatUsd(Number(raw) / 10 ** USDC.decimals);

const SMALL_CARD = "flex flex-col gap-2 rounded-[22px] bg-card p-3.5 shadow-card-elev";
const PILL =
  "flex h-9 shrink-0 items-center gap-1.5 rounded-[18px] bg-ink px-3.5 text-sm font-semibold text-on-ink disabled:opacity-45";

/**
 * Home's card while the wallet's cash isn't earning (board 2g): "Your $100 arrived · Start earning 4.6% on it.", or
 * "$40 isn't earning" beside savings that already earn. Its button moves that cash into savings in one batch on JAW's
 * sheet (useStartEarning), named for the action only; with the Save grant to follow, a small line under it says
 * "2 steps". While JAW's sheet is open, the card adds nothing.
 */
export function StartEarningCard({
  title,
  line,
  phase,
  checking = false,
  blocked = false,
  steps = 1,
  note,
  error,
  preview,
  onStart,
}: {
  title: string;
  line: string;
  phase: TxPhase;
  /** The batch is still being prepared (useTx): "Checking…" until it's ready. */
  checking?: boolean;
  /** The batch can't go ahead (`error` says why). */
  blocked?: boolean;
  /** JAW sheets one tap opens: the batch, and the Save grant when it follows. */
  steps?: number;
  /** Why it can't be signed now; null when it can. */
  note?: string | null;
  error: string | null;
  preview: boolean;
  onStart: () => void;
}) {
  const busy = phase === "simulating" || phase === "signing" || phase === "pending";
  const waiting = checking && !busy && phase !== "done";
  const label =
    phase === "simulating" || waiting ? "Checking…" : phase === "pending" ? "Confirming on Base…" : "Start earning";
  const small = preview ? "Preview mode — sign in to do this." : (note ?? stepsNote(steps));
  return (
    <section aria-label="Start earning" className={SMALL_CARD}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-ink">
          <TrendUpIcon size={15} />
        </span>
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="num text-[15px] font-semibold leading-[1.3]">{title}</span>
          <span className="num text-[13px] leading-[1.3] text-ink-2">{line}</span>
        </span>
        <button
          type="button"
          onClick={onStart}
          disabled={busy || waiting || blocked || preview || !!note || phase === "done"}
          aria-busy={busy || waiting}
          data-tx={waiting ? "checking" : busy ? phase : undefined}
          className={PILL}
        >
          {label}
        </button>
      </div>
      <TxError error={error} />
      {small && <p className={`m-0 text-xs text-subtle ${!preview && !note ? "text-right" : ""}`}>{small}</p>}
    </section>
  );
}

const VENUE: Record<EntryVenue["kind"], string> = { aerodrome: "Aerodrome", uniswap: "Uniswap", psm3: "Spark" };

/** "120 USDT", from a quote. */
const coinText = (q: ConvertQuote) => `${formatCoin(Number(q.amountIn) / 10 ** q.coin.decimals)} ${q.coin.symbol}`;
const asArrived = (qs: readonly ConvertQuote[]) => qs.map((q) => ({ coin: q.coin, raw: q.amountIn }));

/**
 * Other dollars in the account that nothing converts on its own, and turning them into cash on one screen: what they
 * become and the least they bring, the network fee and every move in small print (D7), then one button to JAW's sheet
 * (one user-signed batch, lib/swap/entry.ts). No review of ours before it.
 */
export function ArrivedCard({
  text,
  quotes,
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
  const waiting = quotes?.filter((q) => !q.fair) ?? [];
  const sum = (f: (q: ConvertQuote) => bigint) => fair.reduce((t, q) => t + f(q), 0n);
  const rows: SummaryRow[] = [
    ...fair.map((q) => ({ label: coinText(q), value: `about ${usd(q.outRaw)}` })),
    { label: "You get at least", value: usd(sum((q) => q.minOut)) },
  ];
  const moves = fair.map(
    (q) => `exactly ${coinText(q)} is approved for ${VENUE[q.coin.venue.kind]} and swapped into USDC`,
  );
  return (
    <section aria-label={`${text} arrived`} className={SMALL_CARD}>
      <div className="flex items-center gap-2.5">
        <ActivityAvatar symbol={USDC.symbol} size={32} />
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="num text-[15px] font-semibold leading-[1.3]">{text} arrived</span>
          <span className="text-[13px] leading-[1.3] text-ink-2">Not in your cash yet</span>
        </span>
      </div>
      {!quotes ? (
        <div aria-busy className="flex flex-col gap-1.5">
          <span className="text-[13px] text-ink-mid">Checking today’s price…</span>
          <div className="h-[74px] animate-pulse rounded-[12px] bg-chip" />
        </div>
      ) : (
        fair.length > 0 && <Summary rows={rows} />
      )}
      {waiting.length > 0 && (
        <p className="m-0 text-[13px] leading-[1.4] text-ink-mid">
          {inWords(waiting.map((q) => q.coin.symbol))} {waiting.length === 1 ? "isn’t" : "aren’t"} at a fair price right
          now, so {waiting.length === 1 ? "it stays" : "they stay"} as {waiting.length === 1 ? "it is" : "they are"} for
          now.
        </p>
      )}
      {fair.length > 0 && (
        <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
          In one go: {inWords(moves)}, at 99.5% of face value or better. If a price falls below that, nothing is
          swapped.
        </p>
      )}
      <TxError error={error ?? (quotes && fair.length === 0 ? NOT_FAIR : null)} />
      <TxButton
        label="Turn into cash"
        size="md"
        phase={phase}
        checking={checking}
        preview={preview}
        disabled={!quotes || fair.length === 0 || blocked}
        onClick={onConvert}
      />
    </section>
  );
}

/** What a conversion that landed brought: "120 USDT is cash now: about $119.83." */
export const cashNowText = (sent: readonly ConvertQuote[]) =>
  `${arrivedText(asArrived(sent))} ${sent.length === 2 ? "are" : "is"} cash now: about ${usd(sent.reduce((t, q) => t + q.outRaw, 0n))}.`;

/**
 * After a conversion lands (`landed` says what it brought), with nothing converting on its own yet: Yes is the Entry
 * grant on JAW's sheet, and next time it happens by itself.
 */
export function AutomaticStep({
  landed,
  grant,
  onYes,
  onNo,
}: {
  landed: string;
  grant: GrantView;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <>
      <p className="m-0 text-[13px] text-ink-mid">{landed}</p>
      <p className="m-0 text-[15px] leading-[1.45] text-ink-2">
        Dollars other than USDC that arrive in your account turn into cash on their own, at 99.5% of face value or
        better.
      </p>
      <TxError error={grant.error} />
      <TxButton
        label="Yes"
        size="md"
        phase={grant.busy ? "signing" : "idle"}
        note={grant.blocked}
        disabled={!!grant.blocked}
        preview={grant.preview}
        onClick={onYes}
      />
      <button
        type="button"
        onClick={onNo}
        disabled={grant.busy}
        className="h-11 text-[15px] font-semibold text-ink-mid disabled:opacity-45"
      >
        No
      </button>
    </>
  );
}

/**
 * "Turn into cash" where other dollars show (Home, the Top up sheet): the card, signing from its own button, then, once the batch
 * lands, "Do this automatically next time?" when an executor is configured and nothing converts on its own yet, or
 * "It's cash now". The card keeps the coins it was signed for while JAW's sheet is open, so it doesn't change under the
 * user as balances re-read.
 */
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
  const tx = useConvert();
  // What was signed for, and whether the next question is asked: settled at the tap, so the grant switching it on
  // doesn't swap the step under the user.
  const [held, setHeld] = useState<{
    text: string;
    coins: Arrived[];
    sent: readonly ConvertQuote[];
    ask: boolean;
  } | null>(null);
  const landed = tx.phase === "done" && !!held;
  const pinned = (tx.busy || landed) && !!held;
  const live = view.kind === "ask" ? { text: view.text, coins: view.coins } : null;
  const shown = pinned ? held : live;
  const quotes = useConvertQuotes(shown?.coins ?? [], !!shown && !pinned);
  // What the card's button would sign now, prepared while it's idle so the tap opens JAW's sheet at once.
  const plan = active && shown && !pinned && quotes.data ? tx.planFor(user, quotes.data) : null;
  const prep = usePrepare(tx.prep, plan);
  const close = () => {
    setHeld(null);
    tx.reset();
  };
  return (
    <>
      {shown && !landed && (
        <ArrivedCard
          text={shown.text}
          quotes={quotes.data ?? (quotes.isError ? [] : null)}
          phase={tx.phase}
          checking={prep.checking}
          blocked={prep.blocked}
          error={tx.error ?? prep.error}
          preview={setup.preview}
          onConvert={() => {
            if (!plan) return;
            if (tx.phase === "failed") tx.reset();
            setup.resetAutomatic();
            const all = quotes.data ?? [];
            setHeld({
              text: shown.text,
              coins: shown.coins,
              sent: all.filter((q) => q.fair),
              ask: askAutomatic(setup.entry),
            });
            void tx.sign(plan);
          }}
        />
      )}
      <ConvertedSheet open={landed} held={held} setup={setup} txHash={tx.txHash} onClose={close} />
    </>
  );
}

/**
 * Once the conversion lands: "Do this automatically next time?" when it was asked at the tap, else "It's cash now" with
 * what came in.
 */
function ConvertedSheet({
  open,
  held,
  setup,
  txHash,
  onClose,
}: {
  open: boolean;
  held: { sent: readonly ConvertQuote[]; ask: boolean } | null;
  setup: ReturnType<typeof useCashSetup>;
  txHash: ReturnType<typeof useConvert>["txHash"];
  onClose: () => void;
}) {
  const got = held?.sent.reduce((t, q) => t + q.outRaw, 0n) ?? 0n;
  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={held?.ask ? "Do this automatically next time?" : "Turn into cash"}
    >
      <SheetSteps stepKey={held?.ask ? "ask" : "done"} className="flex flex-col gap-3.5">
        {held?.ask ? (
          <AutomaticStep
            landed={cashNowText(held.sent)}
            grant={setup.automatic}
            onYes={() =>
              setup.convertAutomatically(() => {
                toast.success("Done. Next time it’s automatic");
                onClose();
              })
            }
            onNo={onClose}
          />
        ) : (
          <TxDone title="It’s cash now" body={`About ${usd(got)} is in your cash.`} txHash={txHash} onDone={onClose} />
        )}
      </SheetSteps>
    </SheetShell>
  );
}
