"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { AmountArrow, AmountBadge, AmountField, AmountSource, YouGet } from "./AmountField";
import { Button } from "./Button";
import { useMoneySheets } from "./MoneySheets";
import { StockAvatar, tickerOf } from "./StockAvatar";
import { TxButton, TxError } from "./TxUi";
import { StatusChange, StatusMoveBar, StatusPill } from "./Status";
import { ChevronRight, BacksIcon } from "./icons";
import { useAgents } from "@/hooks/useAgents";
import { useBoughtHome } from "@/hooks/useBoughtHome";
import { useBuyQuote } from "@/hooks/useBuyQuote";
import { useCreditBuy } from "@/hooks/useCreditBuy";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useBackingFactorsRead, type Holding, type PositionData } from "@/hooks/usePosition";
import { monthlyCost } from "@/lib/aave/math";
import { cashRaw, feeBufferRaw } from "@/lib/cash";
import {
  CREDIT_BLOCKED,
  CREDIT_FROM,
  FEE_FIRST,
  backers,
  backingOptions,
  backingForBuy,
  MIN_BACKING_USD,
  NO_CREDIT,
  canBuyWithCash,
  creditAvailable,
  creditWith,
  ownCreditUsd,
  planCredit,
  shortNames,
  type BackingOption,
  type BackingPick,
  type CreditAvailable,
} from "@/lib/creditBuy";
import { formatShares, formatUsd, formatUsdTrim, inWords, monthlyCostText } from "@/lib/formatting";
import { STATUS_LABEL } from "@/lib/risk/status";
import { BUY_LIMITS, quoteEconomics } from "@/lib/swap/buy";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import { EQUITIES, USDC, byStockOrder, type ReserveAsset } from "@/lib/tokens/registry";
import { wholePct } from "@/lib/holding";

/**
 * Three steps (boards 30–34, Adrian 2026-10-18): what backs it (Credit ready, or a stock to back new credit) → pick a
 * stock → the amount to buy. How much stock goes in is worked out from the buy, so there is no step for it.
 */
type Step = "back" | "pick" | "amount";
const ORDER: Step[] = ["back", "pick", "amount"];
/** Step 1's Credit ready: the credit left on what already backs credit; nothing new goes in. */
const EXISTING = "existing";

const valueOf = (h: Holding) => h.freeUsd + h.backingUsd;
/**
 * Credit figures, rounded down so they're never more than there is: to the cent under $100 (a small account's "Up to
 * $0.68" isn't "$0"), in whole dollars above, as the boards print them ("Up to $417").
 */
/** What a backing is worth, rounded up so it's never shown as less than goes in: cents under $100, dollars above. */
const backedText = (n: number) => (n < 100 ? formatUsd(Math.ceil(n * 100 - 1e-6) / 100) : formatUsdTrim(Math.ceil(n)));
const wholeUsd = (n: number) => {
  const usd = Math.max(0, n);
  return usd < 100 ? formatUsd(Math.floor(usd * 100 + 1e-6) / 100) : formatUsdTrim(Math.floor(usd));
};

/**
 * Design boards "F2 · 3–5", reordered backing first (Adrian, 2026-10-15: "selecting and typing the amount of an asset
 * that you put in collateral to actually get the usdc to be able to then select one from the market sheet"):
 *  1. Back it with: a free holding (the one that can back the most is picked first), or what already backs credit.
 *  2. How much to put in use: dollars of that holding, MAX for all its free shares, with the shares under it. It starts
 *     empty and the live "You can use up to $X" under it answers from the first keystroke (planCredit with that pick).
 *  3. F2-3's stocks, opening on that same $X.
 *  4. F2-5's amount to buy, up to $X. Credit Buy opens JAW's own sheet: put exactly the typed backing in use, take the
 *     credit and buy, in one batch (useCreditBuy). F2-6's confirm is folded in (small print, the D2 risk tick).
 * Picking what already backs credit skips step 2. With $0 to use, step 1 says why, and a stock tapped there opens its
 * Buy step with cash (`onBuyWithCash`). Opened from a stock's sheet, the stock is remembered and step 3 is skipped;
 * Back from step 1 returns to that sheet. Once it lands it goes Home with the "Bought" toast (F2-7).
 */
