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
import { StatusChange } from "./Status";
import { ChevronRight, BacksIcon } from "./icons";
import { useAgents } from "@/hooks/useAgents";
import { useBoughtHome } from "@/hooks/useBoughtHome";
import { useBuyQuote } from "@/hooks/useBuyQuote";
import { useCreditBuy } from "@/hooks/useCreditBuy";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useCollateralFactorsRead, type Holding, type PositionData } from "@/hooks/usePosition";
import { monthlyCost } from "@/lib/aave/math";
import { cashRaw, feeBufferRaw } from "@/lib/cash";
import {
  CREDIT_BLOCKED, CREDIT_FROM, FEE_FIRST, backers, backingOptions, backingRaw, bestBacking, creditAvailable, creditWith, freeShownUsd, isAllFree,
  planCredit, shortNames,
  type BackingOption, type BackingPick, type CreditAvailable,
} from "@/lib/creditBuy";
import { formatShares, formatUsd, formatUsdTrim, inWords } from "@/lib/formatting";
import { STATUS_LABEL, type Status } from "@/lib/risk/status";
import { BUY_LIMITS, quoteEconomics } from "@/lib/swap/buy";
import { VENUE_LABEL } from "@/lib/swap/venues";
import { rawToShares } from "@/lib/tokens/b20";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

/** The four steps, backing first (Adrian, 2026-10-15): Back it with → How much → pick a stock → amount to buy. */
type Step = "back" | "much" | "pick" | "amount";
const ORDER: Step[] = ["back", "much", "pick", "amount"];
/** Step 1's row for what already backs credit: nothing new goes in use. */
const EXISTING = "existing";

