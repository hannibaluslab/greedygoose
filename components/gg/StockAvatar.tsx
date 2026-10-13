const COLORS: Record<string, string> = {
  NVDA: "#76b900", AAPL: "#2c2a25", AMZN: "#ff9900", GOOGL: "#4285f4", META: "#0866ff", MSFT: "#00a4ef", TSLA: "#cc0000",
};

/** Round ticker badge, as in the design (NVDA green, AAPL ink). */
export function StockAvatar({ symbol, size = 30 }: { symbol: string; size?: number }) {
  const ticker = symbol.replace(/c$/, "");
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-extrabold text-white"
      style={{ width: size, height: size, background: COLORS[ticker] ?? "#2c2a25", fontSize: (size >= 40 ? 10.5 : 9) * (ticker.length > 4 ? 0.8 : 1), letterSpacing: "0.02em" }}
    >
      {ticker}
    </span>
  );
}

export const tickerOf = (symbol: string) => symbol.replace(/c$/, "");
