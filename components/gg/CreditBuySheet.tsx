"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { AmountArrow, AmountBadge, AmountField, AmountSource, YouGet } from "./AmountField";
import { Button } from "./Button";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { NETWORK_FEE_ROW, Summary } from "./Summary";
import { TxButton, TxError } from "./TxUi";
import { ChevronRight, BacksIcon } from "./icons";
import { useAgents } from "@/hooks/useAgents";
import { useBoughtHome } from "@/hooks/useBoughtHome";
import { useBuyQuote } from "@/hooks/useBuyQuote";
import { useCreditBuy } from "@/hooks/useCreditBuy";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useCollateralFactorsRead, type Holding, type PositionData } from "@/hooks/usePosition";
import { monthlyCost } from "@/lib/aave/math";
import {
  CREDIT_BLOCKED, backers, backingOptions, bestBacking, creditAvailable, creditWith, planCredit, shortNames, type BackingOption, type CreditAvailable,
} from "@/lib/creditBuy";
import { formatShares, formatUsd, formatUsdTrim, inWords } from "@/lib/formatting";
import { STATUS_LABEL, type Status } from "@/lib/risk/status";
import { BUY_LIMITS, quoteEconomics } from "@/lib/swap/buy";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

type Step = "pick" | "back" | "amount";
const ORDER: Step[] = ["pick", "back", "amount"];

const valueOf = (h: Holding) => h.freeUsd + h.lockedUsd;
/** "Status after" in words, coloured once it needs the extra confirmation. */
const AFTER_TONE: Record<Status, string> = { none: "", safe: "", watch: "text-watch-text", act: "text-act" };
/** Free stock worth less than this can't back a Credit Buy here: dust left over reads "All in use", as /use-credit tucks it away. */
const MIN_BACKING_USD = 1;
/** Credit figures in whole dollars, as the boards print them ("$700", "Up to $1,000"). */
const wholeUsd = (n: number) => formatUsdTrim(Math.max(0, Math.floor(n)));

/**
 * Design boards "F2 · 3–5" (F2-3-Pick-stock … F2-5-Amount): Credit Buy in one drawer. F2-3 opens on how much credit
 * one buy can use right now (Adrian, 2026-10-15: creditAvailable), then the stocks to pick from (your holdings first),
 * then pick the holding that backs it (the one that offers that number is picked first), choose how much credit, then Credit Buy opens JAW's own sheet: put the
 * backing in use, take the credit and buy, in one batch (useCreditBuy). With $0 to use, F2-3 says why, and a stock
 * tapped there opens its Buy step with cash (`onBuyWithCash`). F2-6's confirm is folded into the amount step
 * (Adrian, 2026-10-15): what goes in use and the risk in small print, the risk tick when it ends in Watch or Act.
 * Once it lands it goes Home with the "Bought" toast (F2-7).
 * Opened from a stock's sheet, the stock is already picked: it starts at F2-4, and Back returns to that sheet.
 */