export function CreditBuySheet({
  open,
  user,
  data,
  symbol,
  onClose,
  onBack,
  onBuyWithCash,
}: {
  open: boolean;
  user: `0x${string}`;
  data: PositionData;
  /** The stock to buy, picked already (resolved through the registry only); step 3's picker otherwise. */
  symbol?: string | null;
  onClose: () => void;
  /** Where Back goes from the first step when the stock was picked already (the stock's sheet). */
  onBack?: () => void;
  /** No credit to use: a stock tapped opens its Buy step with cash. */
  onBuyWithCash: (symbol: string) => void;
}) {
  const preset = EQUITIES.find((e) => e.symbol === symbol) ?? null;
  const { isConnected } = useAccount();
  const cfRead = useBackingFactorsRead(data.holdings);
  const cfs = cfRead.cfs;
  const protect = useAgents(user).status.protect;
  const fee = useFeeSupport();

  const [step, setStep] = useState<Step>("back");
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
  // Every list in Home's order (ruling 43): the stocks you hold, then the others.
  const held = data.holdings.filter((h) => h.freeShares + h.backingShares > 0).sort(byStockOrder);
  const others = EQUITIES.filter((e) => !held.some((h) => h.symbol === e.symbol));
  const priceOf = (symbol: string) => data.holdings.find((h) => h.symbol === symbol)?.priceUsd ?? 0;

  // What each free holding backs on its own (ownCreditUsd), so one too small for the smallest buy is listed with that
  // reason instead of being offered (Adrian: $1 of Alphabet read as "nothing free").
  const gives = useMemo(
    () => new Map(cfs ? backingOptions(data.holdings, cfs).map((o) => [o.stock.symbol, ownCreditUsd(data, o)]) : []),
    [data, cfs],
  );
  const options = useMemo(
    () =>
      cfs
        ? backingOptions(data.holdings, cfs)
            .filter((o) => o.freeUsd >= MIN_BACKING_USD && ownCreditUsd(data, o) >= BUY_LIMITS.minUsd)
            .sort((a, b) => byStockOrder(a.stock, b.stock))
        : [],
    [data, cfs],
  );
  // Whether a Credit Buy can use anything at all (with every free holding at its best): $0 says why on step 1.
  // Owning no stock needs no collateral factors to say $0.
  const available =
    cfs || held.length === 0
      ? creditAvailable({ position: data, options, cash: data.cash, holdsStock: held.length > 0 })
      : null;
  // The credit left on what already backs credit alone: step 1's Credit ready.
  const existingLeft = creditWith(data);
  // In Act no credit is taken (Act is the line): step 1's one line says so, with no list of why each holding can't.
  const inAct = available?.why === "in-act";
  const canUseExisting = data.totalBackingUsd > 0 && existingLeft >= BUY_LIMITS.minUsd;
  // Step 1 picks Credit ready until Sam picks another, else the stock that backs the most on its own. A pick that can't
  // back it any more (too small, paused, or no longer read) falls back to that default on step 1.
  const canPick = (key: string) => (key === EXISTING ? canUseExisting : options.some((o) => o.stock.symbol === key));
  const mostOwn = options.reduce<BackingOption | null>(
    (b, o) => (!b || ownCreditUsd(data, o) > ownCreditUsd(data, b) ? o : b),
    null,
  );
  const fallbackKey = canUseExisting ? EXISTING : (mostOwn?.stock.symbol ?? null);
  const pickedKey = (step === "back" && picked && !canPick(picked) ? null : picked) ?? fallbackKey;
  const chosen = options.find((o) => o.stock.symbol === pickedKey) ?? null;
  const chosenHolding = chosen ? (data.holdings.find((h) => h.symbol === chosen.stock.symbol) ?? null) : null;
  // Past step 1, a picked holding that dropped out of the list: the buy can't quietly fall back to what already backs
  // credit, so nothing is prepared for it, and the next steps say so and send Sam back to pick again (`lostPick`, below:
  // not once the batch is on its way or has landed).
  const pickGone = step !== "back" && !!picked && picked !== EXISTING && !chosen;

  // The most this pick can back: Credit ready's credit left, or what the stock backs on its own. Step 3's number and the
  // amount's "Up to" are this one figure.
  const reachUsd = chosen ? ownCreditUsd(data, chosen) : existingLeft;

  const amount = Math.max(0, Number(raw) || 0);
  const creditRaw = parseUnits(amount.toFixed(USDC.decimals), USDC.decimals);
  // Only what the buy needs goes in (boards 31–33): enough of the stock for it to stay Safe on its own, or all of it.
  const pick: BackingPick = { option: chosen, raw: chosen ? backingForBuy(chosen, amount) : 0n };
  const plan = planCredit({ position: data, backing: pick, creditRaw, cash: data.cash });

  // D2's tick is for the status it names: a price refresh that moves the result (Watch to Act) asks again.
  const [tickedFor, setTickedFor] = useState(plan.after);
  if (tickedFor !== plan.after) {
    setTickedFor(plan.after);
    setAck(false);
  }

  const quote = useBuyQuote(stock ?? undefined, amount);
  const q = quote.data ?? null;
  const oraclePriceUsd = stock ? priceOf(stock.symbol) : 0;
  const econ = q && stock ? quoteEconomics(q, stock, oraclePriceUsd) : null;

  // What backs it once it lands: what this buy puts in use (the picked holding first) and what's in use already.
  // Under the amount: what backs it, "Backed by 1.16 Apple · $290", all of it, or nothing new (Credit ready).
  const backedShares =
    chosen && chosenHolding ? rawToShares(pick.raw, chosenHolding.multiplier, chosen.stock.decimals) : 0;
  const backedUsd = chosen && chosen.freeRaw > 0n ? (Number(pick.raw) / Number(chosen.freeRaw)) * chosen.freeUsd : 0;
  const backingLine = !chosen
    ? "Nothing new goes in"
    : pick.raw <= 0n
      ? `Backed by ${chosen.stock.name}`
      : `Backed by ${pick.raw >= chosen.freeRaw ? "all " : ""}${formatShares(backedShares)} ${chosen.stock.name} · ${backedText(backedUsd)}`;
  // The bar moves once there's an amount the plan can read.
  const moved = amount > 0 && Number.isFinite(plan.hfAfter);
  const lead = chosen?.stock.symbol;
  const adding = pick.raw > 0n && lead ? [lead] : [];
  const against = backers(data.holdings, adding, lead);
  const againstNames = against.map((h) => h.name);

  let blocker: string | null = null;
  if (pickGone) blocker = "That stock can’t back credit right now.";
  else if (amount > 0 && amount < BUY_LIMITS.minUsd) blocker = `Minimum buy is ${formatUsd(BUY_LIMITS.minUsd)}.`;
  else if (amount > reachUsd + 1e-9)
    blocker = chosen
      ? `${chosen.stock.name} can back up to ${wholeUsd(reachUsd)}. Pick another stock for more.`
      : `Credit ready goes up to ${wholeUsd(reachUsd)}. Back new credit with a stock for more.`;
  else if (amount > 0 && plan.block) blocker = CREDIT_BLOCKED[plan.block];
  else if (stock && amount > 0 && quote.isSuccess && q === null)
    blocker = `There’s no market for ${stock.name} right now.`;
  else if (econ && econ.premium > BUY_LIMITS.blockPremium)
    blocker = `Too big for the market right now: you’d pay ${(econ.premium * 100).toFixed(1)}% over Aave’s price. Try a smaller amount.`;
  const warnPremium = !blocker && econ && econ.premium > BUY_LIMITS.warnPremium;
  const ready = amount >= BUY_LIMITS.minUsd && !!econ && q?.amountIn === creditRaw && !blocker && !quote.isFetching;
  const feeBlocked = isConnected && fee.state === "unsupported";
  // What Credit Buy would sign now, prepared while the step is idle so the tap opens JAW's sheet at once.
  const signable =
    open && step === "amount" && stock && q && ready && !feeBlocked && !(plan.extraConfirm && !ack)
      ? { user, stock, quote: q, plan, confirmedRisk: ack }
      : null;
  const { sign, phase, error, reset, busy, txHash, checking, blocked } = useCreditBuy(signable);
  const lostPick = pickGone && !busy && phase !== "done";
  const close = () => {
    onClose();
    if (!busy) reset();
  };
  const money = useMoneySheets();
  /** Credit Buy's Repay links: this sheet slides out as the Repay sheet slides in. */
  const leaveForRepay = () => {
    close();
    money.repay();
  };

  // F2-5 → F2-7: once the batch lands, Home with "Bought … with Credit Buy", the shares read from the receipt.
  useBoughtHome({ phase, user, symbol: stock?.symbol ?? "", txHash, credit: true, onClose });

  /** Step 1's pick: another one starts the amount empty again. */
  const choose = (key: string | null) => {
    if (key !== picked) setRaw("");
    setPicked(key);
  };
  const afterBacking: Step = preset ? "amount" : "pick";
  const pickStock = (s: ReserveAsset) => {
    setStock(s);
    go("amount");
  };

  // Step 1 lists what can back it first, then what already backs credit, then what can't, and why.
  const unpickable = held.filter((h) => !optionOf(options, h));
  // The stock being bought names the sheet once it's known: from step 4, or from the start when it was preset.
  const named = step === "amount" ? stock : preset;
  const title = named ? `Credit Buy ${named.name}` : "Credit Buy";
  const back: Step | null = step === "pick" ? "back" : step === "amount" ? (preset ? "back" : "pick") : null;
  const leave = step === "back" && preset ? onBack : undefined;
  // The plain line under "You can use up to": cash pays the network fee (D4), so without it the fee comes first.
  const creditLine = cashRaw(data.cash) < feeBufferRaw ? FEE_FIRST : CREDIT_FROM;

  return (
    <LeaveForRepay.Provider value={leaveForRepay}>
      <SheetShell
        open={open}
        onOpenChange={(next) => !next && close()}
        title={title}
        // Step 3 opens the picker as tall as F1-3's Market (188px from the top), however few stocks there are.
        topPx={step === "pick" ? 188 : undefined}
        onBack={leave ?? (back ? () => !busy && go(back) : undefined)}
      >
        <SheetSteps stepKey={step} direction={direction} className="flex flex-col gap-3">
          {step === "back" ? (
            !available ? (
              cfRead.failed ? (
                <CantCheck onRetry={cfRead.retry} />
              ) : (
                <div aria-busy className="h-[220px] animate-pulse rounded-[16px] bg-chip" />
              )
            ) : available.why === "no-stocks" ? (
              // No stocks at all (Adrian: step 1 always shows; rulings 8, 9): where credit comes from, what to do first
              // and, with no cash to buy one, Top up; then the stocks, which buy with cash. Holding any stock shows it
              // below instead, with why it can't back this yet.
              <div className="flex flex-col gap-3 pt-1">
                <h3 className="label m-0 px-1">Back it with</h3>
                <div className="flex flex-col items-center gap-1.5 rounded-[16px] border-[1.5px] border-dashed border-[rgba(14,13,11,0.2)] px-5 py-5 text-center">
                  <p className="m-0 text-[15px] font-semibold">{NO_CREDIT["no-stocks"]}</p>
                  <p className="m-0 text-pretty text-[13px] leading-[1.4] text-ink-mid">{available.line}</p>
                  {!canBuyWithCash(data.cash) && (
                    <Button
                      variant="dark"
                      onClick={() => {
                        close();
                        money.topUp();
                      }}
                      className="mt-2 w-full"
                    >
                      Top up
                    </Button>
                  )}
                </div>
                <StockLists
                  held={preset ? held.filter((h) => h.symbol === preset.symbol) : held}
                  others={preset ? others.filter((e) => e.symbol === preset.symbol) : others}
                  priceOf={priceOf}
                  withCash
                  onPick={(s) => onBuyWithCash(s.symbol)}
                />
              </div>
            ) : (
              <>
                {/* Board 30: Credit ready first (what already backs credit, nothing new goes in), then each stock that
                    can back new credit, with what it backs on its own. */}
                <div role="radiogroup" aria-label="Back it with" className="flex flex-col gap-2">
                  {canUseExisting && (
                    <ReadyRow
                      names={backers(data.holdings, []).map((h) => h.name)}
                      usd={existingLeft}
                      checked={pickedKey === EXISTING}
                      onPick={() => choose(EXISTING)}
                    />
                  )}
                  {options.length > 0 && <h3 className="label m-0 px-1 pt-2">Back new credit with</h3>}
                  {options.map((o) => {
                    const h = data.holdings.find((x) => x.symbol === o.stock.symbol)!;
                    return (
                      <BackingRow
                        key={h.symbol}
                        holding={h}
                        checked={pickedKey === h.symbol}
                        right={
                          <>
                            <span className="text-[11.5px] text-ink-mid">Up to</span>
                            <span className="num text-[20px] font-bold leading-[1.1] tracking-[-0.02em]">
                              {wholeUsd(ownCreditUsd(data, o))}
                            </span>
                          </>
                        }
                        onPick={() => choose(h.symbol)}
                      />
                    );
                  })}
                </div>
                <CantBack
                  inUse={
                    data.totalBackingUsd > 0 && !canUseExisting && !inAct
                      ? { names: backers(data.holdings, []).map((h) => h.name), usd: data.totalBackingUsd }
                      : null
                  }
                  items={
                    inAct
                      ? []
                      : unpickable.flatMap((h) => {
                          const g = gives.get(h.symbol);
                          const reason =
                            g != null && g < BUY_LIMITS.minUsd && !h.paused && !h.frozen && h.freeUsd >= MIN_BACKING_USD
                              ? `gives ${formatUsd(Math.max(0, g))} of credit, under the smallest buy`
                              : unavailable(h)?.toLowerCase();
                          // All in use: the line above already names it.
                          return reason ? [{ name: h.name, reason }] : [];
                        })
                  }
                />
                {available.why ? (
                  // Holdings, but none can back a Credit Buy yet: why, and the stocks still buy with cash.
                  <>
                    <p role="status" className="m-0 px-1 text-[13px] leading-[1.4] text-ink-mid">
                      {available.line}
                    </p>
                    <StockLists
                      held={preset ? held.filter((h) => h.symbol === preset.symbol) : held}
                      others={preset ? others.filter((e) => e.symbol === preset.symbol) : others}
                      priceOf={priceOf}
                      withCash
                      onPick={(s) => onBuyWithCash(s.symbol)}
                    />
                  </>
                ) : (
                  <>
                    {options.length > 0 && (
                      <p className="m-0 px-1 text-[12.5px] leading-[1.4] text-ink-mid">
                        Only what your buy needs goes in.
                      </p>
                    )}
                    <Button
                      variant="dark"
                      disabled={!pickedKey}
                      onClick={() => {
                        // Hold the pick from here on: the default must not move to another holding when prices tick.
                        choose(pickedKey);
                        go(afterBacking);
                      }}
                      className="mt-1"
                    >
                      Continue
                    </Button>
                  </>
                )}
              </>
            )
          ) : lostPick ? (
            // The holding picked on step 1 can't back credit any more (see `lostPick`): say so, and pick again.
            !cfs ? (
              cfRead.failed ? (
                <CantCheck onRetry={cfRead.retry} />
              ) : (
                <div aria-busy className="h-[220px] animate-pulse rounded-[16px] bg-chip" />
              )
            ) : (
              <>
                <p role="status" className="m-0 px-1 pt-1 text-[15px] leading-snug text-ink">
                  {EQUITIES.find((e) => e.symbol === picked)?.name ?? "That stock"} can’t back credit right now.
                </p>
                <Button variant="dark" onClick={() => go("back")} className="mt-1">
                  Pick again
                </Button>
              </>
            )
          ) : step === "pick" ? (
            <div className="flex flex-col gap-4 pt-1">
              <CreditHero available={{ usd: reachUsd, line: creditLine }} failed={false} onRetry={cfRead.retry} />
              <StockLists held={held} others={others} priceOf={priceOf} withCash={false} onPick={pickStock} />
            </div>
          ) : step === "amount" && stock ? (
            <>
              <AmountField
                label="On credit"
                source={
                  chosen ? (
                    <AmountSource mark={<StockAvatar symbol={chosen.stock.symbol} size={16} />}>
                      Back: {chosen.stock.name}
                    </AmountSource>
                  ) : (
                    <AmountSource mark={<BacksIcon size={12} />}>Credit ready</AmountSource>
                  )
                }
                badge={<AmountBadge kind="credit" />}
                value={raw}
                onValue={(v) => {
                  setRaw(v);
                  setAck(false);
                }}
                onMax={() => {
                  setRaw(String(Math.max(0, Math.floor(reachUsd))));
                  setAck(false);
                }}
                hint={
                  <span className="flex justify-between gap-2 text-[12.5px] text-ink-mid">
                    <span className="num truncate font-medium text-ink">{backingLine}</span>
                    <span className="shrink-0 whitespace-nowrap">
                      Up to <b className="num font-semibold text-ink">{wholeUsd(reachUsd)}</b>
                    </span>
                  </span>
                }
                autoFocus
              />
              <AmountArrow />
              <YouGet
                symbol={stock.symbol}
                shares={quote.isFetching && amount > 0 ? null : econ ? econ.shares : 0}
                priceUsd={econ ? econ.price : oraclePriceUsd}
              />
              {/* Board 34 (Adrian: say how much it moves): the bar from now to after, and the status change. */}
              <div className="flex flex-col gap-2 rounded-[16px] border border-line-field bg-card px-3.5 py-3 leading-[normal]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-ink-mid">Your credit</span>
                  {moved && plan.after !== plan.before ? (
                    <StatusChange from={plan.before} to={plan.after} />
                  ) : (
                    <StatusPill status={plan.before} size="sm" />
                  )}
                </div>
                <StatusMoveBar
                  now={data.healthFactor}
                  after={moved ? plan.hfAfter : undefined}
                  label={
                    moved
                      ? `Now ${STATUS_LABEL[plan.before]}, after this ${STATUS_LABEL[plan.after]}`
                      : STATUS_LABEL[plan.before]
                  }
                  className={moved ? "mt-5" : "mt-2"}
                />
                <div className="num mt-1 flex justify-between gap-3 border-t border-line-field pt-2 text-[12.5px]">
                  <span className="text-subtle">Cost</span>
                  <span className="font-semibold text-ink-2">
                    {(data.apr * 100).toFixed(1)}% a year · {monthlyCostText(monthlyCost(amount, data.apr))}
                  </span>
                </div>
              </div>
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
                  . You’ll owe {formatUsd(data.debtUsd + amount)}, backed by {shortNames(againstNames)}.{" "}
                  {riskNote(againstNames, protect === "on")}
                </p>
              )}
              {ready && plan.extraConfirm && (
                <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                    className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]"
                  />
                  I understand this puts my credit in {STATUS_LABEL[plan.after]}. If my stocks fall too far, part of
                  them can be sold to repay what I owe.
                </label>
              )}
              {feeBlocked && (
                <p role="alert" className="m-0 text-[13px] text-act">
                  Your account can’t pay network fees from your cash right now, so this Credit Buy can’t go through.
                </p>
              )}
              <TxError error={error} />
              <div className="mt-1">
                <TxButton
                  label="Credit Buy"
                  size="md"
                  phase={phase}
                  checking={checking}
                  preview={!isConnected}
                  disabled={!signable || fee.loading || blocked || phase === "done"}
                  onClick={() => {
                    if (!signable) return;
                    if (phase !== "idle") reset();
                    void sign();
                  }}
                />
              </div>
            </>
          ) : (
            <div aria-busy className="h-[320px] animate-pulse rounded-[16px] bg-chip" />
          )}
        </SheetSteps>
      </SheetShell>
    </LeaveForRepay.Provider>
  );
}

