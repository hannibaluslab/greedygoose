/**
 * The dress rehearsal's on-switch (scripts/rehearsal/README.md): the app talks to a local anvil fork of Base with fake
 * money, and a fork signer stands in for JAW. It is on only when both hold:
 *
 * - `NEXT_PUBLIC_REHEARSAL_RPC` is set, to a local node (localhost, 127.0.0.1 or [::1]): a remote URL throws, so a
 *   typo can never point the fork signer at a real chain;
 * - `NODE_ENV` isn't "production": `next build` and `next start` always run as production, so a production build
 *   can't switch it on, whatever its environment says.
 *
 * `lib/jaw/config.ts` checks the same two values inline before it loads the signer, so the bundler drops the signer
 * from a production build (`npm run rehearsal:check-build` proves it).
 */
export type RehearsalEnv = { NODE_ENV?: string; NEXT_PUBLIC_REHEARSAL_RPC?: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The fork's RPC URL when the rehearsal is on, otherwise undefined. Throws on a non-local URL. */
export function rehearsalRpcFrom(env: RehearsalEnv): string | undefined {
  if (env.NODE_ENV === "production") return undefined;
  const raw = env.NEXT_PUBLIC_REHEARSAL_RPC?.trim();
  if (!raw) return undefined;
  if (!isLocalRpc(raw)) {
    throw new Error(`NEXT_PUBLIC_REHEARSAL_RPC must be a local anvil fork (http://127.0.0.1:<port>), not ${raw}`);
  }
  return raw;
}

/** True for an http(s) URL on this machine. */
export function isLocalRpc(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}