export function CreditBuySheet({
  open, user, data, symbol, onClose, onBack, onBuyWithCash,
}: {
  open: boolean;
  user: `0x${string}`;
  data: PositionData;
  /** The stock to buy, picked already (resolved through the registry only); F2-3's picker otherwise. */
  symbol?: string | null;
  onClose: () => void;
  /** Where Back goes from the first step when the stock was picked already (the stock's sheet). */
  onBack?: () => void;
  /** F2-3 with no credit to use: a stock tapped opens its Buy step with cash. */
  onBuyWithCash: (symbol: string) => void;
}) {
  const preset = EQUITIES.find((e) => e.symbol === symbol) ?? null;
  const { isConnected } = useAccount();
  const cfRead = useCollateralFactorsRead(data.holdings);
  const cfs = cfRead.cfs;
  const protect = useAgents(user).status.protect;
  const fee = useFeeSupport();
  const { creditBuy, phase, error, reset, busy, txHash } = useCreditBuy();

  const [step, setStep] = useState<Step>(preset ? "back" : "pick");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [stock, setStock] = useState<ReserveAsset | null>(preset);
  const [picked, setPicked] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [ack, setAck] = useState(false);

  const go = (next: Step) => {
    setDirection(ORDER.indexOf(next) > ORDER.indexOf(step) ? "forward" : "back");
    setStep(next);
    // The extra confirmation is for the plan on screen; any step away, or a new amount, asks again.
    setAck(false);
  };
  const close = () => {
    onClose();
    if (!busy) reset();
  };

  // F2-5 → F2-7: once the batch lands, Home with "Bought … with Credit Buy", the shares read from the receipt.
  useBoughtHome({ phase, user, symbol: stock?.symbol ?? "", txHash, credit: true, onClose });

  const held = data.holdings.filter((h) => h.freeShares + h.lockedShares > 0).sort((a, b) => valueOf(b) - valueOf(a));
  const others = EQUITIES.filter((e) => !held.some((h) => h.symbol === e.symbol)).sort((a, b) => a.name.localeCompare(b.name));
  const priceOf = (symbol: string) => data.holdings.find((h) => h.symbol === symbol)?.priceUsd ?? 0;

  const options = useMemo(
    () => (cfs ? backingOptions(data.holdings, cfs).filter((o) => o.freeUsd >= MIN_BACKING_USD).sort((a, b) => b.freeUsd - a.freeUsd) : []),
    [data.holdings, cfs],
  );
  // F2-4 picks the holding that lets this buy use the most until Sam picks another, so it offers F2-3's number first.
  const chosen = options.find((o) => o.stock.symbol === picked) ?? bestBacking(data, options)?.option ?? null;
  // F2-3's number: that same figure. Owning no stock needs no collateral factors to say $0.
  const available = cfs || held.length === 0 ? creditAvailable({ position: data, options, cash: data.cash, holdsStock: held.length > 0 }) : null;
  const pickStock = (s: ReserveAsset) => {
    // Until the number is known, it isn't known where a tap goes (F2-4, or a Buy with cash at $0).
    if (!available) return;
    if (available.why) {
      onBuyWithCash(s.symbol);
      return;
    }
    setStock(s);
    go("back");
  };

  const amount = Math.max(0, Number(raw) || 0);
  const creditRaw = parseUnits(amount.toFixed(USDC.decimals), USDC.decimals);
  const plan = planCredit({ position: data, options: chosen ? [chosen] : [], creditRaw, cash: data.cash });

  const quote = useBuyQuote(stock ?? undefined, amount);
  const q = quote.data ?? null;
  const oraclePriceUsd = stock ? priceOf(stock.symbol) : 0;
  const econ = q && stock ? quoteEconomics(q, stock, oraclePriceUsd) : null;

  // What backs it: the picked holding and what's in use; and what the plan puts in use, for the small print.
  const lead = chosen?.stock.symbol;
  const against = backers(data.holdings, lead ? [lead] : [], lead);
  const againstNames = against.map((h) => h.name);
  const backedBy = backers(data.holdings, plan.backing.map((b) => b.stock.symbol), lead).map((h) => h.name);

  let blocker: string | null = null;
  if (amount > 0 && amount < BUY_LIMITS.minUsd) blocker = `Minimum buy is ${formatUsd(BUY_LIMITS.minUsd)}.`;
  else if (amount > 0 && plan.block) blocker = CREDIT_BLOCKED[plan.block];
  else if (stock && amount > 0 && quote.isSuccess && q === null) blocker = `There’s no market for ${stock.name} right now.`;
  else if (econ && econ.premium > BUY_LIMITS.blockPremium)
    blocker = `Too big for the market right now: you’d pay ${(econ.premium * 100).toFixed(1)}% over Aave’s price. Try a smaller amount.`;
  const warnPremium = !blocker && econ && econ.premium > BUY_LIMITS.warnPremium;
  const ready = amount >= BUY_LIMITS.minUsd && !!econ && q?.amountIn === creditRaw && !blocker && !quote.isFetching;
  const feeBlocked = isConnected && fee.state === "unsupported";

  // F2-4 lists what can back it first, then what can't, and why.
  const backRows = [...held].sort((a, b) => Number(!!optionOf(options, b)) - Number(!!optionOf(options, a)));
  const title = step === "pick" ? "Credit Buy" : `Credit Buy ${stock?.name ?? ""}`;
  const back = step === "back" ? (preset ? null : "pick") : step === "amount" ? "back" : null;
  const leave = step === "back" && preset ? onBack : undefined;

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => !next && close()}
      title={title}
      // F2-3 opens the picker as tall as F1-3's Market (188px from the top), however few stocks there are.
      topPx={step === "pick" ? 188 : undefined}
      onBack={leave ?? (back ? () => !busy && go(back) : undefined)}
    >
      <SheetSteps stepKey={step} direction={direction} className="flex flex-col gap-3">
        {step === "pick" ? (
          <div className="flex flex-col gap-4 pt-1">
            <CreditHero available={available} failed={cfRead.failed} onRetry={cfRead.retry} />
            {held.length > 0 && (
              <PickList title="Your holdings">
                {held.map((h) => (
                  <PickRow
                    key={h.symbol}
                    symbol={h.symbol}
                    name={h.name}
                    owned={valueOf(h)}
                    priceUsd={h.priceUsd}
                    withCash={!!available?.why}
                    disabled={!available}
                    onClick={() => pickStock(EQUITIES.find((e) => e.symbol === h.symbol)!)}
                  />
                ))}
              </PickList>
            )}
            {others.length > 0 && (
              <PickList title={held.length > 0 ? "Other stocks" : "Stocks"}>
                {others.map((e) => (
                  <PickRow
                    key={e.symbol}
                    symbol={e.symbol}
                    name={e.name}
                    priceUsd={priceOf(e.symbol)}
                    withCash={!!available?.why}
                    disabled={!available}
                    onClick={() => pickStock(e)}
                  />
                ))}
              </PickList>
            )}
          </div>
        ) : step === "back" && stock ? (
          !cfs ? (
            cfRead.failed ? (
              <CantCheck onRetry={cfRead.retry} />
            ) : (
              <div aria-busy className="h-[180px] animate-pulse rounded-[16px] bg-chip" />
            )
          ) : (
            <>
              {/* D19: stocks earn no yield, so the board's "It keeps earning." is left out. */}
              <p className="m-0 -mt-1 text-[13px] leading-[1.4] text-ink-mid">
                {options.length > 0
                  ? "Pick what backs this buy."
                  : data.collateralUsd > 0
                    ? "Everything you hold is in use. It can still back this buy."
                    : "None of your stocks can back credit right now."}
              </p>
              <div role="radiogroup" aria-label="Backs this buy" className="flex flex-col gap-2">
                {backRows.map((h) => {
                  const o = optionOf(options, h);
                  return o ? (
                    <BackingRow
                      key={h.symbol}
                      holding={h}
                      checked={o === chosen}
                      right={<><span className="num text-[20px] font-bold leading-[1.1] tracking-[-0.02em]">{wholeUsd(creditWith(data, o))}</span><span className="whitespace-nowrap text-[11.5px] text-ink-mid">to buy {stock.name}</span></>}
                      onPick={() => setPicked(h.symbol)}
                    />
                  ) : (
                    <BackingRow key={h.symbol} holding={h} reason={unavailable(h)} />
                  );
                })}
              </div>
              {/* The board's "Your cash isn't used": the network fee is paid from cash (the locked fee row). */}
              <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">Amounts move with the price. Your cash only pays the network fee.</p>
              <Button variant="dark" disabled={!chosen && data.collateralUsd === 0} onClick={() => go("amount")} className="mt-1">
                Continue
              </Button>
            </>
          )
        ) : step === "amount" && stock ? (
          <>
            <AmountField
              label="On credit"
              source={
                against.length > 0 && (
                  <AmountSource mark={<StockAvatar symbol={against[0].symbol} size={16} />}>
                    Against {against[0].name}{against.length > 1 ? ` +${against.length - 1}` : ""}
                  </AmountSource>
                )
              }
              badge={<AmountBadge kind="credit" />}
              value={raw}
              onValue={(v) => {
                setRaw(v);
                setAck(false);
              }}
              onMax={() => {
                setRaw(String(Math.max(0, Math.floor(plan.maxUsd))));
                setAck(false);
              }}
              hint={`Up to ${wholeUsd(plan.maxUsd)} against your ${shortNames(againstNames)}`}
              autoFocus
            />
            <AmountArrow />
            <YouGet symbol={stock.symbol} shares={quote.isFetching && amount > 0 ? null : econ ? econ.shares : 0} priceUsd={econ ? econ.price : oraclePriceUsd} />
            <Summary
              rows={[
                { label: "Cost", value: `${formatUsd(monthlyCost(amount, data.apr))} / month` },
                { label: against.length === 1 ? `Credit left on ${against[0].name}` : "Credit left", value: wholeUsd(plan.maxUsd - amount) },
                {
                  label: "Status after",
                  value: <span className={AFTER_TONE[plan.after]}>{STATUS_LABEL[plan.after]}</span>,
                },
                NETWORK_FEE_ROW,
              ]}
            />
            {(blocker || warnPremium || plan.priceMayMove) && (
              <p role="status" className={`m-0 text-[13px] leading-snug ${blocker ? "text-act" : "text-watch-text"}`}>
                {blocker ??
                  (warnPremium
                    ? `You’d pay ${(econ!.premium * 100).toFixed(1)}% over Aave’s price — the market for ${stock.name} is small.`
                    : "Stock markets are closed. You can still buy, but the price can jump when they reopen.")}
              </p>
            )}
            {ready && (
              <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">
                {/* D7: every move in the batch, the stock put in use too. */}
                In one go:{" "}
                {inWords([
                  ...plan.backing.map((b) => {
                    const h = data.holdings.find((x) => x.symbol === b.stock.symbol)!;
                    return `${formatShares(rawToShares(b.raw, h.multiplier, b.stock.decimals))} ${tickerOf(b.stock.symbol)} goes in use to back credit`;
                  }),
                  `${formatUsd(amount)} of credit is taken`,
                  `exactly ${formatUsd(econ!.usd)} is approved for the ${VENUE_LABEL[q!.venue]} router and swapped`,
                ])}
                . You’ll owe {formatUsd(data.debtUsd + amount)}, backed by {shortNames(backedBy)}. {riskNote(backedBy, protect === "on")}{" "}
                {stock.name} here is a tokenized stock. It tracks the share price; it is not company shares or voting rights.
              </p>
            )}
            {ready && plan.extraConfirm && (
              <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]" />
                I understand this puts my credit in {STATUS_LABEL[plan.after]}. If my stocks fall, Aave can sell part of them.
              </label>
            )}
            {feeBlocked && (
              <p role="alert" className="m-0 text-[13px] text-act">
                Your account can’t pay network fees in USDC on Base right now, so this Credit Buy can’t go through.
              </p>
            )}
            <TxError error={error} />
            <div className="mt-1">
              <TxButton
                label="Credit Buy"
                size="md"
                phase={phase}
                preview={!isConnected}
                disabled={!ready || !q || feeBlocked || fee.loading || (plan.extraConfirm && !ack) || phase === "done"}
                onClick={() => {
                  if (!q) return;
                  if (phase !== "idle") reset();
                  void creditBuy({ user, stock, quote: q, plan, confirmedRisk: ack });
                }}
              />
            </div>
          </>
        ) : (
          <div aria-busy className="h-[320px] animate-pulse rounded-[16px] bg-chip" />
        )}
      </SheetSteps>
    </SheetShell>
  );
}

