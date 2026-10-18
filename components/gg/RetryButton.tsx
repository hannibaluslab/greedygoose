import { RefreshIcon } from "./icons";

/**
 * Try again, as a refresh icon: a round 44px tap target named "Try again" for screen readers. `inline`
 * sits in a line of text without moving it; `chip` is the grey round button under a message; `dark` the empty state's.
 */
export function RetryButton({ onClick, look = "chip" }: { onClick: () => void; look?: "inline" | "chip" | "dark" }) {
  const shape =
    look === "inline"
      ? "-my-3 size-11 text-ink"
      : look === "dark"
        ? "size-12 bg-ink text-on-ink"
        : "size-11 bg-chip text-ink";
  return (
    <button
      type="button"
      aria-label="Try again"
      title="Try again"
      onClick={onClick}
      className={`grid shrink-0 place-items-center rounded-full transition touch:active:scale-95 ${shape}`}
    >
      <RefreshIcon />
    </button>
  );
}
