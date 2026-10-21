import { NOT_LIVE, type ActCard, type Next, type WeekendCard } from "@/lib/agents/list";
import { atText } from "@/lib/agents/next";
import type { AgentStatus } from "@/lib/agents/status";
import { formatUsdTrim } from "@/lib/formatting";
import { fallTo } from "@/lib/risk/health";
import { STATUS_LABEL, statusFor } from "@/lib/risk/status";

/*
 * Protect's card on the Agents overview (Adrian validated it, 2026-10-20; the level bar is option A of board 7k): one
 * pill for what Protect itself is doing, the credit health as the big number with its status word, the levels bar, and
 * two lines: what it does now, and one supporting fact. Nothing on it can be tapped on its own: the whole card opens
 * Protect's sheet, where every action lives. The first state that applies wins. Pure, so the gallery and the tests draw
 * every state with the app's own words.
 */

export type PillTone = "on" | "neutral" | "act" | "needs" | "watch" | "working";

export type ProtectCardModel = {
  pill: { text: string; tone: PillTone };
  /** The credit health (Aave's health factor); null when nothing is owed. */
  hf: number | null;
  /** The status word beside it: Safe, Watch or Act; null when nothing is owed. */
  word: "Safe" | "Watch" | "Act" | null;
  /**
   * The levels bar: where the credit sits, Protect's line (`line`) and whether it guards it, a rescue's path to its
   * target, and the drop a weekend could bring (`dropPct`, while that's the risk).
   */
  bar: { hf: number | null; line: number; target: number; guarded: boolean; working: boolean; dropPct: number | null };
  line1: string;
  line2: string | null;
};

export type ProtectCardInput = {
  /** The agents can be switched on (AGENTS_LIVE); until then the card says they're coming. */
  live: boolean;
  nowSec: number;
  /** Protect as one agent: its two jobs together (agentStatus), as its sheet shows it. */
  status: AgentStatus;
  /**
   * Which of Protect's jobs JAW granted that the executor doesn't run yet (its registration is still to go): repaying
   * from cash first, else selling; null when neither waits.
   */
  waiting: "protect" | "sell" | null;
  /** The credit health; null when nothing is owed. */
  hf: number | null;
  /** A rescue is under way: Protect acts below the target until it's back. */
  rescuing: boolean;
  /** Failed runs in a row (the account's), and when the runner tries again. */
  fails: number;
  cooldownUntil: number;
  /** When Protect stopped without the user turning it off; null when it didn't. */
  stoppedAt: number | null;
  /** The soonest end of its grants while it has one. */
  endsAt: number | null;
  /** The Act warning (actWarning), when the credit is in Act above Protect's line or Protect is off. */
  act: ActCard | null;
  /** The weekend risk (weekendCard), before prices pause. */
  weekend: WeekendCard | null;
  /** Protect's next move from its rule (agentNexts). */
  next: Next;
  /** Protect's line and target (the executor's numbers). */
  triggerHf: number;
  targetHf: number;
};

/** A grant this close to its end says so. */
const ENDS_SOON_SEC = 7 * 86_400;
/** Failed runs in a row before the card says so (the executor switches the account off at eight). */
const RETRYING_AT = 3;

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const date = (sec: number) => DATE.format(sec * 1000);
const two = (hf: number) => hf.toFixed(2);

/** "Your stocks can fall 36%": the room before Protect's line, rounded down so it never overstates it. */
const fallPct = (hf: number, line: number) => Math.floor(fallTo(hf, line) * 100);