const optionOf = (options: BackingOption[], h: Holding) => options.find((o) => o.stock.symbol === h.symbol);

/** Why a holding can't back the buy, in a few words; none when it's all in use already (the row says so, with Repay). */
function unavailable(h: Holding): string | undefined {
  if (h.paused || h.frozen) return "Paused by Aave";
  if (h.freeUsd >= MIN_BACKING_USD) return "Can’t back credit";
  return h.lockedRaw > 0n ? undefined : "Too small to back credit";
}

/**
 * The risk line (F2-6's, now in the amount step's small print). The board's "Your cash is never touched" is left out:
 * the network fee comes from cash, and Protect repays from savings first (D11).
 */
function riskNote(backers: string[], protectOn: boolean): string {
  const one = backers.length === 1 ? backers[0] : null;
  if (protectOn) {
    return one
      ? `If ${one} falls, you can repay, or Protect repays from your cash or sells a little ${one} to keep you Safe.`
      : "If your stocks fall, you can repay, or Protect repays from your cash or sells a little of them to keep you Safe.";
  }
  return one
    ? `If ${one} falls, you can repay. If it falls too far, Aave can sell part of it to repay what you owe.`
    : "If your stocks fall, you can repay. If they fall too far, Aave can sell part of them to repay what you owe.";
}