const optionOf = (options: BackingOption[], h: Holding) => options.find((o) => o.stock.symbol === h.symbol);

/** Step 3's lists (F2-3): your holdings first, then the other stocks. `withCash`: the $0 state, where a tap buys with cash. */
function StockLists({
  held,
  others,
  priceOf,
  withCash,
  onPick,
}: {
  held: Holding[];
  others: ReserveAsset[];
  priceOf: (symbol: string) => number;
  withCash: boolean;
  onPick: (s: ReserveAsset) => void;
}) {
  return (
    <>
      {held.length > 0 && (
        <PickList title="Your holdings">
          {held.map((h) => (
            <PickRow
              key={h.symbol}
              symbol={h.symbol}
              name={h.name}
              owned={valueOf(h)}
              priceUsd={h.priceUsd}
              withCash={withCash}
              disabled={false}
              onClick={() => onPick(EQUITIES.find((e) => e.symbol === h.symbol)!)}
            />
          ))}
        </PickList>
      )}
      {others.length > 0 && (
        <PickList title={withCash ? "Buy with cash" : held.length > 0 ? "Other stocks" : "Stocks"}>
          {others.map((e) => (
            <PickRow
              key={e.symbol}
              symbol={e.symbol}
              name={e.name}
              priceUsd={priceOf(e.symbol)}
              withCash={withCash}
              disabled={false}
              onClick={() => onPick(e)}
            />
          ))}
        </PickList>
      )}
    </>
  );
}

