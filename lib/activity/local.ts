import type { ActivityItem } from "./decode";

/**
 * Per-device record of what this app sent, so a new action shows instantly while it confirms.
 * Chain data (decoded receipts) wins once it exists. Browser storage may be unavailable — every
 * access is guarded and the app works without it.
 */
export type LocalActivity = {
  id: string;
  time: number;
  items: ActivityItem[];
  hash?: `0x${string}`;
  status: "pending" | "done" | "failed";
};

const key = (address: string) => `gg.activity.v1.${address.toLowerCase()}`;
const listeners = new Set<() => void>();

export function readLocal(address: string): LocalActivity[] {
  try {
    const raw = localStorage.getItem(key(address));
    return raw ? (JSON.parse(raw) as LocalActivity[]) : [];
  } catch {
    return [];
  }
}

function write(address: string, list: LocalActivity[]) {
  try {
    localStorage.setItem(key(address), JSON.stringify(list.slice(0, 50)));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function addLocal(address: string, entry: LocalActivity) {
  write(address, [entry, ...readLocal(address).filter((e) => e.id !== entry.id)]);
}

export function updateLocal(address: string, id: string, patch: Partial<LocalActivity>) {
  write(
    address,
    readLocal(address).map((e) => (e.id === id ? { ...e, ...patch } : e)),
  );
}

export function subscribeLocal(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