const valueOf = (h: Holding) => h.freeUsd + h.lockedUsd;
/** "Status after" in words, coloured once it needs the extra confirmation. */
const AFTER_TONE: Record<Status, string> = { none: "", safe: "", watch: "text-watch-text", act: "text-act" };
/** Free stock worth less than this can't back a Credit Buy here: dust left over reads "All in use", as /use-credit tucks it away. */
const MIN_BACKING_USD = 1;
/** Credit figures in whole dollars, as the boards print them ("$700", "Up to $1,000"). */
const wholeUsd = (n: number) => formatUsdTrim(Math.max(0, Math.floor(n)));

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
  open, user, data, symbol, onClose, onBack, onBuyWithCash,
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
  const cfRead = useCollateralFactorsRead(data.holdings);
  const cfs = cfRead.cfs;
  const protect = useAgents(user).status.protect;
  const fee = useFeeSupport();

  const [step, setStep] = useState<Step>("back");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [stock, setStock] = useState<ReserveAsset | null>(preset);
  const [picked, setPicked] = useState<string | null>(null);
  // Step 2: the dollars typed, and the shares they were worth as they were typed (`backRaw`), or `backAll` after MAX or
  // the whole free value typed (exactly its free shares, whatever the price does next). `backFor` is the holding they
  // were typed for: another holding starts empty.
  const [backFor, setBackFor] = useState<string | null>(null);
  const [backUsd, setBackUsd] = useState("");
  const [backRaw, setBackRaw] = useState(0n);
  const [backAll, setBackAll] = useState(false);
  const [raw, setRaw] = useState("");
  const [ack, setAck] = useState(false);

  const go = (next: Step) => {
    setDirection(ORDER.indexOf(next) > ORDER.indexOf(step) ? "forward" : "back");
    setStep(next);
    // The extra confirmation is for the plan on screen; any step away, or a new amount, asks again.
    setAck(false);
  };
  const held = data.holdings.filter((h) => h.freeShares + h.lockedShares > 0).sort((a, b) => valueOf(b) - valueOf(a));
  const others = EQUITIES.filter((e) => !held.some((h) => h.symbol === e.symbol)).sort((a, b) => a.name.localeCompare(b.name));
  const priceOf = (symbol: string) => data.holdings.find((h) => h.symbol === symbol)?.priceUsd ?? 0;

  // What each free holding gives on its own (all its free shares), so a holding too small to reach the $1 minimum buy
  // is listed with that reason instead of being offered (Adrian: $1 of Alphabet read as "nothing free").
  const gives = useMemo(() => {
    const m = new Map<string, number>();
    if (!cfs) return m;
    for (const o of backingOptions(data.holdings, cfs)) {
      m.set(o.stock.symbol, planCredit({ position: data, backing: { option: o, raw: o.freeRaw }, creditRaw: 0n, cash: data.cash }).maxUsd);
    }
    return m;
  }, [data, cfs]);
  const options = useMemo(
    () =>
      cfs
        ? backingOptions(data.holdings, cfs)
            .filter((o) => o.freeUsd >= MIN_BACKING_USD && (gives.get(o.stock.symbol) ?? 0) >= BUY_LIMITS.minUsd)
            .sort((a, b) => b.freeUsd - a.freeUsd)
        : [],
    [data.holdings, cfs, gives],
  );
  // Whether a Credit Buy can use anything at all (with every free holding at its best): $0 says why on step 1.
  // Owning no stock needs no collateral factors to say $0.
  const available = cfs || held.length === 0 ? creditAvailable({ position: data, options, cash: data.cash, holdsStock: held.length > 0 }) : null;
  // The room on what already backs credit alone: step 1's "already backs" row.
  const existingRoom = creditWith(data);
  const canUseExisting = data.collateralUsd > 0 && existingRoom >= BUY_LIMITS.minUsd;
  // Step 1 picks the holding that can back the most until Sam picks another, else what already backs credit. A pick
  // that can't back it any more (under $1 free, paused, or no longer read) falls back to that default on step 1.
  const canPick = (key: string) => (key === EXISTING ? canUseExisting : options.some((o) => o.stock.symbol === key));
  const fallbackKey = bestBacking(data, options)?.option.stock.symbol ?? (canUseExisting ? EXISTING : null);
  const pickedKey = (step === "back" && picked && !canPick(picked) ? null : picked) ?? fallbackKey;
  const chosen = options.find((o) => o.stock.symbol === pickedKey) ?? null;
  const chosenHolding = chosen ? data.holdings.find((h) => h.symbol === chosen.stock.symbol) ?? null : null;
  // Past step 1, a picked holding that dropped out of the list: the buy can't quietly fall back to what already backs
  // credit, so nothing is prepared for it, and steps 2–4 say so and send Sam back to pick again (`lostPick`, below: not
  // once the batch is on its way or has landed).
  const pickGone = step !== "back" && !!picked && picked !== EXISTING && !chosen;

  // Step 2's typed backing, in raw units: MAX, or the whole free value typed, is exactly the free shares, so no dust is
  // left behind; otherwise the shares the dollars were worth when typed.
  const typed = !!chosen && backFor === chosen.stock.symbol;
  const backAmount = typed ? Math.max(0, Number(backUsd) || 0) : 0;
  const pick: BackingPick = { option: chosen, raw: chosen && typed ? (backAll ? chosen.freeRaw : backRaw) : 0n };
  // What this backing gives: "You can use up to $X" on step 2, step 3's number and step 4's "Up to" are this one figure.
  const room = planCredit({ position: data, backing: pick, creditRaw: 0n, cash: data.cash });
  const roomUsd = room.maxUsd;
  const canUse = roomUsd >= BUY_LIMITS.minUsd && room.block !== "over-free";

  const amount = Math.max(0, Number(raw) || 0);
  const creditRaw = parseUnits(amount.toFixed(USDC.decimals), USDC.decimals);
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
  const lead = chosen?.stock.symbol;
  const adding = pick.raw > 0n && lead ? [lead] : [];
  const against = backers(data.holdings, adding, lead);
  const againstNames = against.map((h) => h.name);

  let blocker: string | null = null;
  if (pickGone) blocker = "That stock can’t back credit right now.";
  else if (amount > 0 && amount < BUY_LIMITS.minUsd) blocker = `Minimum buy is ${formatUsd(BUY_LIMITS.minUsd)}.`;
  else if (amount > 0 && plan.block) blocker = CREDIT_BLOCKED[plan.block];
  else if (stock && amount > 0 && quote.isSuccess && q === null) blocker = `There’s no market for ${stock.name} right now.`;
  else if (econ && econ.premium > BUY_LIMITS.blockPremium)
    blocker = `Too big for the market right now: you’d pay ${(econ.premium * 100).toFixed(1)}% over Aave’s price. Try a smaller amount.`;
  const warnPremium = !blocker && econ && econ.premium > BUY_LIMITS.warnPremium;
  const ready = amount >= BUY_LIMITS.minUsd && !!econ && q?.amountIn === creditRaw && !blocker && !quote.isFetching;
  const feeBlocked = isConnected && fee.state === "unsupported";
  // What Credit Buy would sign now, prepared while the step is idle so the tap opens JAW's sheet at once.
  const signable =
    open && step === "amount" && stock && q && ready && !feeBlocked && !(plan.extraConfirm && !ack) ? { user, stock, quote: q, plan, confirmedRisk: ack } : null;
  const { sign, phase, error, reset, busy, txHash, checking, blocked } = useCreditBuy(signable);
  const lostPick = pickGone && !busy && phase !== "done";
  const close = () => {
    onClose();
    if (!busy) reset();
  };

  // F2-5 → F2-7: once the batch lands, Home with "Bought … with Credit Buy", the shares read from the receipt.
  useBoughtHome({ phase, user, symbol: stock?.symbol ?? "", txHash, credit: true, onClose });

  /** Step 1's pick: a new holding starts step 2 empty again (`backFor`), and step 4 too. */
  const choose = (key: string | null) => {
    if (key !== picked) setRaw("");
    setPicked(key);
  };
  /** Step 2's backing changed: the amount to buy was for the old one, so step 4 starts empty again. */
  const setBacking = (usd: string, all: boolean, rawIn: bigint) => {
    setBackFor(chosen?.stock.symbol ?? null);
    setBackUsd(usd);
    setBackAll(all);
    setBackRaw(rawIn);
    setRaw("");
    setAck(false);
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
  const back: Step | null =
    step === "much" ? "back" : step === "pick" ? (chosen ? "much" : "back") : step === "amount" ? (preset ? (chosen ? "much" : "back") : "pick") : null;
  const leave = step === "back" && preset ? onBack : undefined;
  // The plain line under "You can use up to": cash pays the network fee (D4), so without it the fee comes first.
  const creditLine = cashRaw(data.cash) < feeBufferRaw ? FEE_FIRST : CREDIT_FROM;

  return (
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
            cfRead.failed ? <CantCheck onRetry={cfRead.retry} /> : <div aria-busy className="h-[220px] animate-pulse rounded-[16px] bg-chip" />
          ) : available.why === "no-stocks" ? (
            // No stocks at all (Adrian: step 1 always shows): the step's title, an empty slot saying why, then the
            // stocks, which buy with cash. Holding any stock shows it below instead, with why it can't back this yet.
            <div className="flex flex-col gap-3 pt-1">
              <h3 className="label m-0 px-1">Back it with</h3>
              <div className="flex flex-col items-center gap-1.5 rounded-[16px] border-[1.5px] border-dashed border-[rgba(14,13,11,0.2)] px-5 py-5 text-center">
                <p className="m-0 text-[15px] font-semibold">
                  {available.why === "no-stocks" ? "No stocks to back it with yet" : "Nothing free to back it with"}
                </p>
                <p className="m-0 text-pretty text-[13px] leading-[1.4] text-ink-mid">{available.line}</p>
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
              <h3 className="label m-0 px-1">Back it with</h3>
              <div role="radiogroup" aria-label="Back it with" className="flex flex-col gap-2">
                {options.map((o) => {
                  const h = data.holdings.find((x) => x.symbol === o.stock.symbol)!;
                  return (
                    <BackingRow
                      key={h.symbol}
                      holding={h}
                      checked={pickedKey === h.symbol}
                      right={<><span className="num text-[20px] font-bold leading-[1.1] tracking-[-0.02em]">{wholeUsd(o.freeUsd)}</span><span className="whitespace-nowrap text-[11.5px] text-ink-mid">free</span></>}
                      onPick={() => choose(h.symbol)}
                    />
                  );
                })}
                {data.collateralUsd > 0 && (
                  <ExistingRow
                    names={backers(data.holdings, []).map((h) => h.name)}
                    valueUsd={data.collateralUsd}
                    roomUsd={existingRoom}
                    checked={pickedKey === EXISTING}
                    onPick={canUseExisting ? () => choose(EXISTING) : undefined}
                  />
                )}
                {unpickable.map((h) => {
                  const g = gives.get(h.symbol);
                  const reason = g != null && g < BUY_LIMITS.minUsd && !h.paused && !h.frozen && h.freeUsd >= MIN_BACKING_USD ? `Gives ${formatUsd(Math.max(0, g))} of credit, under the $1 minimum` : unavailable(h);
                  // All in use: the row above says what it backs; a holding left with dust still reads "All in use".
                  return <BackingRow key={h.symbol} holding={h} reason={reason} />;
                })}
              </div>
              {available.why ? (
                // Holdings, but none can back a Credit Buy yet: why, and the stocks still buy with cash.
                <>
                  <p role="status" className="m-0 px-1 text-[13px] leading-[1.4] text-ink-mid">{available.line}</p>
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
              {/* The board's "Your cash isn't used": the network fee is paid from cash. D19: no "It keeps earning." */}
              <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">Amounts move with the price. Your cash only pays the network fee.</p>
              <Button
                variant="dark"
                disabled={!pickedKey}
                onClick={() => {
                  // Hold the pick from here on: the default must not move to another holding when prices tick.
                  choose(pickedKey);
                  go(chosen ? "much" : afterBacking);
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
            cfRead.failed ? <CantCheck onRetry={cfRead.retry} /> : <div aria-busy className="h-[220px] animate-pulse rounded-[16px] bg-chip" />
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
        ) : step === "much" && chosen && chosenHolding ? (
          <>
            <AmountField
              label="How much to put in use"
              badge={<StockAvatar symbol={chosen.stock.symbol} />}
              value={typed ? backUsd : ""}
              onValue={(v) => {
                // The whole free value typed is all of it from now on; otherwise the shares it is worth now.
                const usd = Math.max(0, Number(v) || 0);
                setBacking(v, isAllFree(chosen, usd), backingRaw(chosen, usd));
              }}
              onMax={() => setBacking(freeShownUsd(chosen).toFixed(2), true, chosen.freeRaw)}
              hint={
                room.block === "over-free"
                  ? `${formatShares(chosenHolding.freeShares)} ${tickerOf(chosen.stock.symbol)} shares · ${formatUsd(chosen.freeUsd)} free`
                  : `${formatShares(rawToShares(pick.raw, chosenHolding.multiplier, chosen.stock.decimals))} of ${formatShares(chosenHolding.freeShares)} ${tickerOf(chosen.stock.symbol)} shares · ${formatUsd(chosen.freeUsd)} free`
              }
              autoFocus
            />
            <UseUpTo
              usd={canUse ? roomUsd : 0}
              line={
                room.block === "over-free"
                  ? null
                  : canUse
                    ? creditLine
                    : backAmount > 0 || pick.raw > 0n
                      ? `A Credit Buy needs at least ${formatUsd(BUY_LIMITS.minUsd)} of credit. Put more in use.`
                      : `Type how much ${chosen.stock.name} to put in use.`
              }
            />
            {canUse && (room.maxSafeUsd >= 1 || data.debtUsd > 0) && (
              <Summary
                rows={[
                  // How much of it keeps the credit Safe (D2's bands); none at all reads in the status instead.
                  ...(room.maxSafeUsd >= 1 ? [{ label: "Stays Safe up to", value: wholeUsd(room.maxSafeUsd) }] : []),
                  // What putting it in use does on its own, before any new credit (nothing owed has no status yet).
                  ...(data.debtUsd > 0 ? [{ label: "Status", value: <StatusChange from={room.before} to={room.after} /> }] : []),
                ]}
              />
            )}
            {room.block === "over-free" && (
              <p role="status" className="m-0 text-[13px] leading-snug text-act">
                That’s more than your free {chosen.stock.name} ({formatUsd(chosen.freeUsd)}).
              </p>
            )}
            {against.length > 0 && (
              <p className="m-0 px-0.5 text-[11.5px] leading-[1.45] text-subtle">{riskNote(againstNames, protect === "on")}</p>
            )}
            <Button variant="dark" disabled={!canUse} onClick={() => go(afterBacking)} className="mt-1">
              Continue
            </Button>
          </>
        ) : step === "pick" ? (
          <div className="flex flex-col gap-4 pt-1">
            <CreditHero available={{ usd: roomUsd, line: creditLine }} failed={false} onRetry={cfRead.retry} />
            <StockLists held={held} others={others} priceOf={priceOf} withCash={false} onPick={pickStock} />
          </div>
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
                . You’ll owe {formatUsd(data.debtUsd + amount)}, backed by {shortNames(againstNames)}. {riskNote(againstNames, protect === "on")}{" "}
                {stock.name} here is a tokenized stock. It tracks the share price; it is not company shares or voting rights.
              </p>
            )}
            {ready && plan.extraConfirm && (
              <label className="flex items-start gap-2.5 rounded-2xl bg-act-bg px-4 py-3 text-[13px] leading-snug text-act">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-px size-[18px] shrink-0 accent-[#8e2a1d]" />
                I understand this puts my credit in {STATUS_LABEL[plan.after]}. If my stocks fall too far, part of them can be sold to repay what I owe.
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
  );
}

const optionOf = (options: BackingOption[], h: Holding) => options.find((o) => o.stock.symbol === h.symbol);

/** Step 3's lists (F2-3): your holdings first, then the other stocks. `withCash`: the $0 state, where a tap buys with cash. */
function StockLists({ held, others, priceOf, withCash, onPick }: {
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
        <PickList title={held.length > 0 ? "Other stocks" : "Stocks"}>
          {others.map((e) => (
            <PickRow key={e.symbol} symbol={e.symbol} name={e.name} priceUsd={priceOf(e.symbol)} withCash={withCash} disabled={false} onClick={() => onPick(e)} />
          ))}
        </PickList>
      )}
    </>
  );
}

/**
 * Step 2's live answer under the amount: "You can use up to $X", the credit this backing gives with what already backs
 * credit (planCredit's MAX), in whole dollars like the sheet's other credit figures, and one plain line (none while a
 * red line says the amount is more than is free).
 */
function UseUpTo({ usd, line }: { usd: number; line: string | null }) {
  const whole = Math.floor(usd);
  return (
    <div className="flex flex-col gap-1 rounded-[16px] border border-line-field bg-card px-3.5 py-3 leading-[normal]" aria-live="polite">
      {/* At $0 the label drops "up to", as step 1's CreditHero does. */}
      <span className="label">{whole === 0 ? "Credit you can use" : "You can use up to"}</span>
      <span className="num inline-flex items-baseline">
        <span aria-hidden className="text-[18px] font-medium text-ink-mid">$</span>
        <span aria-hidden className="text-[32px] font-semibold leading-none tracking-[-0.04em]">{whole.toLocaleString("en-US")}</span>
        <span className="sr-only">{formatUsdTrim(whole)}</span>
      </span>
      {line && <p className="m-0 text-pretty text-[13px] leading-[1.4] text-ink-mid">{line}</p>}
    </div>
  );
}

/**
 * Step 1's row for what already backs credit (when there is some): picking it puts nothing new in use, and the buy
 * uses the room left on it. Without `onPick` (under the $1 minimum buy) it says there's nothing left, with Repay.
 */
function ExistingRow({ names, valueUsd, roomUsd, checked, onPick }: {
  names: string[];
  valueUsd: number;
  roomUsd: number;
  checked: boolean;
  onPick?: () => void;
}) {
  const body = (
    <>
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink"><BacksIcon size={12} /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold">Already backs credit</span>
        <span className="num truncate text-[12.5px] text-ink-mid">{shortNames(names)} · {formatUsd(valueUsd)}</span>
        {!onPick && (
          <span className="text-[12px] text-ink-mid">
            Nothing left to use · <Link href="/repay" className="font-semibold text-ink no-underline">Repay</Link>
          </span>
        )}
      </span>
      {onPick ? (
        <span className="flex shrink-0 flex-col gap-px text-right">
          <span className="num text-[20px] font-bold leading-[1.1] tracking-[-0.02em]">{wholeUsd(roomUsd)}</span>
          <span className="whitespace-nowrap text-[11.5px] text-ink-mid">left to use</span>
        </span>
      ) : (
        <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-ink-mid">Not available</span>
      )}
      <Radio checked={checked} />
    </>
  );
  const cls = "flex min-h-11 items-center gap-3 rounded-[16px] bg-card px-3.5 py-3 text-left leading-[normal] text-ink";
  return onPick ? (
    <button type="button" role="radio" aria-checked={checked} onClick={onPick} className={`${cls} ${checked ? "border-[1.5px] border-ink" : "border border-line-field"}`}>
      {body}
    </button>
  ) : (
    <div role="radio" aria-checked={false} aria-disabled aria-label="Already backs credit, not available: nothing left to use" className={`${cls} border border-line-field opacity-60`}>
      {body}
    </div>
  );
}

/** The rows' radio mark: lime with an ink dot when picked. */
function Radio({ checked }: { checked: boolean }) {
  return checked ? (
    <span aria-hidden className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-brand shadow-[0_0_0_1.5px_#0e0d0b]">
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
    ? `If ${one} falls, you can repay. If it falls too far, part of it can be sold to repay what you owe.`
    : "If your stocks fall, you can repay. If they fall too far, part of them can be sold to repay what you owe.";
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
 * A holding that could back the buy (step 1, board F2-4): what it's worth, how much is in use, and either its free
 * value (`right`, a radio) or, without `onPick`, why it can't ("All in use · Repay", disabled).
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
      <Radio checked={checked} />
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