/**
 * Step 1's Credit ready (board 30): the credit left on what already backs credit, from which stocks, picked first.
 * Using it puts nothing new in, so the amount step shows how far it moves the credit.
 */
function ReadyRow({
  names,
  usd,
  checked,
  onPick,
}: {
  names: string[];
  usd: number;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onPick}
      className={`flex min-h-11 items-center gap-3 rounded-[16px] bg-card px-3.5 py-3 text-left leading-[normal] text-ink ${checked ? "border-[1.5px] border-ink" : "border border-line-field"}`}
    >
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink">
        <BacksIcon size={12} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold">Credit ready</span>
        <span className="truncate text-[12.5px] text-ink-mid">From {shortNames(names)}</span>
      </span>
      <span className="flex shrink-0 flex-col gap-px text-right">
        <span className="text-[11.5px] text-ink-mid">Up to</span>
        <span className="num text-[20px] font-bold leading-[1.1] tracking-[-0.02em]">{wholeUsd(usd)}</span>
      </span>
      <Radio checked={checked} />
    </button>
  );
}

/** How a Repay link inside the sheet leaves it for the Repay sheet (CreditBuySheet sets it). */
const LeaveForRepay = createContext<() => void>(() => {});

/** "Repay" inside a row or a note: opens the Repay sheet in this one's place. */
function RepayLink() {
  const repay = useContext(LeaveForRepay);
  return (
    <button type="button" onClick={repay} className="font-semibold text-ink">
      Repay
    </button>
  );
}

