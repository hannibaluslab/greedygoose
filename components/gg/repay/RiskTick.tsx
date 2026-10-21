/**
 * The one tick a free-up that ends in Watch asks for (canvas board 4), or in Act where the line allows it: until it's
 * ticked, nothing is prepared.
 */
export function RiskTick({
  checked,
  onChange,
  label,
  act = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  /** It ends in Act (the Wall's rule): Act's red, as Credit Buy's tick into Act. */
  act?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-[14px] px-3.5 py-3 text-[13px] leading-snug ${act ? "bg-act-bg text-act" : "bg-watch-soft text-watch-ink"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-px size-[18px] shrink-0 accent-ink"
      />
      {label}
    </label>
  );
}
