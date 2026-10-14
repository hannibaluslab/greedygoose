"use client";

import { useState } from "react";
import { toast } from "sonner";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { ActivityAvatar } from "./Activity";
import { NETWORK_FEE_ROW, Summary, type SummaryRow } from "./Summary";
import { FaceIdButton, TxDone, TxError } from "./TxUi";
import { FaceIdIcon, TrendUpIcon } from "./icons";
import { NOT_FAIR, useConvert, useConvertQuotes, type ConvertQuote } from "@/hooks/useConvert";
import type { GrantView, useCashSetup } from "@/hooks/useCashSetup";
import type { TxPhase } from "@/hooks/useTx";
import { askAutomatic, arrivedText, type Arrived } from "@/lib/cashSetup";
import { formatCoin, formatUsd } from "@/lib/formatting";
import { USDC } from "@/lib/tokens/registry";

/*
 * Earning and other dollars becoming cash, where the user meets them (D20): "Finish setting up" once (the sign-up's
 * last step, then a small card on Home), and "120 USDT arrived · Turn into cash" on Home and Pay, then "Do this
 * automatically next time?". No agent, limit or switch: one Face ID each, on JAW's own screen. Plain values in, so the
 * dev gallery draws every state.
 */

/** Said under every grant's button: JAW's own screen comes next (D14). */
const JAW_NOTE = "One Face ID. JAW shows what it allows before you sign.";

const usd = (raw: bigint) => formatUsd(Number(raw) / 10 ** USDC.decimals);

/** The sign-up's last step: one Face ID and your cash earns, or "Later". */
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
        <FaceIdButton label="Start earning with Face ID" phase={grant.busy ? "signing" : "idle"} disabled={!!grant.blocked} preview={grant.preview} onClick={onStart} />
        <p className="m-0 text-center text-xs text-subtle">{grant.blocked ?? JAW_NOTE}</p>
        <button type="button" onClick={onLater} disabled={grant.busy} className="h-11 text-[15px] font-semibold text-ink-mid disabled:opacity-45">
          Later
        </button>
      </div>
    </main>
  );
}

const SMALL_CARD = "flex flex-col gap-2 rounded-[22px] bg-card p-3.5 shadow-card-elev";
const PILL = "flex h-9 shrink-0 items-center gap-1.5 rounded-[18px] bg-ink px-3.5 text-sm font-semibold text-on-ink disabled:opacity-45";

/** Home's card when setting up wasn't finished: the same one Face ID. */
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
          aria-label="Start earning with Face ID"
          className={PILL}
        >
          <FaceIdIcon size={16} />
          {grant.busy ? "Face ID…" : "Start earning"}
        </button>
      </div>
      <TxError error={grant.error} />
      {(grant.preview || grant.blocked) && (
        <p className="m-0 text-xs text-subtle">{grant.preview ? "Preview mode — sign in to do this." : grant.blocked}</p>
      )}
    </section>
  );
}

/** Other dollars in the account that nothing converts on its own: one tap turns them into cash. */
export function ArrivedCard({ text, onConvert }: { text: string; onConvert: () => void }) {
  return (
    <section aria-label={`${text} arrived`} className={SMALL_CARD}>
      <div className="flex items-center gap-2.5">
        <ActivityAvatar symbol={USDC.symbol} size={32} />
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="num text-[15px] font-semibold leading-[1.3]">{text} arrived</span>
          <span className="text-[13px] leading-[1.3] text-ink-2">Not in your cash yet</span>
        </span>
        <button type="button" onClick={onConvert} className={PILL}>
          Turn into cash
        </button>
      </div>
    </section>
  );
}

/** "120 USDT", from a quote. */
const coinText = (q: ConvertQuote) => `${formatCoin(Number(q.amountIn) / 10 ** q.coin.decimals)} ${q.coin.symbol}`;

