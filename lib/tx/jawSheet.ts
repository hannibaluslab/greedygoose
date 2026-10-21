/*
 * Whether JAW's own sheet is up: from the moment a batch goes to JAW until JAW answers (sent, cancelled, blocked). Our
 * sheet steps aside meanwhile (SheetShell), so only one sheet shows at a time (Adrian, 2026-10-21: "2 sheet open is
 * ugly and confusing"), and comes back as the goose page while the change confirms, or with JAW's answer. Set in the
 * one write path (lib/tx/prepared.ts submit).
 */

let open = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const jawSheet = {
  /** A batch went to JAW: its sheet is up. */
  begin() {
    open += 1;
    emit();
  },
  /** JAW answered. */
  end() {
    open = Math.max(0, open - 1);
    emit();
  },
  isUp: () => open > 0,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
