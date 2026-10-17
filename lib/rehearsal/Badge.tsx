/** Always on screen during a rehearsal, so the fork is never mistaken for Base: fake money, a local signer. */
export function RehearsalBadge() {
  return (
    <div
      role="status"
      aria-label="Rehearsal on a local fork of Base. Fake money."
      className="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+2px)] z-[100] -translate-x-1/2 whitespace-nowrap rounded-full bg-act px-2 py-[2px] font-mono text-[9px] font-semibold uppercase tracking-[0.06em] text-white"
    >
      Rehearsal · local fork · fake money
    </div>
  );
}
