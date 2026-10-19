type Option<T extends string> = { value: T; label: string };

/**
 * NYM's pill-shaped segmented control in the GreedyGoose kit (the stock sheet's chart ranges): a pale pill track,
 * the chosen option a white pill on it. Each option is drawn 30px tall and answers taps over 44px.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
}: {
  options: Option<T>[];
  value: T;
  onChange: (next: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`flex gap-0.5 rounded-full bg-pill p-[3px] ${className}`}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={`relative h-[30px] flex-1 whitespace-nowrap rounded-full text-[12.5px] font-semibold transition-colors after:absolute after:inset-x-0 after:-inset-y-[7px] ${
              active ? "bg-card text-ink shadow-card-elev" : "text-ink-mid"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
