import { formatUsdTrim } from "@/lib/formatting";
import { USDC } from "@/lib/tokens/registry";

/*
 * "Top-ups go into my mix", a Rebalance setting (SPEC, Agents), as its card in Rebalance's sheet shows it (boards
 * 7e–7h): the switch, Keep as cash, the line under it and at most one note. Pure, so the sheet, the dev gallery and the
 * tests draw every state with the same words. With it on, GooseGuard's wallet rule (decision 1): Save fills savings up
 * to Keep, and the wallet's cash above $1 and above what Keep still needs goes into the mix at the next round. Savings
 * never go into stock.
 */

/** Keep as cash: $500 to start (board 7f), whole dollars, $0 allowed, at most $1,000,000. */
export const KEEP_DEFAULT_USD = 500;
export const KEEP_MAX_USD = 1_000_000;
/** The most Keep may be in USDC units, what the allowlist lets `setTopUps` carry. */
export const KEEP_MAX_RAW = BigInt(KEEP_MAX_USD) * 10n ** BigInt(USDC.decimals);

export const TOP_UPS_TITLE = "Top-ups go into my mix";
export const TOP_UPS_SUB = "Each top-up buys what’s furthest below its target.";
export const KEEP_LABEL = "Keep as cash";

/** Why the switch can't be used: no Guard yet, or earning has to come first (P3's fallback). */
const NOT_AVAILABLE = "Not available yet.";
const EARNING_FIRST = "Turn on earning first.";

/** The setting as GooseGuard keeps it. */
export type TopUpsSetting = { on: boolean; keepUsd: number };

/** The setting on screen: Keep is null while its field is empty. */
export type TopUpsChoice = { on: boolean; keepUsd: number | null };

/** What the card reads besides what's typed: the Guard's side and the account's. */
export type TopUpsFacts = {
  /** A Guard is configured, so top-ups can be switched on. */
  available: boolean;
  /** Earning is off and can't be turned on in the same signature: the switch waits for it. */
  earningFirst: boolean;
  /** What the Guard has; null before it's read or while it isn't available. */
  saved: TopUpsSetting | null;
  /** Cash in the wallet waiting to go into the mix at the next round (the Planner's `topUpsReady`). */
  waiting: { usd: number } | null;
  /** The cash rate now ("4.2%"); null before it's read. */
  rate: string | null;
  debtUsd: number;
  /** Protect · sell runs, so Protect has stock to sell when cash runs out. */
  protectSells: boolean;
};

/** Before a Guard is configured: the switch says so, and nothing else shows. */
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
          title: "Protector may have nothing to use",
          line: `You owe ${formatUsdTrim(Math.ceil(i.debtUsd))} and Protector can’t sell. Keep some cash, or let Protector sell.`,
        }
      : turningOn
        ? { kind: "starts", title: "Starts with your next top-up", line: "The cash you have now stays as it is." }
        : i.waiting && i.waiting.usd >= 0.01
          ? {
              kind: "waiting",
              title: `${formatUsdTrim(i.waiting.usd)} waiting`,
              line: "Goes into your mix at the next round.",
            }
          : null;
  return { disabled, blocked, open: true, helper, note };
}

/** What's typed in Keep as cash: whole dollars, capped at KEEP_MAX_USD; null while empty. */
export function parseKeepUsd(text: string): number | null {
  const digits = text.split(".")[0].replace(/\D/g, "");
  return digits === "" ? null : Math.min(KEEP_MAX_USD, Number(digits));
}

/** Keep when the switch turns on: what the Guard has while it's on, else $500 (the boards' default). */
export const keepToStart = (saved: TopUpsSetting | null) => (saved?.on ? saved.keepUsd : KEEP_DEFAULT_USD);

/** The choice the sheet opens on: what the Guard has, off until it's read. */
export const choiceFrom = (saved: TopUpsSetting | null): TopUpsChoice => ({
  on: saved?.on ?? false,
  keepUsd: keepToStart(saved),
});

/** The setting Save sends (an empty Keep never saves); null while the Guard's isn't read. */
export const settingFrom = (saved: TopUpsSetting | null, chosen: TopUpsChoice): TopUpsSetting | null =>
  saved ? { on: chosen.on, keepUsd: chosen.keepUsd ?? 0 } : null;

/** Keep as it shows in its field: "$500", "$1,000,000"; empty while null. */
export const keepText = (usd: number | null) => (usd === null ? "" : `$${usd.toLocaleString("en-US")}`);

/**
 * Whether the choice on screen differs from what the Guard has. Keep counts only while the setting is on (its field
 * is hidden while off); nothing changes while the setting can't be read.
 */
export function topUpsChanged(saved: TopUpsSetting | null, chosen: TopUpsChoice): boolean {
  if (!saved) return false;
  return chosen.on !== saved.on || (chosen.on && chosen.keepUsd !== saved.keepUsd);
}

/** Top-ups as the app reads them on Base: GooseGuard's switch and Keep, and what waits to go in. */
export type TopUpsRead = {
  /** A Guard is configured. */
  available: boolean;
  /** The account's own switch (`setTopUps`). */
  on: boolean;
  /** Keep as cash, USDC units. */
  keepRaw: bigint;
  /** Wallet cash that goes into the mix at the next round (the Planner's `topUpsReady`); 0 while off or unread. */
  waitingRaw: bigint;
};

/**
 * What the card reads from Base (`TopUpsFacts`' chain side): before the read is in, the switch waits with nothing to
 * say; with no Guard it says "Not available yet." Earning never comes first: turning top-ups on while earning is off
 * grants earning in the same signature (P3, useManageSave).
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
    waiting: read.on && read.waitingRaw > 0n ? { usd: usd(read.waitingRaw) } : null,
  };
}

/** Keep as cash in USDC units, for `setTopUps`: whole dollars. */
export const keepRawOf = (keepUsd: number) => BigInt(Math.floor(keepUsd)) * 10n ** BigInt(USDC.decimals);
