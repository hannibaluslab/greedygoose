const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const formatUsd = (n: number) => usd.format(n);
export const formatUsdShort = (n: number) => (Math.abs(n) >= 1000 ? usd0.format(n) : usd.format(n));
export const formatShares = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 });
export const formatPct = (n: number) => `${(n * 100).toFixed(2)}%`;
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
