"use client";

import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import { SheetShell, SheetSteps } from "@/components/sheets/SheetShell";
import { Button } from "./Button";
import { useMoneySheets } from "./MoneySheets";
import { BackingRow, CantBack, LeaveForRepay, ReadyRow, optionOf, unavailable, wholeUsd } from "./CreditBuyBacking";
import { CantCheck, CreditHero, StockLists } from "./CreditBuyStocks";
import { CreditBuyAmountStep } from "./CreditBuyAmountStep";
import { useAgents } from "@/hooks/useAgents";
import { useBoughtHome } from "@/hooks/useBoughtHome";
import { useBuyQuote } from "@/hooks/useBuyQuote";
import { useCreditBuy } from "@/hooks/useCreditBuy";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useBackingFactorsRead, type PositionData } from "@/hooks/usePosition";
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
  type BackingOption,
  type BackingPick,
} from "@/lib/creditBuy";
import { formatUsd } from "@/lib/formatting";
import { BUY_LIMITS, quoteEconomics } from "@/lib/swap/buy";
import { EQUITIES, USDC, byStockOrder, type ReserveAsset } from "@/lib/tokens/registry";

/**
 * Three steps (boards 30–34, Adrian 2026-10-18): what backs it (Credit ready, or a stock to back new credit) → pick a
 * stock → the amount to buy. How much stock goes in is worked out from the buy, so there is no step for it.
 */
type Step = "back" | "pick" | "amount";
const ORDER: Step[] = ["back", "pick", "amount"];
/** Step 1's Credit ready: the credit left on what already backs credit; nothing new goes in. */
const EXISTING = "existing";

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
  const ready = amount >= BUY_LIMITS.minUsd && !!econ && q?.amountIn === creditRaw && !blocker && !quote.isFetching;
  const feeBlocked = isConnected && fee.state === "unsupported";
  // What Credit Buy would sign now, prepared while the step is idle so the tap opens JAW's sheet at once.
  const signable =
    open && step === "amount" && stock && q && ready && !feeBlocked && !(plan.extraConfirm && !ack)
      ? { user, stock, quote: q, plan, confirmedRisk: ack }
      : null;
  const tx = useCreditBuy(signable);
  const { phase, reset, busy, txHash } = tx;
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
              <StockLists
                held={held}
                others={others}
                priceOf={priceOf}
                withCash={false}
                othersFirst
                onPick={pickStock}
              />
            </div>
          ) : step === "amount" && stock ? (
            <CreditBuyAmountStep
              data={data}
              stock={stock}
              chosen={chosen}
              pick={pick}
              reachUsd={reachUsd}
              raw={raw}
              setRaw={setRaw}
              ack={ack}
              setAck={setAck}
              amount={amount}
              quote={quote}
              q={q}
              econ={econ}
              oraclePriceUsd={oraclePriceUsd}
              plan={plan}
              blocker={blocker}
              ready={ready}
              protectOn={protect === "on"}
              feeBlocked={feeBlocked}
              feeLoading={fee.loading}
              isConnected={isConnected}
              signable={!!signable}
              tx={tx}
            />
          ) : (
            <div aria-busy className="h-[320px] animate-pulse rounded-[16px] bg-chip" />
          )}
        </SheetSteps>
      </SheetShell>
    </LeaveForRepay.Provider>
  );
}