/** The rows' radio mark: lime with an ink dot when picked. */
function Radio({ checked }: { checked: boolean }) {
  return checked ? (
    <span
      aria-hidden
      className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-brand shadow-[0_0_0_1.5px_#0e0d0b]"
    >
      <span className="size-2 rounded-full bg-ink" />
    </span>
  ) : (
    <span aria-hidden className="size-[22px] shrink-0 rounded-full border-[1.5px] border-[#d9d2c3]" />
  );
}

/** Why a holding can't back the buy, in a few words; none when it's all in use already (the row says so, with Repay). */
function unavailable(h: Holding): string | undefined {
  if (h.paused || h.frozen) return "Paused by Aave";
  if (h.freeUsd >= MIN_BACKING_USD) return "Can’t back credit";
  return h.backingRaw > 0n ? undefined : "Too small to back credit";
}

/**
 * The risk line (F2-6's, now in the amount step's small print). The board's "Your cash is never touched" is left out:
 * the network fee comes from cash, and Protect repays from savings first (D11).
 */
function riskNote(backers: string[], protectOn: boolean): string {
  const one = backers.length === 1 ? backers[0] : null;
  // Act is the line (2026-10-15): Protect steps in only at Act, and brings the credit back to Watch.
  if (protectOn) {
    return one
      ? `If ${one} falls, you can repay. If your credit reaches Act, Protect repays from your cash or sells a little ${one} to bring it back to Watch.`
      : "If your stocks fall, you can repay. If your credit reaches Act, Protect repays from your cash or sells a little of them to bring it back to Watch.";
  }
  return one
    ? `If ${one} falls, you can repay. If it falls too far, part of it can be sold to repay what you owe.`
    : "If your stocks fall, you can repay. If they fall too far, part of them can be sold to repay what you owe.";
}

/**
 * F2-3's head (Adrian, 2026-10-15): the most one Credit Buy can use, in whole dollars as the sheet's credit figures,
 * drawn like the balance hero's figure, read out as one amount; a pulse while the collateral factors load, and a plain
 * line with Try again if they can't be read. One plain line under it. At $0 the label drops "up to".
 */
function CreditHero({
  available,
  failed,
  onRetry,
}: {
  available: CreditAvailable | null;
  failed: boolean;
  onRetry: () => void;
}) {
  // Rounded down; to the cent under $100, so a small account's $0.72 isn't "$0".
  const figure = available ? wholeUsd(available.usd) : "$0";
  const none = !available || available.usd < 0.01;
  return (
    <div className="flex flex-col gap-1.5 px-1 leading-[normal]">
      <span className="label">{available && none ? "Credit you can use" : "You can use up to"}</span>
      {available ? (
        <span className="num inline-flex items-baseline">
          <span aria-hidden className="text-[22px] font-medium text-ink-mid">
            $
          </span>
          <span aria-hidden className="text-[44px] font-semibold leading-none tracking-[-0.04em]">
            {figure.replace("$", "")}
          </span>
          <span className="sr-only">{figure}</span>
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
      <button type="button" onClick={onRetry} className="-my-3 h-11 shrink-0 font-semibold text-ink">
        Try again
      </button>
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
function PickRow({
  symbol,
  name,
  owned,
  priceUsd,
  withCash,
  disabled,
  onClick,
}: {
  symbol: string;
  name: string;
  owned?: number;
  priceUsd: number;
  withCash: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex min-h-16 w-full items-stretch pl-4 text-left text-ink"
    >
      <span className="flex items-center py-2.5">
        <StockAvatar symbol={symbol} size={40} font={9.5} weight={800} />
      </span>
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
 * A holding that could back the buy (step 1, board F2-4): what it's worth, how much is in use, and either its free
 * value (`right`, a radio) or, without `onPick`, why it can't ("All in use · Repay", disabled).
 */
function BackingRow({
  holding: h,
  checked = false,
  right,
  onPick,
  reason,
}: {
  holding: Holding;
  checked?: boolean;
  right?: ReactNode;
  onPick?: () => void;
  reason?: string;
}) {
  const ticker = tickerOf(h.symbol);
  const allInUse = !reason && h.backingRaw > 0n && !onPick;
  const body = (
    <>
      <StockAvatar symbol={h.symbol} size={36} font={ticker.length > 4 ? undefined : 10.5} weight={800} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[15px] font-semibold">
          {h.name}
          {onPick && h.backingShares > 0 && (
            <span
              title={`${wholePct(h.backingShares / (h.freeShares + h.backingShares))}% backs credit`}
              className="num inline-flex h-[18px] items-center gap-[3px] rounded-[9px] bg-ground px-1.5 text-[10.5px] font-semibold text-ink-2"
            >
              {wholePct(h.backingShares / (h.freeShares + h.backingShares))}%
              <BacksIcon size={10} />
            </span>
          )}
        </span>
        <span className="num whitespace-nowrap text-[12.5px] text-ink-mid">
          {formatShares(h.freeShares + h.backingShares)} shares
        </span>
        {!onPick && (h.backingShares > 0 || reason) && (
          <span className="num whitespace-nowrap text-[12px] text-ink-mid">
            {reason ?? (
              <>
                <BacksIcon size={10} className="mr-1 inline align-[-1px] text-ink" />
                {allInUse ? (
                  <>
                    <b className="font-semibold text-ink">All</b> in use · <RepayLink />
                  </>
                ) : (
                  <>
                    <b className="font-semibold text-ink">{formatShares(h.backingShares)}</b> in use
                  </>
                )}
              </>
            )}
          </span>
        )}
      </span>
      {onPick ? (
        <span className="flex shrink-0 flex-col gap-px text-right">{right}</span>
      ) : (
        <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-ink-mid">Not available</span>
      )}
      <Radio checked={checked} />
    </>
  );
  const cls = "flex min-h-11 items-center gap-3 rounded-[16px] bg-card px-3.5 py-3 text-left leading-[normal] text-ink";
  return onPick ? (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onPick}
      className={`${cls} ${checked ? "border-[1.5px] border-ink" : "border border-line-field"}`}
    >
      {body}
    </button>
  ) : (
    <div
      role="radio"
      aria-checked={false}
      aria-disabled
      aria-label={`${h.name}, not available${allInUse ? ": all in use" : reason ? `: ${reason}` : ""}`}
      className={`${cls} border border-line-field opacity-60`}
    >
      {body}
    </div>
  );
}

/**
 * Step 1's quiet note for what can't back this buy (Adrian: disabled rows repeated each other): what already backs
 * credit with nothing left, and holdings too small or paused, each in a few words. Nothing to pick here.
 */
function CantBack({
  inUse,
  items,
}: {
  inUse: { names: string[]; usd: number } | null;
  items: { name: string; reason: string }[];
}) {
  if (!inUse && items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-[16px] border border-dashed border-line-field px-3.5 py-3 text-[12.5px] leading-[1.45] text-ink-mid">
      {inUse && (
        <p className="m-0">
          <BacksIcon size={10} className="mr-1 inline align-[-1px] text-ink" />
          <b className="font-semibold text-ink">{shortNames(inUse.names)}</b> ({formatUsd(inUse.usd)}) already{" "}
          {inUse.names.length > 1 ? "back" : "backs"} your credit, with nothing left to use. <RepayLink />
        </p>
      )}
      {items.map((i) => (
        <p key={i.name} className="m-0">
          <b className="font-semibold text-ink">{i.name}</b>: {i.reason}.
        </p>
      ))}
    </div>
  );
}
