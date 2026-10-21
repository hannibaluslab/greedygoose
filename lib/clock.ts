/*
 * Times the agents will act at, as the viewer reads them: their own clock with its GMT offset, "5:00 PM GMT+3"
 * (Adrian, 2026-10-21: "the 5 PM never came", read in another zone than the one he thought). Each takes an optional
 * IANA time zone, the viewer's own when left out, so the tests pin one.
 */

const formats = new Map<string, Intl.DateTimeFormat>();

/** One formatter per options and zone, made once: Intl formatters are slow to build. */
function format(key: string, options: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  const k = `${key}|${timeZone ?? ""}`;
  let f = formats.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
    formats.set(k, f);
  }
  return f;
}

/** The wall clock of `timeZone` at `sec`, as if it were UTC, in milliseconds. */
function wallMs(sec: number, timeZone?: string): number {
  const f = format(
    "wall",
    {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    },
    timeZone,
  );
  const p = Object.fromEntries(f.formatToParts(sec * 1000).map((x) => [x.type, x.value]));
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}

/** The calendar day `sec` falls on in `timeZone`, counted from 1970-01-01. */
export function dayIn(sec: number, timeZone?: string): number {
  return Math.floor(wallMs(sec, timeZone) / 86_400_000);
}

/** How far `timeZone`'s clock is ahead of GMT at `sec`, in minutes (−240 in New York's summer, 330 in India). */
export function gmtOffsetMinutes(sec: number, timeZone?: string): number {
  return Math.round((wallMs(sec, timeZone) - Math.floor(sec) * 1000) / 60_000);
}

/** "GMT+3", "GMT-4", "GMT+5:30", and "GMT" alone at no offset. */
export function gmtText(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "GMT";
  const abs = Math.abs(offsetMinutes);
  const minutes = abs % 60;
  return `GMT${offsetMinutes > 0 ? "+" : "-"}${Math.floor(abs / 60)}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

/**
 * "5 PM GMT+3", "5:30 PM GMT+5:30": the time on the viewer's clock, and its offset then (a check past a clock change
 * shows the new one). A whole hour drops its ":00" so "Tomorrow 5 PM GMT+3" stays on the card footer's one line at 402px.
 */
export function clockText(sec: number, timeZone?: string): string {
  const full = format("time", { hour: "numeric", minute: "2-digit" }, timeZone).format(sec * 1000);
  const time = full.replace(/:00(?=\s)/, "");
  return `${time} ${gmtText(gmtOffsetMinutes(sec, timeZone))}`;
}

/** "Mon", the weekday `sec` falls on in `timeZone`. */
export function weekdayText(sec: number, timeZone?: string): string {
  return format("weekday", { weekday: "short" }, timeZone).format(sec * 1000);
}
