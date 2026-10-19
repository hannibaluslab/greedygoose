"use client";

import { useState } from "react";
import { parseUnits } from "viem";
import { SheetShell, SheetSteps } from "@/components/gg/kit/SheetShell";
import { useMoneySheets } from "../cash/MoneySheets";
import { LeaveForRepay } from "./CreditBuyBacking";
import { CreditHero, StockLists } from "./CreditBuyStocks";
import { CreditBuyBackStep, LostPick, useBackingPick } from "./CreditBuyBackStep";
import { CreditBuyAmountStep } from "./CreditBuyAmountStep";
import { useCreditBuyAmount } from "./useCreditBuyAmount";
import { useAgents } from "@/hooks/useAgents";
import { useBoughtHome } from "@/hooks/useBoughtHome";
import { useBackingFactorsRead, type PositionData } from "@/hooks/usePosition";
import { backingForBuy, creditLine, planCredit, type BackingPick } from "@/lib/creditBuy";
import { EQUITIES, USDC, type ReserveAsset } from "@/lib/tokens/registry";

/**
 * Three steps (boards 30–34, Adrian 2026-10-18): what backs it (Credit ready, or a stock to back new credit) → pick a
 * stock → the amount to buy. How much stock goes in is worked out from the buy, so there is no step for it.
 */
type Step = "back" | "pick" | "amount";
const ORDER: Step[] = ["back", "pick", "amount"];

/**
 * The sheet's title and the step Back goes to: the stock being bought names it once it's known, from step 3, or from
 * the start when it was preset (then Back skips the stock picker).
 */
function navOf(step: Step, stock: ReserveAsset | null, preset: ReserveAsset | null) {
  const named = step === "amount" ? stock : preset;
  const back: Step | null = step === "pick" ? "back" : step === "amount" ? (preset ? "back" : "pick") : null;
  return { title: named ? `Credit Buy ${named.name}` : "Credit Buy", back };
}

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
  const cfRead = useBackingFactorsRead(data.holdings);
  const cfs = cfRead.cfs;
  const protect = useAgents(user).status.protect;

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
  const {
    held,
    others,
    priceOf,
    options,
    available,
    existingLeft,
    canUseExisting,
    pickedKey,
    chosen,
    pickGone,
    reachUsd,
  } = useBackingPick({ data, cfs, onFirstStep: step === "back", picked });

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

  const buy = useCreditBuyAmount({
    open,
    onAmountStep: step === "amount",
    user,
    stock,
    amount,
    creditRaw,
    plan,
    ack,
    pickGone,
    reachUsd,
    chosen,
    priceOf,
  });
  const { tx } = buy;
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
  const pickStock = (s: ReserveAsset) => {
    setStock(s);
    go("amount");
  };

  const { title, back } = navOf(step, stock, preset);
  const leave = step === "back" && preset ? onBack : undefined;

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
            <CreditBuyBackStep
              data={data}
              cfs={cfs}
              cfFailed={cfRead.failed}
              onRetry={cfRead.retry}
              available={available}
              options={options}
              held={held}
              others={others}
              preset={preset}
              priceOf={priceOf}
              existingLeft={existingLeft}
              canUseExisting={canUseExisting}
              pickedKey={pickedKey}
              onChoose={choose}
              onContinue={() => {
                // Hold the pick from here on: the default must not move to another holding when prices tick.
                choose(pickedKey);
                go(preset ? "amount" : "pick");
              }}
              onTopUp={() => {
                close();
                money.topUp();
              }}
              onBuyWithCash={onBuyWithCash}
            />
          ) : lostPick ? (
            // The holding picked on step 1 can't back credit any more (see `lostPick`): say so, and pick again.
            <LostPick
              symbol={picked}
              read={!!cfs}
              cfFailed={cfRead.failed}
              onRetry={cfRead.retry}
              onPickAgain={() => go("back")}
            />
          ) : step === "pick" ? (
            <div className="flex flex-col gap-4 pt-1">
              <CreditHero
                available={{ usd: reachUsd, line: creditLine(data.cash) }}
                failed={false}
                onRetry={cfRead.retry}
              />
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
              {...buy}
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
              plan={plan}
              protectOn={protect === "on"}
            />
          ) : (
            <div aria-busy className="h-[320px] animate-pulse rounded-[16px] bg-chip" />
          )}
        </SheetSteps>
      </SheetShell>
    </LeaveForRepay.Provider>
  );
}
