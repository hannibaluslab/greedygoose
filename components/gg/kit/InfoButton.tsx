import { InfoIcon } from "./icons";

/** The ⓘ: opens what explains the thing beside it ("My credit"'s status, Adrian 2026-10-21). 24px, its tap 32px. */
export function InfoButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="-m-1 flex size-6 items-center justify-center text-subtle after:absolute after:-inset-1 after:content-[''] relative"
    >
      <InfoIcon />
    </button>
  );
}