/** The review: each coin and what it becomes, the least it all brings, and one Face ID. */
export function ConvertReview({
  quotes, phase, error, preview, onConfirm,
}: {
  /** null while the venues are read. */
  quotes: readonly ConvertQuote[] | null;
  phase: TxPhase;
  error: string | null;
  preview: boolean;
  onConfirm: () => void;
}) {
  const fair = quotes?.filter((q) => q.fair) ?? [];
  const waiting = quotes?.filter((q) => !q.fair) ?? [];
  const sum = (f: (q: ConvertQuote) => bigint) => fair.reduce((t, q) => t + f(q), 0n);
  const rows: SummaryRow[] = [
    ...fair.map((q) => ({ label: coinText(q), value: `about ${usd(q.outRaw)}` })),
    { label: "You get at least", value: usd(sum((q) => q.minOut)) },
    NETWORK_FEE_ROW,
  ];
  return (
    <>
      <p className="m-0 text-[15px] leading-[1.45] text-ink-2">
        {quotes
          ? fair.length
            ? `${arrivedText(fair.map((q) => ({ coin: q.coin, raw: q.amountIn })))} ${fair.length === 2 ? "become" : "becomes"} cash, at 99.5% of face value or better.`
            : "Other dollars become cash only at 99.5% of face value or better."
          : "Checking today’s price…"}
      </p>
      {!quotes ? (
        <div aria-busy className="h-[132px] animate-pulse rounded-[14px] bg-chip" />
      ) : (
        fair.length > 0 && <Summary rows={rows} />
      )}
      {waiting.length > 0 && (
        <p className="m-0 text-[13px] leading-[1.4] text-ink-mid">
          {waiting.map((q) => q.coin.symbol).join(" and ")} {waiting.length === 1 ? "isn’t" : "aren’t"} at a fair price right now, so {waiting.length === 1 ? "it stays" : "they stay"} as {waiting.length === 1 ? "it is" : "they are"} for now.
        </p>
      )}
      <TxError error={error ?? (quotes && fair.length === 0 ? NOT_FAIR : null)} />
      <FaceIdButton label="Turn into cash with Face ID" size="md" phase={phase} preview={preview} disabled={!quotes || fair.length === 0} onClick={onConfirm} />
    </>
  );
}

/** After a conversion, with nothing converting on its own yet: one Face ID and next time it happens by itself. */
export function AutomaticStep({ grant, onYes, onNo }: { grant: GrantView; onYes: () => void; onNo: () => void }) {
  return (
    <>
      <p className="m-0 text-[15px] leading-[1.45] text-ink-2">
        Dollars other than USDC that arrive in your account turn into cash on their own, at 99.5% of face value or better.
      </p>
      <TxError error={grant.error} />
      <FaceIdButton label="Yes, with Face ID" size="md" phase={grant.busy ? "signing" : "idle"} disabled={!!grant.blocked} preview={grant.preview} onClick={onYes} />
      <button type="button" onClick={onNo} disabled={grant.busy} className="h-11 text-[15px] font-semibold text-ink-mid disabled:opacity-45">
        No
      </button>
      <p className="m-0 text-center text-xs text-subtle">{grant.blocked ?? JAW_NOTE}</p>
    </>
  );
}

/**
 * "Turn into cash": the review (one user-signed batch, lib/swap/entry.ts), then "Do this automatically next time?"
 * when an executor is configured and nothing converts on its own yet; otherwise it's done. `coins` are the ones that
 * arrived when the sheet opened, so the review doesn't change under the user as balances re-read.
 */
export function ConvertSheet({
  open, onClose, user, coins, setup,
}: {
  open: boolean;
  onClose: () => void;
  user: `0x${string}`;
  coins: readonly Arrived[];
  setup: ReturnType<typeof useCashSetup>;
}) {
  const quotes = useConvertQuotes(coins, open);
  const tx = useConvert();
  // Whether the next question is asked is settled once the conversion lands, so the grant switching it on doesn't
  // swap the step under the user.
  const [ask] = useState(() => askAutomatic(setup.entry));
  // The coins signed for: a coin that wasn't at a fair price stays as it is, so it's left out of what's said after.
  const [sent, setSent] = useState<readonly ConvertQuote[]>([]);
  const landed = tx.phase === "done";
  const got = sent.reduce((t, q) => t + q.outRaw, 0n);
  const close = () => {
    if (landed && sent.length) {
      toast.success(`${arrivedText(sent.map((q) => ({ coin: q.coin, raw: q.amountIn })))} ${sent.length === 2 ? "are" : "is"} cash now`);
    }
    onClose();
  };
  return (
    <SheetShell open={open} onOpenChange={(next) => !next && close()} title={landed && ask ? "Do this automatically next time?" : "Turn into cash"}>
      <SheetSteps stepKey={landed ? "after" : "review"} className="flex flex-col gap-3.5">
        {!landed ? (
          <ConvertReview
            quotes={quotes.data ?? (quotes.isError ? [] : null)}
            phase={tx.phase}
            error={tx.error}
            preview={setup.preview}
            onConfirm={() => {
              if (tx.phase === "failed") tx.reset();
              setup.resetAutomatic();
              const shown = quotes.data ?? [];
              setSent(shown.filter((q) => q.fair));
              void tx.convert(user, shown);
            }}
          />
        ) : ask ? (
          <AutomaticStep
            grant={setup.automatic}
            onYes={() =>
              setup.convertAutomatically(() => {
                toast.success("Done. Next time it’s automatic");
                onClose();
              })
            }
            onNo={close}
          />
        ) : (
          <TxDone title="It’s cash now" body={`About ${usd(got)} is in your cash.`} txHash={tx.txHash} onDone={close} />
        )}
      </SheetSteps>
    </SheetShell>
  );
}
