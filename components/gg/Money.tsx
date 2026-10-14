/** "$5,000.00" split the way the design draws it: small $, big integer, small cents. */
export function Money({
  value, size = 46, dollarSize, centsSize, className = "",
}: { value: number; size?: number; dollarSize?: number; centsSize?: number; className?: string }) {
  const [int, cents] = Math.abs(value).toFixed(2).split(".");
  const intFmt = Number(int).toLocaleString("en-US");
  return (
    <span className={`num inline-flex items-baseline ${className}`}>
      <span style={{ fontSize: dollarSize ?? Math.round(size * 0.48) }} className="font-medium text-ink-mid">{value < 0 ? "−$" : "$"}</span>
      <span style={{ fontSize: size, letterSpacing: "-0.04em", lineHeight: 1 }} className="font-semibold">{intFmt}</span>
      <span style={{ fontSize: centsSize ?? Math.round(size * 0.41) }} className="font-medium text-ink-mid">.{cents}</span>
    </span>
  );
}

/** Card-sized amount: "$2,000" + small grey ".00". */
export function MoneyCompact({
  value, size = 17, centsSize, centsClass = "text-subtle", lineHeight = 1.15,
}: { value: number; size?: number; centsSize?: number; centsClass?: string; lineHeight?: number | "normal" }) {
  const [int, cents] = value.toFixed(2).split(".");
  return (
    <span className="num inline-flex items-baseline font-semibold" style={{ fontSize: size, letterSpacing: "-0.03em", lineHeight }}>
      ${Number(int).toLocaleString("en-US")}
      <span className={centsClass} style={{ fontSize: centsSize ?? Math.round(size * 0.62), letterSpacing: "-0.01em" }}>.{cents}</span>
    </span>
  );
}
