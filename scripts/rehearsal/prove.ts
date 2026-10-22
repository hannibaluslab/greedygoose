/**
 * The rehearsal's proof run (scripts/rehearsal/README.md, "Proof"): the real app on the fork, driven the way a person
 * would at 390×844, then checked on the chain.
 *
 *   1. Sign in as sam with the fork signer.
 *   2. Buy $5 of NVIDIA from cash: the buy sheet, Review, Confirm. On-chain: shares received, cash down $5, and the
 *      savings withdrawal the review announced (sam's wallet holds less than the buy).
 *   3. Switch Protect on in its sheet, selling backing stock included: one JAW grant each, on the manager, each
 *      registered with GooseGuard in the same batch.
 *   4. run-agents: a round (it needs GoosePlanner on the fork).
 *   5. With --shock: NVIDIA down on Aave's oracle puts sam under Protect's line (health about 1.02, in Act);
 *      run-agents: Protect repays from the cash, with no amount limit. The price is put back after.
 *
 * Needs the fork, setup and the app running (npm run rehearsal:fork, rehearsal:setup, rehearsal:dev).
 *
 *   npm run rehearsal:prove
 *   npm run rehearsal:prove -- --shock
 *   REHEARSAL_SHOTS=/some/dir REHEARSAL_CHROME=/path/to/chrome npm run rehearsal:prove
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { erc20Abi, getAbiItem, isAddressEqual, parseUnits, type Address } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { permissionManagerAbi } from "@/lib/protocols/abis";
import { PROTOCOLS } from "@/lib/protocols/config";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ROOT, STATE_DIR, connectFork, health, readState, shares, usd, type Fork } from "./lib";

const APP = process.env.REHEARSAL_APP ?? "http://localhost:3100";
const SHOTS = process.env.REHEARSAL_SHOTS ?? join(STATE_DIR, "shots");
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME = process.env.REHEARSAL_CHROME ?? (existsSync(MAC_CHROME) ? MAC_CHROME : undefined);
const NVDA = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const AUSDC = PROTOCOLS.AUSDC as Address;
const APPROVED = getAbiItem({ abi: permissionManagerAbi, name: "PermissionApproved" });
const PROTECT = 1;
const PROTECT_SELL = 2;

let step = 0;
const ok = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`  ✓ ${what}`);
};

async function main() {
  const shock = process.argv.includes("--shock");
  const state = readState();
  const fork = await connectFork(state.rpc);
  const sam = state.accounts.sam.address;
  mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    ...(CHROME ? { executablePath: CHROME } : { channel: "chrome" }),
  });
  const page = await (
    await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })
  ).newPage();
  const shot = async (name: string) => {
    const path = join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path });
    console.log(`  · ${path}`);
  };

  try {
    console.log("\n1. Sign in as sam");
    await page.goto(APP, { waitUntil: "networkidle", timeout: 120_000 });
    await shot("welcome");
    const attest = page.locator('input[type="checkbox"]');
    if (await attest.count()) await attest.check();
    await page.getByRole("button", { name: /Sign in with your JAW account/ }).click();
    await page.waitForURL("**/home", { timeout: 60_000 });
    await page.getByText("Cash", { exact: true }).waitFor({ timeout: 60_000 });
    await page.getByText("owed", { exact: true }).waitFor({ timeout: 60_000 });
    await page
      .getByText(new RegExp(`^${sam.slice(0, 6)}`, "i"))
      .first()
      .waitFor({ timeout: 60_000 });
    ok(true, `signed in as sam: the header shows ${sam.slice(0, 6)}…${sam.slice(-4)}`);
    await shot("home");

    console.log("\n2. Buy $5 of NVIDIA from cash");
    const before = await balances(fork, sam);
    console.log(
      `  before: wallet ${usd(before.wallet)} · savings ${usd(before.savings)} · NVIDIA ${shares(before.nvda)} free`,
    );
    await page.goto(`${APP}/buy?s=NVDAc`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.locator('input[inputmode="decimal"]').fill("5");
    const review = page.getByRole("button", { name: "Review buy" });
    await waitEnabled(page, review);
    await shot("buy-amount");
    await review.click();
    const confirm = page.getByRole("button", { name: "Confirm with Face ID" });
    await confirm.waitFor({ timeout: 60_000 });
    const text = await page.getByRole("dialog").last().innerText();
    const fromSavings = parseUnits(/\$([\d.]+) comes out of savings/.exec(text)?.[1] ?? "0", USDC.decimals);
    const atLeast = Number(/You get at least\s+([\d.]+) NVDA/.exec(text)?.[1] ?? "NaN");
    ok(
      fromSavings > 0n,
      `the review takes ${usd(fromSavings)} out of savings (the wallet holds ${usd(before.wallet)})`,
    );
    await shot("buy-review");
    await confirm.click();
    await page.getByText(/Bought [\d.]+ NVDA/).waitFor({ timeout: 120_000 });
    await shot("bought");
    const after = await balances(fork, sam);
    console.log(
      `  after:  wallet ${usd(after.wallet)} · savings ${usd(after.savings)} · NVIDIA ${shares(after.nvda)} free`,
    );
    const got = after.nvda - before.nvda;
    const gotShares = Number((got * before.multiplier) / 10n ** 18n) / 10 ** NVDA.decimals;
    ok(
      got > 0n && gotShares >= atLeast,
      `NVIDIA received: ${shares(got)} (at least ${atLeast} shares, as the review said)`,
    );
    const cashDown = before.wallet + before.savings - (after.wallet + after.savings);
    ok(
      cashDown >= 4_990_000n && cashDown <= 5_010_000n,
      `cash down ${usd(cashDown)} (savings accrue a little interest meanwhile)`,
    );
    const savingsDown = before.savings - after.savings;
    ok(
      savingsDown >= fromSavings - 10_000n && savingsDown <= fromSavings + 10_000n,
      `savings withdrawn: ${usd(savingsDown)}`,
    );
    ok(
      after.wallet === before.wallet + fromSavings - 5_000_000n,
      `wallet ${usd(before.wallet)} + ${usd(fromSavings)} − $5.00 = ${usd(after.wallet)}`,
    );
    await page.goto(`${APP}/activity`, { waitUntil: "networkidle", timeout: 120_000 });
    await page
      .getByText(/NVIDIA|NVDA/)
      .first()
      .waitFor({ timeout: 60_000 });
    await shot("activity");

    console.log("\n3. Switch Protect on, selling backing stock included");
    const grantsBefore = await grantsFor(fork, sam, state.guard, state.fromBlock);
    await page.goto(`${APP}/agents?agent=protect`, { waitUntil: "networkidle", timeout: 120_000 });
    const switchOn = page.getByRole("button", { name: "Switch on with Face ID" });
    await switchOn.waitFor({ timeout: 60_000 });
    const sell = page.getByRole("switch", { name: /Sell stock if cash isn/ });
    if ((await sell.getAttribute("aria-checked")) !== "true") await sell.click();
    await shot("protect-sheet");
    await waitEnabled(page, switchOn);
    await switchOn.click();
    await page.getByText("Protect is saved").waitFor({ timeout: 180_000 });
    await shot("protect-saved");
    const grants = (await grantsFor(fork, sam, state.guard, state.fromBlock)) - grantsBefore;
    ok(grants === 2, `two grants on JAW's manager for GooseGuard: repay from cash and sell backing stock`);
    const jobs = await jobsOf(fork, state.guard, sam);
    ok((jobs & (1 << PROTECT)) !== 0, "GooseGuard has Protect on for sam");
    ok((jobs & (1 << PROTECT_SELL)) !== 0, "GooseGuard has Protect · sell on for sam");

    console.log("\n4. run-agents");
    agents();
    await page.goto(`${APP}/agents`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.getByText("Protect", { exact: true }).first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await shot("agents");

    if (shock) {
      console.log("\n5. NVIDIA down on Aave's oracle to under Protect's line, then run-agents");
      const debtBefore = await debtOf(fork, sam);
      // NVIDIA is all that backs sam's credit, so the health moves with its price: the fall that leaves about 1.02.
      const hfBefore = await healthOf(fork, sam);
      const fall = (1.02 / (Number(hfBefore) / 1e18) - 1) * 100;
      script("price-shock.ts", "NVDAc", `${fall.toFixed(2)}%`);
      const hf = await healthOf(fork, sam);
      ok(hf < 1_030_000_000_000_000_000n, `sam under Protect's line: health ${health(hf)}`);
      await page.goto(`${APP}/home`, { waitUntil: "networkidle", timeout: 120_000 });
      await page.getByText("Act").first().waitFor({ timeout: 60_000 });
      await shot("home-act");
      agents();
      const repaid = debtBefore - (await debtOf(fork, sam));
      const hfAfter = await healthOf(fork, sam);
      // No amount limit (decision 9): one round repays from the cash, the wallet first, then savings, back to Protect's
      // target (1.12), never more than 0.01 past it.
      ok(repaid > 0n, `Protect repaid ${usd(repaid)} from the cash`);
      ok(
        hfAfter >= 1_110_000_000_000_000_000n && hfAfter <= 1_130_000_000_000_000_000n,
        `back to the target: health ${health(hfAfter)}`,
      );
      await page.goto(`${APP}/agents`, { waitUntil: "networkidle", timeout: 120_000 });
      await page
        .getByText(/Repaid/)
        .first()
        .waitFor({ timeout: 90_000 })
        .catch(() => {});
      await shot("agents-after-repay");
      script("price-shock.ts", "NVDAc", "reset");
    }
    console.log(`\nProof run passed. Screenshots in ${SHOTS}`);
  } catch (e) {
    await shot("failure").catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
}

async function waitEnabled(page: Page, button: ReturnType<Page["getByRole"]>, timeout = 90_000) {
  const until = Date.now() + timeout;
  while (!(await button.isEnabled())) {
    if (Date.now() > until) throw new Error(`"${await button.innerText()}" never became enabled`);
    await page.waitForTimeout(500);
  }
}

async function balances(fork: Fork, account: Address) {
  const read = (token: Address) =>
    fork.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  const [wallet, savings, nvda, multiplier] = await Promise.all([
    read(USDC.address),
    read(AUSDC),
    read(NVDA.address),
    fork.pub.readContract({
      address: NVDA.address,
      abi: [
        { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
      ],
      functionName: "uiMultiplier",
    }),
  ]);
  return { wallet, savings, nvda, multiplier };
}

async function healthOf(fork: Fork, account: Address) {
  const d = await fork.pub.readContract({
    address: AAVE.SPOKE,
    abi: spokeAbi,
    functionName: "getUserAccountData",
    args: [account],
  });
  return d.healthFactor;
}

function debtOf(fork: Fork, account: Address) {
  return fork.pub.readContract({
    address: AAVE.SPOKE,
    abi: spokeAbi,
    functionName: "getUserTotalDebt",
    args: [BigInt(USDC.reserveId), account],
  });
}

async function jobsOf(fork: Fork, guard: Address, account: Address) {
  const [a] = await fork.pub.readContract({
    address: guard,
    abi: guardAbi,
    functionName: "accountOf",
    args: [account],
  });
  return a.jobs;
}

/** Permissions the manager approved for `account` with GooseGuard as the spender, since the fork point. */
async function grantsFor(fork: Fork, account: Address, guard: Address, fromBlock: number) {
  const logs = await fork.pub.getLogs({
    address: PROTOCOLS.PERMISSION_MANAGER as Address,
    event: APPROVED,
    fromBlock: BigInt(fromBlock),
  });
  return logs.filter(
    (l) =>
      l.args.permission &&
      isAddressEqual(l.args.permission.account, account) &&
      isAddressEqual(l.args.permission.spender, guard),
  ).length;
}

function script(file: string, ...args: string[]) {
  const r = spawnSync("npx", ["tsx", join("scripts/rehearsal", file), ...args], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${file} failed`);
}

function agents() {
  script("run-agents.ts");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
