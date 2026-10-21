/**
 * The boards' switch (ManageCredit, ManageMonthly, Buy): 51 × 31, ink with a lime thumb when on, a light track with
 * a white thumb when off. A plain button, as NYM's toggle is: Radix's Switch fights vaul's drawer. It draws 31 tall but
 * takes taps 45 tall (an invisible 7px above and below), so it meets the 44px touch target without moving anything.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative flex h-[31px] w-[51px] shrink-0 items-center rounded-[16px] p-0.5 transition-colors before:absolute before:inset-x-0 before:-inset-y-[7px] disabled:opacity-45 ${checked ? "justify-end bg-ink" : "justify-start bg-ink/12"}`}
    >
      <span
        aria-hidden
        className={`size-[27px] rounded-[14px] ${checked ? "bg-brand" : "bg-card shadow-[0_1px_3px_rgba(14,13,11,0.2)]"}`}
      />
    </button>
  );
}
