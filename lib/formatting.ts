const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const formatUsd = (n: number) => usd.format(n);
export const formatUsdShort = (n: number) => (Math.abs(n) >= 1000 ? usd0.format(n) : usd.format(n));
/** Cents only when there are some: "$3", "$1.50" (the boards' "$3 / month", "$600 owed"). */
export const formatUsdTrim = (n: number) => usd.format(n).replace(/\.00$/, "");
export const formatShares = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 });
export const formatPct = (n: number) => `${(n * 100).toFixed(2)}%`;
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

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
