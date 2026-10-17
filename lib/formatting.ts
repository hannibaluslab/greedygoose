const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const formatUsd = (n: number) => usd.format(n);
export const formatUsdShort = (n: number) => (Math.abs(n) >= 1000 ? usd0.format(n) : usd.format(n));
/** Cents only when there are some: "$3", "$1.50" (the boards' "$3 / month", "$600 owed"). */
export const formatUsdTrim = (n: number) => usd.format(n).replace(/\.00$/, "");
export const formatShares = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 });
/** A dollar coin's amount, to the cent: "120", "1,000.5" (USDT, USDe…). */
export const formatCoin = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** "a", "a and b", "a, b and c". */
export const inWords = (parts: readonly string[]) =>
  parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** The line under a button that opens JAW's sheet more than once in one tap: "2 steps"; none for one. */
export const stepsNote = (n: number) => (n > 1 ? `${n} steps` : null);

/** Sign for a change: "−" (U+2212, as on the boards) below zero, "+" otherwise, judged on the rounded figure. */
const sign = (n: number, shown: string) => (n < 0 && Number(shown) !== 0 ? "−" : "+");

/** A fraction as a signed percent: 0.0142 → "+1.42%", −0.0058 → "−0.58%". */
export const formatSignedPct = (f: number) => {
  const shown = Math.abs(f * 100).toFixed(2);
  return `${sign(f, shown)}${shown}%`;
};

/** A dollar change: 38.2 → "+$38.20", −4.2 → "−$4.20". */
export const formatSignedUsd = (n: number) => {
  const shown = Math.abs(n).toFixed(2);
  return `${sign(n, shown)}${usd.format(Number(shown))}`;
};

/**
 * What credit costs, as a line: "$3 / month", or under a cent a month "$0.01 / month" (rounded up) so a small credit never
 * reads as free (Adrian: "$0.00 / month" on $1 of credit). Nothing owed is "$0 / month".
 */
export function monthlyCostText(monthlyUsd: number): string {
  if (monthlyUsd <= 0) return "$0 / month";
  if (monthlyUsd < 0.01) return "$0.01 / month";
  return `${monthlyUsd < 10 ? usd.format(Number(monthlyUsd.toFixed(2))) : formatUsdTrim(Math.round(monthlyUsd))} / month`;
}
