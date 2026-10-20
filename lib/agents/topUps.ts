import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from "viem";
import { nyDay, rebalanceCheckAt, whenText } from "@/lib/agents/next";
import { waitingRaw as waitingOf } from "@/lib/agents/rules/topUps";
import { formatUsdTrim } from "@/lib/formatting";
import { USDC } from "@/lib/tokens/registry";

/*
 * "Top-ups go into my mix", a Rebalance setting (SPEC, Agents), as its card in Rebalance's sheet shows it (boards
 * 7e–7h): the switch, Keep as cash, the line under it and at most one note. Pure, so the sheet, the dev gallery and the
 * tests draw every state with the same words. A top-up fills cash up to Keep first, and only the part above goes into
 * the mix, at the next market morning's check.
 */

/** Keep as cash: $500 to start (board 7f), whole dollars, $0 allowed, at most $1,000,000. */
export const KEEP_DEFAULT_USD = 500;
export const KEEP_MAX_USD = 1_000_000;
/** The most Keep may be in USDC units, what the allowlist lets `setTopUps` carry. */
export const KEEP_MAX_RAW = BigInt(KEEP_MAX_USD) * 10n ** BigInt(USDC.decimals);

export const TOP_UPS_TITLE = "Top-ups go into my mix";
export const TOP_UPS_SUB = "Each top-up buys what’s furthest below its target.";
export const KEEP_LABEL = "Keep as cash";

/** Why the switch can't be used: no executor that counts top-ups yet, or earning has to come first (P3's fallback). */
const NOT_AVAILABLE = "Not available yet.";
const EARNING_FIRST = "Turn on earning first.";

/** The setting as the executor keeps it. */
export type TopUpsSetting = { on: boolean; keepUsd: number };

/** The setting on screen: Keep is null while its field is empty. */
export type TopUpsChoice = { on: boolean; keepUsd: number | null };

/** What the card reads besides what's typed: the executor's side (M5) and the account's. */
export type TopUpsFacts = {
  /** The executor counts top-ups (its `topUps(account)` read doesn't revert). */
  available: boolean;
  /** Earning is off and can't be turned on in the same signature: the switch waits for it. */
  earningFirst: boolean;
  /** What the executor has; null before it's read or while it isn't available. */
  saved: TopUpsSetting | null;
  /** A counted top-up waiting for the next check, and when that check is. */
  waiting: { usd: number; atSec: number } | null;
  /** The cash rate now ("4.2%"); null before it's read. */
  rate: string | null;
  debtUsd: number;
  /** Protect · sell runs, so Protect has stock to sell when cash runs out. */
  protectSells: boolean;
  nowSec: number;
};

/** Before the executor counts top-ups (until M5): the switch says so, and nothing else shows. */
export const TOP_UPS_NOT_YET: Pick<TopUpsFacts, "available" | "earningFirst" | "saved" | "waiting"> = {
  available: false,
  earningFirst: false,
  saved: null,
  waiting: null,
};

export type TopUpsNote = { kind: "starts" | "waiting" | "warning"; title: string; line: string };

export type TopUpsView = {
  /** The switch is greyed: not available, earning comes first, or the setting isn't read yet. */
  disabled: boolean;
  /** The line under it saying why ("Not available yet."); null when there's none to say. */
  blocked: string | null;
  /** Keep as cash, its line and the note show while the switch is on. */
  open: boolean;
  helper: string | null;
  note: TopUpsNote | null;
};

/** "tomorrow at 10:00 AM", "Mon at 10:00 AM": whenText with "at" after the day (its day is always one word). */
const atText = (sec: number, nowSec: number) => whenText(sec, nowSec).replace(" ", " at ");

/**
 * The card's words. One note at most: the warning first (owing, Keep $0 and Protect can't sell), then "Starts with your
 * next top-up" while turning it on, then a top-up waiting for the next check.
 */
export function topUpsView(i: TopUpsFacts & TopUpsChoice): TopUpsView {
  // Earning first only blocks turning top-ups on: once they're on, switching them off and back stays possible.
  const blocked = !i.available ? NOT_AVAILABLE : i.earningFirst && !i.on && !i.saved?.on ? EARNING_FIRST : null;
  const disabled = blocked !== null || !i.saved;
  if (!i.on) return { disabled, blocked, open: false, helper: null, note: null };

  const helper =
    i.keepUsd === 0
      ? "Every top-up goes into your mix."
      : `Top-ups fill this first.${i.rate ? ` It keeps earning ${i.rate}.` : ""}`;
  const turningOn = !i.saved?.on;
  const note: TopUpsNote | null =
    i.keepUsd === 0 && i.debtUsd >= 0.01 && !i.protectSells
      ? {
          kind: "warning",
          title: "Protect may have nothing to use",
          line: `You owe ${formatUsdTrim(Math.ceil(i.debtUsd))} and Protect can’t sell. Keep some cash, or let Protect sell.`,
        }
      : turningOn
        ? { kind: "starts", title: "Starts with your next top-up", line: "The cash you have now stays as it is." }
        : i.waiting && i.waiting.usd >= 0.01
          ? {
              kind: "waiting",
              title: `${formatUsdTrim(i.waiting.usd)} waiting`,
              line: `Goes into your mix ${atText(i.waiting.atSec, i.nowSec)}. It earns until then.`,
            }
          : null;
  return { disabled, blocked, open: true, helper, note };
}

/** What's typed in Keep as cash: whole dollars, capped at KEEP_MAX_USD; null while empty. */
export function parseKeepUsd(text: string): number | null {
  const digits = text.split(".")[0].replace(/\D/g, "");
  return digits === "" ? null : Math.min(KEEP_MAX_USD, Number(digits));
}

