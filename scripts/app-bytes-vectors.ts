/**
 * The app's own one-tap grant batch, as bytes, for contracts/test/GooseGuardAppBytesFork.t.sol (Mariano's review,
 * GG-13): the five agents' permissions built by lib/agents/permissions.ts (`jobGrant`) and lib/agents/oneTapGrant.ts
 * (`jawPermission`), the way hooks/useAgents.ts builds them, then the batch `oneTapGrantCalls` returns for them. The fork
 * test sends exactly these calls, so it registers the app's bytes, not a Solidity copy of them.
 *
 *   npm run contracts:vectors   # rewrites contracts/test/vectors/app-bytes.json with the other vector files
 *
 * tests/unit/app-bytes-vectors.test.ts fails while the committed file is stale.
 *
 * What the app picks at grant time is fixed here so the file is stable: the account (the fork test's passkey account,
 * which the test checks), the Guard's address (the test deploys GooseGuard there), the start (the fork block's time less
 * the 300 s lib/agents/picks.ts sets it back) and one salt per job in place of the 256 random bits.
 */
import { writeFileSync } from "node:fs";
import { keccak256, toHex, type Address, type Hex } from "viem";

/** Where the fork test deploys GooseGuard. The app reads it from NEXT_PUBLIC_GOOSE_GUARD. */
const APP_BYTES_GUARD: Address = "0x00000000000000000000000000000000000e5ec0";
/** The fork test's passkey account: JAW's factory address for [the test passkey, the manager], index 0. */
const APP_BYTES_ACCOUNT: Address = "0x18dF202F69CBb870B444BBA41F0d35339d7Da20B";
/** Base block 52,946,000's timestamp: the block every Guard fork test pins by default (GUARD_FORK_BLOCK). */
const FORK_BLOCK_TIME = 1_792_681_347;
/** lib/agents/picks.ts START_BEHIND_SEC: a new grant starts this far behind the chain head. */
const START_BEHIND_SEC = 300;

/** The vectors, built by the app's own modules once NEXT_PUBLIC_GOOSE_GUARD names the test's Guard. */
export async function appBytesVectors() {
  process.env.NEXT_PUBLIC_GOOSE_GUARD = APP_BYTES_GUARD;
  const { GRANT_SECONDS, JOBS, jobGrant, stockLimitsRaw } = await import("@/lib/agents/permissions");
  const { contractPermission, jawPermission, oneTapGrantCalls } = await import("@/lib/agents/oneTapGrant");
  const { encodePermission } = await import("@/lib/agents/register");
  const { EQUITIES } = await import("@/lib/tokens/registry");

  // As the fork test grants them: Protect · sell and the Rebalancer may sell every stock.
  const allStocks = stockLimitsRaw(EQUITIES.map(() => true));
  const start = FORK_BLOCK_TIME - START_BEHIND_SEC;
  const grants = JOBS.map((job) => {
    const pick = { start, salt: BigInt(keccak256(toHex(`GreedyGoose app bytes: ${job}`))) };
    const detail = jobGrant(job, job === "sell" || job === "rebalance" ? allStocks : undefined);
    return jawPermission(APP_BYTES_ACCOUNT, APP_BYTES_GUARD, pick.start + GRANT_SECONDS, detail, pick);
  });

  // A new account has no owner call (JAW's factory makes the manager an owner); a deployed JAW passkey account
  // doesn't need one either (managerOwnerCalls), so both of the test's cases send this same batch.
  const batch = oneTapGrantCalls(APP_BYTES_ACCOUNT, grants);
  const n = JOBS.length;
  if (batch.length !== 2 * n) throw new Error("The one-tap batch isn't one approve and one register per agent");
  // Each agent's pair on its own is the same two calls: approve i, then register i.
  grants.forEach((p, i) => {
    const pair = oneTapGrantCalls(APP_BYTES_ACCOUNT, [p]);
    if (pair[0].data !== batch[i].data || pair[1].data !== batch[n + i].data) {
      throw new Error(`${JOBS[i]}'s pair isn't calls ${i} and ${n + i} of the batch`);
    }
  });
  if (batch.some((c) => c.value !== 0n)) throw new Error("A grant call carries ETH");

  return {
    account: APP_BYTES_ACCOUNT,
    guard: APP_BYTES_GUARD,
    start,
    /** abi.encode(permission) per job, in GooseGuard's job order: what `permissionOf` must return. */
    permissions: grants.map((p): Hex => encodePermission(contractPermission(p))),
    /** The batch the account runs: each approve in JAW's manager, then each `register(job, permission)`. */
    to: batch.map((c) => c.to),
    data: batch.map((c) => c.data),
  };
}

async function main() {
  const data = await appBytesVectors();
  writeFileSync(new URL("../contracts/test/vectors/app-bytes.json", import.meta.url), JSON.stringify(data) + "\n");
}

if (process.argv[1]?.endsWith("app-bytes-vectors.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
