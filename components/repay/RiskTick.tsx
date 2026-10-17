/** The one tick a free-up that ends in Watch asks for (canvas board 4): until it's ticked, nothing is prepared. */
export function RiskTick({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-[14px] bg-watch-soft px-3.5 py-3 text-[13px] leading-snug text-watch-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-px size-[18px] shrink-0 accent-[#0e0d0b]"
      />
      {label}
    </label>
  );
}
