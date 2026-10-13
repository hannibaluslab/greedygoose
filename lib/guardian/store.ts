/**
 * What the app needs to rebuild a user's Guardian permission (for status + revoke): cap, start, end.
 * Kept per account in browser storage; if it's lost, Guardian keeps running (it's on-chain) and can be
 * found again from the manager's PermissionApproved events. Every access is guarded.
 */
export type GuardianRecord = { capRaw: string; start: number; end: number };

const key = (a: string) => `gg.guardian.v1.${a.toLowerCase()}`;
const listeners = new Set<() => void>();

export function readGuardian(account: string): GuardianRecord | null {
  try {
    const raw = localStorage.getItem(key(account));
    return raw ? (JSON.parse(raw) as GuardianRecord) : null;
  } catch {
    return null;
  }
}
export function writeGuardian(account: string, rec: GuardianRecord | null) {
  try {
    if (rec) localStorage.setItem(key(account), JSON.stringify(rec));
    else localStorage.removeItem(key(account));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}
export function subscribeGuardian(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
