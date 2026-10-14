const COLORS: Record<string, string> = {
  NVDA: "#76b900", AAPL: "#2c2a25", AMZN: "#ff9900", GOOGL: "#4285f4", META: "#0866ff", MSFT: "#00a4ef", TSLA: "#e31937",
};

/** The company logos (public/stocks, 128px, from CoinGecko's listing of each Coinbase stock token). */
const LOGOS = new Set(["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA"]);

/**
 * Round stock badge: the company's logo (Adrian, 2026-10-14), or the ticker on its colour for a stock without one.
 * Sizes as in the design: 30px on cards, 40px in lists, 16px inside a pill. A hairline keeps the white logos (Alphabet,
 * Meta) off the cream ground. For the ticker fallback, five-letter tickers step down to fit, and `font` and `weight`
 * set the boards that draw it otherwise (F2-3's 40px list at 9.5px 800, F2-4's 36px at 10.5px 800).
 */
export function StockAvatar({ symbol, size = 30, font: fontPx, weight }: { symbol: string; size?: number; font?: number; weight?: number }) {
  const ticker = symbol.replace(/c$/, "");
  if (LOGOS.has(ticker)) {
    return (
      <span
        aria-hidden
        className="block shrink-0 overflow-hidden rounded-full bg-cover bg-center shadow-[inset_0_0_0_1px_rgba(14,13,11,0.08)]"
        style={{ width: size, height: size, backgroundImage: `url(/stocks/${ticker}.png)` }}
      />
    );
  }
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