/**
 * F2-3's head (Adrian, 2026-10-15): the most one Credit Buy can use, in whole dollars as the sheet's credit figures,
 * drawn like the balance hero's figure, read out as one amount; a pulse while the collateral factors load, and a plain
 * line with Try again if they can't be read. One plain line under it. At $0 the label drops "up to".
 */
function CreditHero({ available, failed, onRetry }: { available: CreditAvailable | null; failed: boolean; onRetry: () => void }) {
  const whole = available ? Math.floor(available.usd) : 0;
  return (
    <div className="flex flex-col gap-1.5 px-1 leading-[normal]">
      <span className="label">{available && whole === 0 ? "Credit you can use" : "You can use up to"}</span>
      {available ? (
        <span className="num inline-flex items-baseline">
          <span aria-hidden className="text-[22px] font-medium text-ink-mid">$</span>
          <span aria-hidden className="text-[44px] font-semibold leading-none tracking-[-0.04em]">{whole.toLocaleString("en-US")}</span>
          <span className="sr-only">{formatUsdTrim(whole)}</span>
        </span>
      ) : failed ? null : (
        <span role="status" className="h-[42px] w-[150px] animate-pulse rounded-xl bg-chip">
          <span className="sr-only">Loading</span>
        </span>
      )}
      {available ? (
        <p className="m-0 text-pretty text-[13px] leading-[1.4] text-ink-mid">{available.line}</p>
      ) : (
        failed && <CantCheck onRetry={onRetry} />
      )}
    </div>
  );
}