/** Keep when the switch turns on: what the executor has while it's on, else $500 (the boards' default). */
export const keepToStart = (saved: TopUpsSetting | null) => (saved?.on ? saved.keepUsd : KEEP_DEFAULT_USD);

/** The choice the sheet opens on: what the executor has, off until it's read. */
export const choiceFrom = (saved: TopUpsSetting | null): TopUpsChoice => ({
  on: saved?.on ?? false,
  keepUsd: keepToStart(saved),
});

/** The setting Save sends (an empty Keep never saves); null while the executor's isn't read. */
export const settingFrom = (saved: TopUpsSetting | null, chosen: TopUpsChoice): TopUpsSetting | null =>
  saved ? { on: chosen.on, keepUsd: chosen.keepUsd ?? 0 } : null;

/** Keep as it shows in its field: "$500", "$1,000,000"; empty while null. */
export const keepText = (usd: number | null) => (usd === null ? "" : `$${usd.toLocaleString("en-US")}`);

/**
 * Whether the choice on screen differs from what the executor has. Keep counts only while the setting is on (its
 * field is hidden while off); nothing changes while the setting can't be read.
 */
export function topUpsChanged(saved: TopUpsSetting | null, chosen: TopUpsChoice): boolean {
  if (!saved) return false;
  return chosen.on !== saved.on || (chosen.on && chosen.keepUsd !== saved.keepUsd);
}

/** `topUps(account)` as GooseExecutor returns it: on, day, keep, ready, today, mark, own (CashRules.TopUps). */
type TopUpsTuple = readonly [boolean, number, number, bigint, bigint, bigint, bigint];

/** What `topUps(account)` answered: the struct, or a revert (an executor without top-ups has no such getter). */
export type TopUpsAnswer = { status: "success"; result: TopUpsTuple } | { status: "failure" };

/** The executor itself reverted (it has no `topUps` getter), as opposed to Base not answering (a 429, a dropped call). */
export const topUpsReverted = (error: unknown): boolean =>
  error instanceof BaseError &&
  !!error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError);

/**
 * A `topUps(account)` read as an answer: the struct (the last one Base gave, kept through a refetch that failed), a
 * revert, or undefined while Base hasn't answered. Base not answering is never "not available": read that way, Turn
 * off Rebalance would leave top-ups on, and the switch would say "Not available yet." on an executor that has them.
 */
export function topUpsAnswerOf(data: TopUpsTuple | undefined, error: unknown): TopUpsAnswer | undefined {
  if (data) return { status: "success", result: data };
  return topUpsReverted(error) ? { status: "failure" } : undefined;
}

/** Top-ups as the app reads them on Base. */
export type TopUpsRead = {
  /** The executor counts top-ups: its `topUps(account)` didn't revert (the executor live today has none). */
  available: boolean;
  /** The account's own switch (`setTopUps`). */
  on: boolean;
  /** Keep as cash, USDC units. */
  keepRaw: bigint;
  /** Counted and not in the mix yet: what's ready and today's count, after any fall since and within savings past Keep. */
  waitingRaw: bigint;
  /** When the last of it goes in: the next check for what's ready, the next market day's after today for today's. */
  readyAtSec: number;
};

/**
 * Reads `topUps(account)` the way GooseExecutor will act on it (lib/agents/rules/topUps.ts `waitingRaw`): at New York
 * day `nyDay(nowSec)` with `savingsRaw` in savings, and Rebalance's last day (`rebalanceDay`, one batch a day). A
 * revert means the executor doesn't count top-ups: not available, nothing waits.
 */
export function readTopUps(
  answer: TopUpsAnswer,
  ctx: { nowSec: number; savingsRaw: bigint; rebalanceDay: number },
): TopUpsRead {
  if (answer.status !== "success") return { available: false, on: false, keepRaw: 0n, waitingRaw: 0n, readyAtSec: 0 };
  const [on, day, keep, ready, today, mark, own] = answer.result;
  const keepRaw = BigInt(keep);
  if (!on) return { available: true, on, keepRaw, waitingRaw: 0n, readyAtSec: 0 };
  const now = nyDay(ctx.nowSec);
  const state = { day, keepRaw, readyRaw: ready, todayRaw: today, markRaw: mark, ownRaw: own };
  const w = waitingOf(state, now, ctx.savingsRaw);
  const waitingRaw = w.readyRaw + w.todayRaw;
  const readyAtSec =
    waitingRaw === 0n ? 0 : rebalanceCheckAt(ctx.nowSec, ctx.rebalanceDay, w.todayRaw > 0n ? now + 1 : 0);
  return { available: true, on, keepRaw, waitingRaw, readyAtSec };
}

/**
 * What the card reads from Base (`TopUpsFacts`' chain side): before the read is in, the switch waits with nothing to
 * say; a revert says "Not available yet." Earning never comes first: turning top-ups on while earning is off grants
 * earning in the same signature (P3, useManageSave).
 */
export function chainFacts(
  read: TopUpsRead | null,
): Pick<TopUpsFacts, "available" | "earningFirst" | "saved" | "waiting"> {
  if (!read) return { available: true, earningFirst: false, saved: null, waiting: null };
  if (!read.available) return TOP_UPS_NOT_YET;
  const usd = (raw: bigint) => Number(raw) / 10 ** USDC.decimals;
  return {
    available: true,
    earningFirst: false,
    saved: { on: read.on, keepUsd: Math.floor(usd(read.keepRaw)) },
    waiting: read.waitingRaw > 0n ? { usd: usd(read.waitingRaw), atSec: read.readyAtSec } : null,
  };
}

/** Keep as cash in USDC units, for `setTopUps`: whole dollars. */
export const keepRawOf = (keepUsd: number) => BigInt(Math.floor(keepUsd)) * 10n ** BigInt(USDC.decimals);
