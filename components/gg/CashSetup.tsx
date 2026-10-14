"use client";

import { useState } from "react";
import { toast } from "sonner";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { ActivityAvatar } from "./Activity";
import { NETWORK_FEE_ROW, Summary, type SummaryRow } from "./Summary";
import { TxButton, TxDone, TxError } from "./TxUi";
import { TrendUpIcon } from "./icons";
import { NOT_FAIR, useConvert, useConvertQuotes, type ConvertQuote } from "@/hooks/useConvert";
import type { GrantView, useCashSetup } from "@/hooks/useCashSetup";
import type { TxPhase } from "@/hooks/useTx";
import { askAutomatic, arrivedText, type Arrived, type ArrivedView } from "@/lib/cashSetup";
import { formatCoin, formatUsd, inWords } from "@/lib/formatting";
import { USDC } from "@/lib/tokens/registry";
import type { EntryVenue } from "@/lib/tokens/stables";

/*
 * Earning and other dollars becoming cash, where the user meets them (D20): "Finish setting up" once (the sign-up's
 * last step, then a small card on Home), and "120 USDT arrived · Turn into cash" on Home and Pay, then "Do this
 * automatically next time?". No agent, limit or switch, and no confirm step of ours: each button names its action and
 * opens JAW's own sheet straight away, which shows the Review and asks for Face ID. Plain values in, so the dev gallery
 * draws every state.
 */

const usd = (raw: bigint) => formatUsd(Number(raw) / 10 ** USDC.decimals);

/** The sign-up's last step: Start earning (JAW's sheet, the Save grant) and your cash earns, or "Later". */
export function FinishSetupStep({ rate, grant, onStart, onLater }: { rate: string | null; grant: GrantView; onStart: () => void; onLater: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col gap-6 px-5 pb-[34px] pt-16">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex size-8 items-center justify-center rounded-2xl bg-brand text-[15px] font-bold">G</span>
        <span className="text-[17px] font-semibold">GreedyGoose</span>
      </div>

      <div className="flex grow flex-col justify-center gap-4">
        <div className="font-mono text-xs uppercase tracking-[0.08em] text-ink-mid">One last step</div>
        <h1 className="m-0 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em]">Finish setting up</h1>
        <p className="num m-0 text-[22px] font-semibold leading-[1.25] tracking-[-0.01em]">
          Your cash starts earning{" "}
          {rate ? <span className="rounded-[8px] bg-brand px-1.5">{rate}</span> : <span aria-hidden className="inline-block h-6 w-14 animate-pulse rounded-[8px] bg-chip align-[-4px]" />}
        </p>
        <p className="m-0 text-base leading-[1.45] text-ink-mid [text-wrap:pretty]">
          At a rate that moves with the market. Spend your cash whenever you like: buys and repayments take it as they always do.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <TxError error={grant.error} />
        <TxButton label="Start earning" phase={grant.busy ? "signing" : "idle"} note={grant.blocked} disabled={!!grant.blocked} preview={grant.preview} onClick={onStart} />
        <button type="button" onClick={onLater} disabled={grant.busy} className="h-11 text-[15px] font-semibold text-ink-mid disabled:opacity-45">
          Later
        </button>
      </div>
    </main>
  );
}

const SMALL_CARD = "flex flex-col gap-2 rounded-[22px] bg-card p-3.5 shadow-card-elev";
const PILL = "flex h-9 shrink-0 items-center gap-1.5 rounded-[18px] bg-ink px-3.5 text-sm font-semibold text-on-ink disabled:opacity-45";

