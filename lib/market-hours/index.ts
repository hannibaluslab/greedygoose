/**
 * Coinbase tokenized-stock prices come from Chainlink 24/5 feeds: live from
 * Sunday 20:00 to Friday 20:00 America/New_York. Outside that window the last
 * price is held and interest still accrues. Holidays are not modelled here —
 * feed staleness is the authoritative signal once wired in.
 */
type MarketState = { open: boolean; reopensLabel: string };

function nyParts(now: Date) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { day, hour: Number(parts.hour) };
}

export function marketState(now: Date = new Date()): MarketState {
  const { day, hour } = nyParts(now);
  const closed =
    day === 6 || // Saturday
    (day === 5 && hour >= 20) || // Friday from 20:00
    (day === 0 && hour < 20); // Sunday before 20:00
  return { open: !closed, reopensLabel: "Sunday 8pm ET" };
}