/** The collateral factors couldn't be read: say so, with Try again (ValueLine's pattern), instead of pulsing on. */
function CantCheck({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="status" className="m-0 flex items-center justify-between gap-3 text-[13px] leading-[normal] text-ink-mid">
      Your credit can’t be checked right now.
      <button type="button" onClick={onRetry} className="-my-3 h-11 shrink-0 font-semibold text-ink">Try again</button>
    </p>
  );
}

/** F2-3's titled white list. */
function PickList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 leading-[normal]">
      <h3 className="label m-0 px-1">{title}</h3>
      <div className="rounded-[16px] border border-line-field bg-card">{children}</div>
    </section>
  );
}

/**
 * A stock to Credit Buy (F2-3): badge, name ("You own $X" for a holding), its price. Stocks earn no yield (D19), so
 * "per share" sits where the board had the APY. `withCash`: with $0 to use it opens a Buy with cash, and its name says so.
 * `disabled` until the number is known.
 */
function PickRow({ symbol, name, owned, priceUsd, withCash, disabled, onClick }: {
  symbol: string;
  name: string;
  owned?: number;
  priceUsd: number;
  withCash: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="group flex min-h-16 w-full items-stretch pl-4 text-left text-ink">
      <span className="flex items-center py-2.5"><StockAvatar symbol={symbol} size={40} font={9.5} weight={800} /></span>
      <span className="ml-3 flex min-w-0 flex-1 items-center gap-3 border-b border-line-field py-2.5 pr-4 group-last:border-b-0">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[15px] font-semibold leading-[18px]">{name}</span>
          {owned !== undefined && (
            <span className="num whitespace-nowrap text-[13px] font-medium leading-[18px] text-ink-mid">
              You own <b className="font-semibold text-ink">{formatUsd(owned)}</b>
            </span>
          )}
        </span>
        <span className="num flex shrink-0 flex-col items-end gap-1 whitespace-nowrap">
          <span className="text-[15px] font-semibold leading-[18px]">{formatUsd(priceUsd)}</span>
          <span className="text-[12px] font-medium leading-4 text-ink-mid">per share</span>
        </span>
        <ChevronRight strokeWidth={2.2} className="shrink-0 text-ink-faint" />
        {withCash && <span className="sr-only">, buy with cash</span>}
      </span>
    </button>
  );
}

