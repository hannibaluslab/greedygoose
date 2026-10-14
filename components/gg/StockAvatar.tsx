const COLORS: Record<string, string> = {
  NVDA: "#76b900", AAPL: "#2c2a25", AMZN: "#ff9900", GOOGL: "#4285f4", META: "#0866ff", MSFT: "#00a4ef", TSLA: "#e31937",
};

/**
 * Round ticker badge, as in the design: 30px on cards (9px, 800), 40px in lists (10.5px, 700), 16px inside a pill (5px).
 * Five-letter tickers step down to fit. `font` and `weight` set the boards that draw it otherwise, exactly as given
 * (F2-3's 40px list at 9.5px 800, F2-4's 36px at 10.5px 800).
 */
export function StockAvatar({ symbol, size = 30, font: fontPx, weight }: { symbol: string; size?: number; font?: number; weight?: number }) {
  const ticker = symbol.replace(/c$/, "");
  const font = fontPx ?? (size <= 20 ? 5 : size >= 40 ? 10.5 : 9) * (ticker.length > 4 ? 0.8 : 1);
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full text-white"
      style={{
        width: size, height: size, background: COLORS[ticker] ?? "#2c2a25",
        fontSize: font, fontWeight: weight ?? (size >= 40 ? 700 : 800), letterSpacing: "0.02em",
      }}
    >
      {ticker}
    </span>
  );
}

export const tickerOf = (symbol: string) => symbol.replace(/c$/, "");

/** A stock's badge colour, for the pieces that draw it beside its badge (the mix bar). */
export const stockColor = (symbol: string) => COLORS[tickerOf(symbol)] ?? "#2c2a25";