/** The next move as a line: "Next: repays $40 from your cash." or the rule's idle words, with a closing period. */
function nextLine(next: Next): string {
  const text = "will" in next ? `Next: ${next.will}` : next.idle;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function protectCard(i: ProtectCardInput): ProtectCardModel {
  const status = statusFor(i.hf);
  const word = status === "none" ? null : (STATUS_LABEL[status] as "Safe" | "Watch" | "Act");
  const line = two(i.triggerHf);
  const target = two(i.targetHf);
  const bar = (over: Partial<ProtectCardModel["bar"]> = {}) => ({
    hf: i.hf,
    line: i.triggerHf,
    target: i.targetHf,
    guarded: true,
    working: false,
    dropPct: null,
    ...over,
  });
  const card = (pill: string, tone: PillTone, line1: string, line2: string | null, over = {}): ProtectCardModel => ({
    pill: { text: pill, tone },
    hf: i.hf,
    word,
    bar: bar(over),
    line1,
    line2,
  });
  const actGap = i.act ? `Repaying ${formatUsdTrim(i.act.addUsd)} now brings it back to Watch.` : null;
  const room = i.hf !== null ? `Your stocks can fall ${fallPct(i.hf, i.triggerHf)}% before that.` : null;

  if (!i.live) return card("Soon", "neutral", NOT_LIVE, null, { guarded: false });
  // 1. JAW granted it and the executor doesn't run it yet: its registration is still to go.
  if (i.waiting === "protect" || (i.waiting === null && i.status === "starting"))
    return card("Needs you", "needs", "One more Face ID turns it on.", "Until then, nothing steps in.", {
      guarded: false,
    });
  if (i.waiting === "sell")
    return card(
      "Needs you",
      "needs",
      "One more Face ID turns on selling.",
      "Until then, it repays from your cash only.",
    );
  if (i.status === "off") {
    // 2. Stopped on its own: its year ran out, its runs kept failing, or it can no longer act on the account.
    if (i.stoppedAt !== null)
      return card("Stopped", "needs", `Stopped on ${date(i.stoppedAt)}. Nothing steps in now.`, null, {
        guarded: false,
      });
    // 3. Off, and the credit is in Act: nothing steps in.
    if (status === "act")
      return card("Off", "act", "Your credit is in Act. Nothing steps in.", actGap, { guarded: false });
    // 4. Off.
    return card("Off", "neutral", `When on, it steps in under ${line}.`, "Nothing steps in while it’s off.", {
      guarded: false,
    });
  }
  // 5. A rescue is under way: back to the target.
  if (i.rescuing)
    return card("Working", "working", `Bringing your credit back to ${target}.`, nextLine(i.next), { working: true });
  // 6. Runs keep failing.
  if (i.fails >= RETRYING_AT) {
    const retry =
      i.cooldownUntil > i.nowSec
        ? `Nothing moved. They try again ${atText(i.cooldownUntil, i.nowSec)}.`
        : "Nothing moved. They try again on the next run.";
    return card("Retrying", "watch", `Your agents’ last ${i.fails} runs didn’t go through.`, retry);
  }
  // Under Protect's line with no rescue started yet: about to step in, or held back (no cash, selling off, prices held).
  if (i.hf !== null && i.hf < i.triggerHf)
    return "will" in i.next
      ? card("On", "act", `Your credit is under ${line}.`, nextLine(i.next))
      : card("On hold", "needs", `Can’t bring your credit back to ${target} yet.`, nextLine(i.next));
  // 7. The credit is in Act, above Protect's line.
  if (status === "act")
    return card("On", "on", `Steps in if your credit falls under ${line}.`, actGap ?? nextLine(i.next));
  // 8. Prices pause soon, and a drop then could reach Aave's line.
  if (i.weekend) {
    const w = i.weekend;
    return card(
      "Weekend risk",
      "needs",
      `Prices pause ${w.when}. If stocks reopen ${w.dropPct}% lower, Aave can sell part of them.`,
      `Repaying ${formatUsdTrim(w.addUsd)} now keeps your credit over Aave’s line.`,
      { dropPct: w.dropPct },
    );
  }
  // 9. Its grant ends within a week, owed or not.
  if (i.endsAt !== null && i.endsAt - i.nowSec <= ENDS_SOON_SEC)
    return card("Ends soon", "watch", `Ends on ${date(i.endsAt)}. Then nothing steps in.`, room);
  // Nothing owed: nothing to guard.
  if (i.hf === null) return card("On", "on", "Nothing owed, nothing to do.", null);
  // 10. All good.
  return card("On", "on", `Steps in only under ${line}.`, room);
}

/** The card's one-line description for screen readers: name, pill, number, first line. */
export function protectCardLabel(m: ProtectCardModel): string {
  const health = m.hf === null ? "Nothing owed" : `Your credit health ${two(m.hf)}, ${m.word}`;
  return `Protector, ${m.pill.text.toLowerCase()}. ${health}. ${m.line1}`;
}
