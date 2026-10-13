/**
 * Guardian keeper — the one small backend GreedyGoose runs (decision D8).
 *
 *   GUARDIAN_KEEPER_KEY=0x…        spender key (only ever used for JustaPermissionManager.executeBatch)
 *   NEXT_PUBLIC_GUARDIAN_CHECKER=0x… deployed GuardianChecker
 *   BASE_RPC_URL=https://…          an RPC that serves eth_getLogs over ranges (public Base RPCs often don't)
 *   GUARDIAN_FROM_BLOCK=…           block the checker was deployed at
 *
 *   npx tsx keeper/run.ts            dry run: plan + simulate, send nothing
 *   npx tsx keeper/run.ts --execute  send rescues
 *   npx tsx keeper/run.ts --loop     keep running (every GUARDIAN_INTERVAL_SEC, default 60)
 *
 * State (scan cursor + known permissions) is kept in keeper/.state.json; the chain is the source of truth,
 * so deleting it only means a rescan.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { checkAccount, discoverPermissions } from "@/lib/guardian/keeper";
import type { GuardianPermission } from "@/lib/guardian/permission";

const STATE = new URL("./.state.json", import.meta.url);
type State = { cursor: string; perms: (Omit<GuardianPermission, "salt" | "spends"> & { salt: string; spends: (Omit<GuardianPermission["spends"][number], "allowance"> & { allowance: string })[] })[] };

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
};

function load(): State | null {
  try {
    return JSON.parse(readFileSync(STATE, "utf8")) as State;
  } catch {
    return null;
  }
}
const revive = (s: State["perms"][number]): GuardianPermission => ({ ...s, salt: BigInt(s.salt), spends: s.spends.map((x) => ({ ...x, allowance: BigInt(x.allowance) })) });
const freeze = (p: GuardianPermission): State["perms"][number] => ({ ...p, salt: p.salt.toString(), spends: p.spends.map((x) => ({ ...x, allowance: x.allowance.toString() })) });

async function tick(execute: boolean) {
  const rpc = env("BASE_RPC_URL");
  const checker = env("NEXT_PUBLIC_GUARDIAN_CHECKER") as Address;
  if (!isAddress(checker)) throw new Error("Bad NEXT_PUBLIC_GUARDIAN_CHECKER");
  const keeperAccount = privateKeyToAccount(env("GUARDIAN_KEEPER_KEY") as `0x${string}`);
  const client = createPublicClient({ chain: base, transport: http(rpc) });
  const wallet = createWalletClient({ chain: base, transport: http(rpc), account: keeperAccount });

  const state = load() ?? { cursor: env("GUARDIAN_FROM_BLOCK"), perms: [] };
  const head = await client.getBlockNumber();
  const fresh = await discoverPermissions(client, { keeper: keeperAccount.address, checker, fromBlock: BigInt(state.cursor), toBlock: head });
  const perms = [...state.perms.map(revive), ...fresh];
  writeFileSync(STATE, JSON.stringify({ cursor: (head + 1n).toString(), perms: perms.map(freeze) }, null, 2));

  console.log(`[guardian] block ${head} · watching ${perms.length} account(s) · ${execute ? "EXECUTE" : "dry run"}`);
  for (const p of perms) {
    const r = await checkAccount(client, execute ? wallet : null, p, { dryRun: !execute });
    console.log(`[guardian] ${p.account} → ${JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
}

const execute = process.argv.includes("--execute");
if (process.argv.includes("--loop")) {
  const every = Number(process.env.GUARDIAN_INTERVAL_SEC ?? 60) * 1000;
  for (;;) {
    await tick(execute).catch((e) => console.error("[guardian] tick failed:", e instanceof Error ? e.message : e));
    await new Promise((r) => setTimeout(r, every));
  }
} else {
  await tick(execute);
}
