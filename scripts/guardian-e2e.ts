/**
 * Guardian end-to-end rehearsal on a local Base mainnet fork (anvil). Nothing touches mainnet.
 *
 *   1. fork Base, deploy GuardianChecker
 *   2. take a real JAW account (manager already an owner), put USDC into Aave V3 savings,
 *      borrow on the Equities Hub until the loan is in Watch
 *   3. the account approves the Guardian permission (as the app would via wallet_sendCalls)
 *   4. run the real keeper code: discover → plan → simulate → execute
 *   5. assert the loan is back to Safe, savings paid for it, and nothing else moved
 *
 *   npx tsx scripts/guardian-e2e.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { summarize, type AccountData } from "@/lib/aave/math";
import { USDC } from "@/lib/tokens/registry";
import { GUARDIAN } from "@/lib/guardian/config";
import { permissionManagerAbi } from "@/lib/guardian/abis";
import { buildAddSavingsCalls, buildGuardianPermission, toTuple } from "@/lib/guardian/permission";
import { checkAccount, discoverPermissions } from "@/lib/guardian/keeper";

const FORK_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const USER: Address = "0x14087c532332dE6E971Eb2F60a252cbf511F59eA";
// anvil's default dev keys (public, fork-only)
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const KEEPER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

async function main() {
  // Local anvil if it runs on this host; otherwise Foundry's official container (e.g. older glibc).
  const native = spawnSync("anvil", ["--version"]).status === 0;
  const anvilArgs = ["--fork-url", FORK_RPC, "--port", String(PORT), "--host", "127.0.0.1", "--silent"];
  const anvil = native
    ? spawn("anvil", anvilArgs, { stdio: "inherit" })
    : spawn("podman", ["run", "--rm", "--name", "gg-anvil", "--network", "host", "--entrypoint", "anvil", "ghcr.io/foundry-rs/foundry:latest", ...anvilArgs], { stdio: "inherit" });
  console.log(`anvil: ${native ? "local" : "container"}`);
  try {
    const client = createPublicClient({ chain: base, transport: http(RPC) });
    for (let i = 0; ; i++) {
      try {
        await client.getBlockNumber();
        break;
      } catch {
        if (i > 60) throw new Error("anvil did not start");
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const test = createTestClient({ chain: base, transport: http(RPC), mode: "anvil" });
    const deployer = createWalletClient({ chain: base, transport: http(RPC), account: DEPLOYER });
    const userWallet = createWalletClient({ chain: base, transport: http(RPC), account: USER });
    const keeperWallet = createWalletClient({ chain: base, transport: http(RPC), account: KEEPER });
    const forkBlock = await client.getBlockNumber();
    console.log(`fork @ ${forkBlock}`);

    // 1. deploy the checker
    const art = JSON.parse(readFileSync("contracts/out/GuardianChecker.sol/GuardianChecker.json", "utf8"));
    const hash = await deployer.deployContract({
      abi: art.abi,
      bytecode: art.bytecode.object,
      args: [USDC.address, GUARDIAN.AAVE_V3_POOL, AAVE.SPOKE, BigInt(USDC.reserveId)],
    });
    const checker = (await client.waitForTransactionReceipt({ hash })).contractAddress!;
    console.log(`checker ${checker}`);

    // 2. user: savings + loan into Watch
    await test.impersonateAccount({ address: USER });
    await test.setBalance({ address: USER, value: parseEther("1") });
    const send = async (to: Address, data: `0x${string}`) => {
      const h = await userWallet.sendTransaction({ to, data, account: USER, chain: base });
      const r = await client.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error(`user tx reverted: ${to}`);
    };
    const usdcBal = await client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [USER] });
    const savings = usdcBal > 3_000_000n ? 3_000_000n : (usdcBal * 9n) / 10n;
    ok(savings > 0n, `user has USDC to save (${Number(savings) / 1e6})`);
    for (const c of buildAddSavingsCalls(USER, savings)) await send(c.to, c.data);

    const read = async () => summarize((await client.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [USER] })) as AccountData);
    const before = await read();
    const power = before.collateralUsd * before.avgCf;
    const targetDebt = power / 1.2; // HF 1.2 → Watch
    const borrowUsd = Math.max(0, targetDebt - before.debtUsd);
    await send(AAVE.SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "borrow", args: [7n, BigInt(Math.floor(borrowUsd * 1e6)), USER] }));
    const watch = await read();
    ok(watch.healthFactor !== null && watch.healthFactor < 1.5, `loan is in Watch (HF ${watch.healthFactor?.toFixed(3)})`);

    // 3. approve the Guardian permission (same calldata the app sends)
    const now = Number((await client.getBlock()).timestamp);
    const perm = buildGuardianPermission({ account: USER, spender: KEEPER.address, checker, dailyCapRaw: 2_000_000n, start: now, end: now + 365 * 86400 });
    await send(GUARDIAN.PERMISSION_MANAGER, encodeFunctionData({ abi: permissionManagerAbi, functionName: "approve", args: [toTuple(perm)] }));

    // 4. the real keeper code
    const head = await client.getBlockNumber();
    const found = await discoverPermissions(client, { keeper: KEEPER.address, checker, fromBlock: forkBlock + 1n, toBlock: head });
    ok(found.length === 1 && found[0].account === USER, "keeper discovered the permission from on-chain events");

    const dry = await checkAccount(client, null, found[0], { dryRun: true });
    ok(dry.status === "would-repay", `dry run plans a repay (${JSON.stringify(dry.status)})`);

    const savingsBefore = await client.readContract({ address: GUARDIAN.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [USER] });
    const cashBefore = await client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [USER] });
    const res = await checkAccount(client, keeperWallet, found[0]);
    ok(res.status === "repaid", `keeper repaid (${res.status === "repaid" ? Number(res.amountRaw) / 1e6 : JSON.stringify(res)} USDC)`);

    // 5. outcome
    const after = await read();
    const savingsAfter = await client.readContract({ address: GUARDIAN.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [USER] });
    const cashAfter = await client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [USER] });
    ok(after.healthFactor === null || after.healthFactor >= 1.5, `loan back to Safe (HF ${after.healthFactor?.toFixed(3) ?? "no debt"})`);
    ok(savingsAfter < savingsBefore, `paid from savings (${Number(savingsBefore - savingsAfter) / 1e6} USDC)`);
    ok(cashAfter === cashBefore, "the user's cash balance didn't move");
    const allowance = await client.readContract({ address: USDC.address, abi: erc20Abi, functionName: "allowance", args: [USER, AAVE.SPOKE] });
    ok(allowance === 0n, "no leftover approval");

    const again = await checkAccount(client, keeperWallet, found[0]);
    ok(again.status === "checked", "next tick does nothing (already Safe)");

    // revoke → keeper skips
    await send(GUARDIAN.PERMISSION_MANAGER, encodeFunctionData({ abi: permissionManagerAbi, functionName: "revoke", args: [toTuple(perm)] }));
    const revoked = await checkAccount(client, keeperWallet, found[0]);
    ok(revoked.status === "skipped", "after revoke the keeper can't act");
    console.log("\nGuardian e2e: ALL PASSED");
  } finally {
    anvil.kill();
    if (!native) spawnSync("podman", ["rm", "-f", "gg-anvil"]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