/**
 * A holding that could back the buy (F2-4): what it's worth, how much is in use, and either what it lets you buy
 * (`right`, a radio) or, without `onPick`, why it can't ("All in use · Repay", disabled).
 */
function BackingRow({ holding: h, checked = false, right, onPick, reason }: {
  holding: Holding;
  checked?: boolean;
  right?: ReactNode;
  onPick?: () => void;
  reason?: string;
}) {
  const ticker = tickerOf(h.symbol);
  const allInUse = !reason && h.lockedRaw > 0n && !onPick;
  const body = (
    <>
      <StockAvatar symbol={h.symbol} size={36} font={ticker.length > 4 ? undefined : 10.5} weight={800} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold">{h.name}</span>
        <span className="num whitespace-nowrap text-[12.5px] text-ink-mid">{formatUsd(valueOf(h))} · {formatShares(h.freeShares + h.lockedShares)} shares</span>
        {(h.lockedShares > 0 || reason) && (
          <span className="num whitespace-nowrap text-[12px] text-ink-mid">
            {reason ?? (
              <>
                <BacksIcon size={10} className="mr-1 inline align-[-1px] text-ink" />
                {allInUse ? (
                  <><b className="font-semibold text-ink">All</b> in use · <Link href="/repay" className="font-semibold text-ink no-underline">Repay</Link></>
                ) : (
                  <><b className="font-semibold text-ink">{formatShares(h.lockedShares)}</b> in use</>
                )}
              </>
            )}
          </span>
        )}
      </span>
      {onPick ? <span className="flex shrink-0 flex-col gap-px text-right">{right}</span> : <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-ink-mid">Not available</span>}
      {checked ? (
        <span aria-hidden className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-brand shadow-[0_0_0_1.5px_#0e0d0b]">
          <span className="size-2 rounded-full bg-ink" />
        </span>
      ) : (
        <span aria-hidden className="size-[22px] shrink-0 rounded-full border-[1.5px] border-[#d9d2c3]" />
      )}
    </>
  );
  const cls = "flex min-h-11 items-center gap-3 rounded-[16px] bg-card px-3.5 py-3 text-left leading-[normal] text-ink";
  return onPick ? (
    <button type="button" role="radio" aria-checked={checked} onClick={onPick} className={`${cls} ${checked ? "border-[1.5px] border-ink" : "border border-line-field"}`}>
      {body}
    </button>
  ) : (
    <div role="radio" aria-checked={false} aria-disabled aria-label={`${h.name}, not available${allInUse ? ": all in use" : reason ? `: ${reason}` : ""}`} className={`${cls} border border-line-field opacity-60`}>
      {body}
    </div>
  );
}