/** Home's card when setting up wasn't finished: the same grant on JAW's sheet. While it's open, the card adds nothing. */
export function FinishSetupCard({ rate, grant, onStart }: { rate: string | null; grant: GrantView; onStart: () => void }) {
  return (
    <section aria-label="Finish setting up" className={SMALL_CARD}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-ink">
          <TrendUpIcon size={15} />
        </span>
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-[15px] font-semibold leading-[1.3]">Finish setting up</span>
          <span className="num text-[13px] leading-[1.3] text-ink-2">Your cash starts earning{rate ? ` ${rate}` : ""}</span>
        </span>
        <button
          type="button"
          onClick={onStart}
          disabled={grant.busy || grant.preview || !!grant.blocked}
          aria-busy={grant.busy}
          className={PILL}
        >
          Start earning
        </button>
      </div>
      <TxError error={grant.error} />
      {(grant.preview || grant.blocked) && (
        <p className="m-0 text-xs text-subtle">{grant.preview ? "Preview mode — sign in to do this." : grant.blocked}</p>
      )}
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
  text, quotes, phase, error, preview, onConvert,
}: {
  text: string;
  /** null while the venues are read. */
  quotes: readonly ConvertQuote[] | null;
  phase: TxPhase;
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
    NETWORK_FEE_ROW,
  ];
  const moves = fair.map((q) => `exactly ${coinText(q)} is approved for ${VENUE[q.coin.venue.kind]} and swapped into USDC`);
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
          {inWords(waiting.map((q) => q.coin.symbol))} {waiting.length === 1 ? "isn’t" : "aren’t"} at a fair price right now, so{" "}
          {waiting.length === 1 ? "it stays" : "they stay"} as {waiting.length === 1 ? "it is" : "they are"} for now.
        </p>
      )}
      {fair.length > 0 && (
        <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
          In one go: {inWords(moves)}, at 99.5% of face value or better. If a price falls below that, nothing is swapped.
        </p>
      )}
      <TxError error={error ?? (quotes && fair.length === 0 ? NOT_FAIR : null)} />
      <TxButton label="Turn into cash" size="md" phase={phase} preview={preview} disabled={!quotes || fair.length === 0} onClick={onConvert} />
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
export function AutomaticStep({ landed, grant, onYes, onNo }: { landed: string; grant: GrantView; onYes: () => void; onNo: () => void }) {
  return (
    <>
      <p className="m-0 text-[13px] text-ink-mid">{landed}</p>
      <p className="m-0 text-[15px] leading-[1.45] text-ink-2">
        Dollars other than USDC that arrive in your account turn into cash on their own, at 99.5% of face value or better.
      </p>
      <TxError error={grant.error} />
      <TxButton label="Yes" size="md" phase={grant.busy ? "signing" : "idle"} note={grant.blocked} disabled={!!grant.blocked} preview={grant.preview} onClick={onYes} />
      <button type="button" onClick={onNo} disabled={grant.busy} className="h-11 text-[15px] font-semibold text-ink-mid disabled:opacity-45">
        No
      </button>
    </>
  );
}

/**
 * "Turn into cash" where other dollars show (Home, Pay): the card, signing from its own button, then, once the batch
 * lands, "Do this automatically next time?" when an executor is configured and nothing converts on its own yet, or
 * "It's cash now". The card keeps the coins it was signed for while JAW's sheet is open, so it doesn't change under the
 * user as balances re-read.
 */
export function TurnIntoCash({ user, view, setup }: { user: `0x${string}`; view: ArrivedView; setup: ReturnType<typeof useCashSetup> }) {
  const tx = useConvert();
  // What was signed for, and whether the next question is asked: settled at the tap, so the grant switching it on
  // doesn't swap the step under the user.
  const [held, setHeld] = useState<{ text: string; coins: Arrived[]; sent: readonly ConvertQuote[]; ask: boolean } | null>(null);
  const landed = tx.phase === "done" && !!held;
  const pinned = (tx.busy || landed) && !!held;
  const live = view.kind === "ask" ? { text: view.text, coins: view.coins } : null;
  const shown = pinned ? held : live;
  const quotes = useConvertQuotes(shown?.coins ?? [], !!shown && !pinned);
  const close = () => {
    setHeld(null);
    tx.reset();
  };
  const got = held?.sent.reduce((t, q) => t + q.outRaw, 0n) ?? 0n;
  return (
    <>
      {shown && !landed && (
        <ArrivedCard
          text={shown.text}
          quotes={quotes.data ?? (quotes.isError ? [] : null)}
          phase={tx.phase}
          error={tx.error}
          preview={setup.preview}
          onConvert={() => {
            if (tx.phase === "failed") tx.reset();
            setup.resetAutomatic();
            const all = quotes.data ?? [];
            setHeld({ text: shown.text, coins: shown.coins, sent: all.filter((q) => q.fair), ask: askAutomatic(setup.entry) });
            void tx.convert(user, all);
          }}
        />
      )}
      <SheetShell open={landed} onOpenChange={(next) => !next && close()} title={held?.ask ? "Do this automatically next time?" : "Turn into cash"}>
        <SheetSteps stepKey={held?.ask ? "ask" : "done"} className="flex flex-col gap-3.5">
          {held?.ask ? (
            <AutomaticStep
              landed={cashNowText(held.sent)}
              grant={setup.automatic}
              onYes={() =>
                setup.convertAutomatically(() => {
                  toast.success("Done. Next time it’s automatic");
                  close();
                })
              }
              onNo={close}
            />
          ) : (
            <TxDone title="It’s cash now" body={`About ${usd(got)} is in your cash.`} txHash={tx.txHash} onDone={close} />
          )}
        </SheetSteps>
      </SheetShell>
    </>
  );
}
