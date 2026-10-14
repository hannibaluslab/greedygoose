import { formatUsdTrim } from "@/lib/formatting";

/**
 * A limit's chips (Manage "Its limit", ManageCredit "Can sell up to", an agent's sheet), with "a week" or "a day" after
 * them. The two boards draw them at slightly different sizes.
 */
export function LimitChips({
  label, options, value, onChange, per, size,
}: { label: string; options: readonly number[]; value: number | null; onChange: (usd: number) => void; per: string; size: "sm" | "md" }) {
  const sm = size === "sm";
  return (
    <div role="radiogroup" aria-label={label} className={`num flex items-center ${sm ? "gap-1.5" : "gap-2"}`}>
      {options.map((usd) => (
        <button
          key={usd}
          type="button"
          role="radio"
          aria-checked={usd === value}
          onClick={() => onChange(usd)}
          className={`flex items-center text-sm ${sm ? "h-[34px] rounded-[17px] px-3.5" : "h-9 rounded-[18px] px-4"} ${usd === value ? "bg-ink font-semibold text-on-ink" : "bg-pill font-medium text-ink"}`}
        >
          {formatUsdTrim(usd)}
        </button>
      ))}
      <span className={`text-sm text-ink-mid ${sm ? "ml-1" : "ml-0.5"}`}>{per}</span>
    </div>
  );
}
