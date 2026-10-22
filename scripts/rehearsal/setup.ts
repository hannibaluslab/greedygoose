/**
 * Sets up a rehearsal on the local fork (scripts/rehearsal/README.md, "Setup"). Fake money only; nothing leaves anvil.
 *
 *   1. Stand-in stocks: each of the seven B20 stocks gets RehearsalStock's code at its own address, with the balances
 *      the Aave hub and every stock/USDC pool (Aerodrome and Uniswap, each tick spacing and fee tier) hold on Base at
 *      the fork block, and its real uiMultiplier. B20 code is native to Base (0xef), so anvil can't run the real ones.
 *      A pool with nothing in range at its price, or under $100 of either side, is closed on the fork (closePool):
 *      a quote on it would walk every empty tick, thousands of reads from Base, and it can't fill a trade anyway.
 *   2. Two fresh JAW accounts from JAW's real factory, with the owners JAW's SDK gives every account: the user's signer
 *      (an anvil dev account stands in for the passkey) and the permission manager.
 *   3. Fake money, by setting balance storage (anvil_dealERC20): sam gets cash ($3 in the wallet, the rest in Aave V3
 *      savings) and credit backed by NVIDIA; ana gets $100 of USDC and $10 of USDT for Receive's convert.
 *   4. GooseGuard (contracts/src/GooseGuard.sol), owned by an anvil dev account, with a second dev account as its one
 *      runner (KeeperHub's place) and JAW's account clone as the code it accepts; the floors at the spec's defaults. No
 *      amount limit anywhere (decision 9). GoosePlanner isn't built yet: run-agents needs it.
 *   5. A warm-up: the app's own quote on every stock pool, both ways, so anvil has fetched those pools from Base
 *      before the app asks (a first read of anything on a fork is slow).
 *   6. .rehearsal/state.json for the other scripts, and .env.rehearsal.local for the app (both gitignored).
 *
 *   npm run rehearsal:setup
 *   REHEARSAL_SAM_SAVINGS=500 REHEARSAL_SAM_CREDIT=0 npm run rehearsal:setup   # amounts in dollars, shares for NVDA
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  parseUnits,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { AAVE } from "@/lib/aave/addresses";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { aaveV3PoolAbi, justanAccountAbi } from "@/lib/protocols/abis";
import { PROTOCOLS } from "@/lib/protocols/config";
import { quotePool } from "@/lib/swap/buy";
import { AERODROME, UNISWAP, type Venue } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import {
  ENV_FILE,
  ROOT,
  connectFork,
  health,
  shares,
  usd,
  writeState,
  type Call,
  type Fork,
  type Name,
  type State,
} from "./lib";

/** JAW's account factory on Base (contracts/test/ForkBase.sol, the SDK's FACTORY_ADDRESS). */
const JAW_FACTORY: Address = "0x5803c076563C85799989d42Fc00292A8aE52fa9E";
const MANAGER = PROTOCOLS.PERMISSION_MANAGER as Address;
const NVDA = EQUITIES.find((e) => e.symbol === "NVDAc")!;
const USDT = ENTRY_COINS.find((c) => c.symbol === "USDT")!;

const factoryAbi = parseAbi(["function createAccount(bytes[] owners, uint256 nonce) payable returns (address)"]);
const aeroFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
]);
const uniFactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
const uiMultiplierAbi = parseAbi(["function uiMultiplier() view returns (uint256)"]);
const poolLiquidityAbi = parseAbi(["function liquidity() view returns (uint128)"]);

/** RehearsalStock's storage (contracts/script/rehearsal/RehearsalStock.sol). */
const STOCK_SLOT = BigInt(keccak256(stringToHex("greedygoose.rehearsal.stock")));
const balanceSlot = (holder: Address) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, STOCK_SLOT]));
const UI_MULTIPLIER_SLOT = pad(toHex(STOCK_SLOT + 2n), { size: 32 });
const word = (v: bigint) => pad(toHex(v), { size: 32 });

const dollars = (name: string, fallback: number) =>
  parseUnits(String(Number(process.env[name] ?? fallback)), USDC.decimals);
const AMOUNTS = {
  samWallet: dollars("REHEARSAL_SAM_WALLET", 3),
  samSavings: dollars("REHEARSAL_SAM_SAVINGS", 250),
  samNvdaShares: parseUnits(String(Number(process.env.REHEARSAL_SAM_NVDA ?? 5)), NVDA.decimals),
  samCredit: dollars("REHEARSAL_SAM_CREDIT", 400),
  anaWallet: dollars("REHEARSAL_ANA_WALLET", 100),
  anaUsdt: parseUnits(String(Number(process.env.REHEARSAL_ANA_USDT ?? 10)), USDT.decimals),
};

function artifact(contract: string): Hex {
  const path = join(ROOT, "contracts", "out", `${contract}.sol`, `${contract}.json`);
  return (JSON.parse(readFileSync(path, "utf8")) as { deployedBytecode: { object: Hex } }).deployedBytecode.object;
}

const FORGE_ENV = { ...process.env, PATH: `${process.env.PATH}:${process.env.HOME}/.foundry/bin` };

function forge(args: string[]) {
  const r = spawnSync("forge", args, { cwd: join(ROOT, "contracts"), env: FORGE_ENV, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`forge ${args[0]} failed`);
}

/** A forge command's `--json` answer. */
function forgeJson(args: string[]): unknown {
  const r = spawnSync("forge", args, { cwd: join(ROOT, "contracts"), env: FORGE_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`forge ${args[0]} failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
}

/**
 * GooseGuard's floors, in its constructor's order (spec-final-v2.md §2, step0-facts.md): sale floor 3%, swap floor
 * 0.5%, band 1%, $1 kept in the wallet, $1 of dust.
 */
const GUARD_FLOORS = { saleFloorBps: 300, swapFloorBps: 50, bandBps: 100, keepBack: 1_000_000, dust: 1_000_000 };

async function main() {
  const fork = await connectFork();
  const { pub, test, dev } = fork;
  const [owner, runner, samSigner, anaSigner] = dev;
  const info = (await pub.request({ method: "anvil_nodeInfo" } as never)) as {
    network?: string;
    forkConfig?: { forkUrl?: string; forkBlockNumber?: number };
  };
  const forkUrl = info.forkConfig?.forkUrl;
  const forkBlock = info.forkConfig?.forkBlockNumber;
  if (!forkUrl || forkBlock === undefined)
    throw new Error("anvil isn't forking Base: start it with npm run rehearsal:fork");
  // anvil's "base" family runs B20 natively and ignores the stand-ins (start-fork.sh).
  if (info.network === "base")
    throw new Error("anvil runs as its base network family: start it with npm run rehearsal:fork (--network optimism)");
  // Base itself, read only: the stand-ins copy what the hub and the pools hold there at the fork block.
  const upstream = createPublicClient({ chain: base, transport: http(forkUrl) });
  if ((await upstream.getChainId()) !== base.id) throw new Error(`${forkUrl} isn't Base`);
  console.log(`Fork of Base at block ${forkBlock} on ${fork.rpc}\n`);

  forge(["build", "--no-lint"]);

  console.log("\n1. Stand-in stocks (B20 code can't run on anvil)");
  const stockCode = artifact("RehearsalStock");
  const pools: { stock: (typeof EQUITIES)[number]; venue: Venue; id: number; address: Address; label: string }[] = [];
  for (const e of EQUITIES) {
    const holders: { label: string; address: Address }[] = [{ label: "Aave hub", address: AAVE.HUB as Address }];
    for (const ts of AERODROME.TICK_SPACINGS) {
      const pool = await pub.readContract({
        address: AERODROME.FACTORY,
        abi: aeroFactoryAbi,
        functionName: "getPool",
        args: [e.address, USDC.address, ts],
      });
      if (pool === zeroAddress) continue;
      holders.push({ label: `Aerodrome ${ts}`, address: pool });
      pools.push({ stock: e, venue: "aerodrome", id: ts, address: pool, label: `${e.symbol} Aerodrome ${ts}` });
    }
    for (const fee of UNISWAP.FEE_TIERS) {
      const pool = await pub.readContract({
        address: UNISWAP.FACTORY,
        abi: uniFactoryAbi,
        functionName: "getPool",
        args: [e.address, USDC.address, fee],
      });
      if (pool === zeroAddress) continue;
      holders.push({ label: `Uniswap ${fee / 10_000}%`, address: pool });
      pools.push({ stock: e, venue: "uniswap", id: fee, address: pool, label: `${e.symbol} Uniswap ${fee / 10_000}%` });
    }
    const at = { blockNumber: BigInt(forkBlock) };
    const [multiplier, ...balances] = await Promise.all([
      upstream.readContract({ address: e.address, abi: uiMultiplierAbi, functionName: "uiMultiplier", ...at }),
      ...holders.map((h) =>
        upstream.readContract({
          address: e.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [h.address],
          ...at,
        }),
      ),
    ]);
    await test.setCode({ address: e.address, bytecode: stockCode });
    await test.setStorageAt({ address: e.address, index: UI_MULTIPLIER_SLOT, value: word(multiplier) });
    const running = await pub.readContract({ address: e.address, abi: uiMultiplierAbi, functionName: "uiMultiplier" });
    if (running !== multiplier) throw new Error(`${e.symbol}: the stand-in isn't running at its address`);
    for (const [i, h] of holders.entries()) {
      await test.setStorageAt({ address: e.address, index: balanceSlot(h.address), value: word(balances[i]) });
      const check = await pub.readContract({
        address: e.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [h.address],
      });
      if (check !== balances[i]) throw new Error(`${e.symbol}: ${h.label}'s balance didn't take`);
    }
    console.log(`   ${e.symbol}: ${holders.map((h, i) => `${h.label} ${shares(balances[i])}`).join(" · ")}`);
  }

  console.log("\n   Dry pools (no liquidity at their price, or under $100 of either side), closed on the fork:");
  const open = [];
  for (const p of pools) {
    if (await isDry(fork, p.stock, p.address)) {
      await closePool(fork, p.address, p.label);
      console.log(`   ${p.label}: closed`);
    } else open.push(p);
  }

  console.log("\n2. Two fresh JAW accounts from JAW's factory, owned by [signer, permission manager]");
  const accounts = {} as State["accounts"];
  for (const [name, signer] of [
    ["sam", samSigner],
    ["ana", anaSigner],
  ] as [Name, Address][]) {
    accounts[name] = { address: await newJawAccount(fork, owner, signer, forkBlock, name), signer };
    console.log(`   ${name}: ${accounts[name].address} (signer ${signer}, an anvil dev account)`);
  }

  console.log("\n3. Fake money");
  const sam = accounts.sam.address;
  await deal(fork, USDC.address, sam, AMOUNTS.samWallet + AMOUNTS.samSavings);
  const toSavings = (amount: bigint, who: Address): Call[] => [
    {
      target: USDC.address,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PROTOCOLS.AAVE_V3_POOL, amount] }),
    },
    {
      target: PROTOCOLS.AAVE_V3_POOL,
      value: 0n,
      data: encodeFunctionData({ abi: aaveV3PoolAbi, functionName: "supply", args: [USDC.address, amount, who, 0] }),
    },
  ];
  if (AMOUNTS.samSavings > 0n)
    await fork.batch(accounts.sam.signer, sam, toSavings(AMOUNTS.samSavings, sam), "sam's savings");
  if (AMOUNTS.samNvdaShares > 0n) {
    await test.setStorageAt({ address: NVDA.address, index: balanceSlot(sam), value: word(AMOUNTS.samNvdaShares) });
    const r = BigInt(NVDA.reserveId);
    const credit: Call[] = [
      {
        target: NVDA.address,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AAVE.SPOKE, AMOUNTS.samNvdaShares] }),
      },
      {
        target: AAVE.SPOKE,
        value: 0n,
        data: encodeFunctionData({ abi: spokeAbi, functionName: "supply", args: [r, AMOUNTS.samNvdaShares, sam] }),
      },
      {
        target: AAVE.SPOKE,
        value: 0n,
        data: encodeFunctionData({ abi: spokeAbi, functionName: "setUsingAsCollateral", args: [r, true, sam] }),
      },
    ];
    // What the credit draws goes into savings too, so the wallet keeps only its few dollars.
    if (AMOUNTS.samCredit > 0n) {
      credit.push(
        {
          target: AAVE.SPOKE,
          value: 0n,
          data: encodeFunctionData({
            abi: spokeAbi,
            functionName: "borrow",
            args: [BigInt(USDC.reserveId), AMOUNTS.samCredit, sam],
          }),
        },
        ...toSavings(AMOUNTS.samCredit, sam),
      );
    }
    await fork.batch(accounts.sam.signer, sam, credit, "sam's credit");
  }
  const ana = accounts.ana.address;
  await deal(fork, USDC.address, ana, AMOUNTS.anaWallet);
  await deal(fork, USDT.address, ana, AMOUNTS.anaUsdt);
  for (const name of ["sam", "ana"] as Name[]) await printAccount(fork, name, accounts[name].address);

  console.log("\n4. GooseGuard and its runner");
  // JAW's account clone, as the factory just deployed it for sam: the code the Guard lets register.
  const cloneCodehash = keccak256((await pub.getCode({ address: accounts.sam.address }))!);
  const created = forgeJson([
    "create",
    "src/GooseGuard.sol:GooseGuard",
    "--rpc-url",
    fork.rpc,
    "--unlocked",
    "--from",
    owner,
    "--broadcast",
    "--json",
    "--constructor-args",
    owner,
    runner,
    cloneCodehash,
    ...Object.values(GUARD_FLOORS).map(String),
  ]) as { deployedTo?: Address; transactionHash?: Hex };
  if (!created.deployedTo || !created.transactionHash) throw new Error("forge create gave no GooseGuard");
  const guard = getAddress(created.deployedTo);
  const guardBlock = Number((await pub.getTransactionReceipt({ hash: created.transactionHash })).blockNumber);
  const [isRunner, codeOk] = await Promise.all([
    pub.readContract({ address: guard, abi: guardAbi, functionName: "isRunner", args: [runner] }),
    pub.readContract({ address: guard, abi: guardAbi, functionName: "codehashOk", args: [cloneCodehash] }),
  ]);
  if (!isRunner) throw new Error("the constructor didn't set the runner");
  if (!codeOk) throw new Error("the Guard doesn't accept JAW's account code");
  console.log(`   GooseGuard ${guard} (block ${guardBlock}), no amount limit`);
  console.log(`   owner ${owner}, runner ${runner} (anvil dev accounts)`);
  console.log("   GoosePlanner: not built yet, so run-agents can't plan a round until it is deployed here");

  console.log("\n5. Warming the fork: the app's quote on every open stock pool, both ways");
  // anvil reads Base's state the first time it is touched, so the first quote on a pool is slow (seconds). The app
  // quotes every pool for a buy or a sale; doing it here once keeps the screens quick.
  const slow = createPublicClient({ chain: base, transport: http(fork.rpc, { timeout: 600_000 }) });
  const started = Date.now();
  const warmed = await Promise.allSettled(
    open.flatMap(({ stock, venue, id }) => [
      quotePool(slow, stock, venue, id, parseUnits("5", USDC.decimals), "buy"),
      quotePool(slow, stock, venue, id, parseUnits("0.01", stock.decimals), "sell"),
    ]),
  );
  console.log(
    `   ${warmed.filter((w) => w.status === "fulfilled").length} of ${warmed.length} quotes answer, in ${Math.round((Date.now() - started) / 1000)} s`,
  );

  const state: State = {
    rpc: fork.rpc,
    forkUrl,
    forkBlock,
    fromBlock: forkBlock + 1,
    owner,
    runner,
    guard,
    guardBlock,
    accounts,
    feeds: {},
  };
  writeState(state);
  writeEnv(state, "sam");
  console.log(`\n6. Wrote .rehearsal/state.json and .env.rehearsal.local (signs in as sam)`);
  console.log("\nNext: npm run rehearsal:dev, then open http://localhost:3100 and sign in.");
}

/** A fresh JAW account from JAW's real factory, owned by `signer` and the manager. The nonce is the fork's own, so
 * every fork gets accounts no one has used, here or on Base. */
async function newJawAccount(
  fork: Fork,
  from: Address,
  signer: Address,
  forkBlock: number,
  name: string,
): Promise<Address> {
  const owners = [signer, MANAGER].map((a) => encodeAbiParameters([{ type: "address" }], [a]));
  for (let i = 0n; ; i++) {
    const nonce = BigInt(keccak256(stringToHex(`greedygoose.rehearsal.${name}.${forkBlock}`))) + i;
    const { result } = await fork.pub.simulateContract({
      address: JAW_FACTORY,
      abi: factoryAbi,
      functionName: "createAccount",
      args: [owners, nonce],
      account: from,
    });
    if ((await fork.pub.getCode({ address: result }))?.length) continue; // taken
    await fork.send(
      from,
      JAW_FACTORY,
      encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [owners, nonce] }),
      `${name}'s account`,
    );
    for (const owner of [signer, MANAGER]) {
      const owns = await fork.pub.readContract({
        address: result,
        abi: justanAccountAbi,
        functionName: "isOwnerAddress",
        args: [owner],
      });
      if (!owns) throw new Error(`${name}'s account isn't owned by ${owner}`);
    }
    return getAddress(result);
  }
}

/** A pool a rehearsal-sized trade can't use: nothing in range at its price, or under $100 of the stock or of USDC. */
async function isDry(fork: Fork, stock: (typeof EQUITIES)[number], pool: Address): Promise<boolean> {
  const read = (token: Address) =>
    fork.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [pool] });
  const [liquidity, usdc, held, price] = await Promise.all([
    fork.pub.readContract({ address: pool, abi: poolLiquidityAbi, functionName: "liquidity" }),
    read(USDC.address),
    read(stock.address),
    fork.pub.readContract({
      address: AAVE.SPOKE_ORACLE,
      abi: aaveOracleAbi,
      functionName: "getReservePrice",
      args: [BigInt(stock.reserveId)],
    }),
  ]);
  const stockUsd = (held * price) / 10n ** BigInt(stock.decimals + 2); // shares × 8-decimal price → USDC units
  return liquidity === 0n || usdc < 100_000_000n || stockUsd < 100_000_000n;
}

/**
 * Closes a dry pool on the fork: its slot0 `unlocked` flag goes to false, so a swap or a quote on it reverts at once.
 * Otherwise a quote walks every empty tick to the price limit, thousands of storage words anvil fetches from Base one
 * at a time (on Base itself the same quote answers in milliseconds and loses to the deep pool). The app quotes every
 * pool and already ignores one that fails. Uniswap v3 and Aerodrome Slipstream pack slot0 differently, so the word is
 * found by its sqrtPriceX96 and the flag's byte checked through the pool's own slot0().
 */
async function closePool(fork: Fork, pool: Address, label: string) {
  const slot0 = async () => {
    const data = (await fork.pub.call({ to: pool, data: "0x3850c7bd" })).data!; // slot0()
    const words = (data.slice(2).match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));
    return { sqrtPrice: words[0], unlocked: words.at(-1), words };
  };
  const before = await slot0();
  if (before.unlocked !== 1n) throw new Error(`${label}: slot0 isn't unlocked to begin with`);
  for (let i = 0n; i < 64n; i++) {
    const index = pad(toHex(i), { size: 32 });
    const value = BigInt((await fork.pub.getStorageAt({ address: pool, slot: index })) ?? "0x0");
    if ((value & ((1n << 160n) - 1n)) !== before.sqrtPrice) continue;
    for (const bit of [240n, 232n]) {
      if (((value >> bit) & 0xffn) !== 1n) continue;
      await fork.test.setStorageAt({ address: pool, index, value: word(value & ~(0xffn << bit)) });
      const after = await slot0();
      if (after.unlocked === 0n && after.words.slice(0, -1).every((w, k) => w === before.words[k])) return;
      await fork.test.setStorageAt({ address: pool, index, value: word(value) });
    }
  }
  throw new Error(`${label}: couldn't find slot0's unlocked flag`);
}

/** Fake tokens by setting the holder's balance storage (anvil finds the slot). */
async function deal(fork: Fork, token: Address, to: Address, amount: bigint) {
  await fork.test.request({ method: "anvil_dealERC20", params: [to, token, toHex(amount)] } as never);
  const now = await fork.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  if (now !== amount) throw new Error(`dealing ${token} to ${to} didn't take`);
}

async function printAccount(fork: Fork, name: string, account: Address) {
  const read = (token: Address) =>
    fork.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  const [wallet, savings, usdt, data] = await Promise.all([
    read(USDC.address),
    read(PROTOCOLS.AUSDC as Address),
    read(USDT.address),
    fork.pub.readContract({ address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserAccountData", args: [account] }),
  ]);
  const owed = await fork.pub.readContract({
    address: AAVE.SPOKE,
    abi: spokeAbi,
    functionName: "getUserTotalDebt",
    args: [BigInt(USDC.reserveId), account],
  });
  console.log(
    `   ${name}: wallet ${usd(wallet)} · savings ${usd(savings)}${usdt ? ` · USDT ${usd(usdt)}` : ""}` +
      (owed > 0n ? ` · owes ${usd(owed)} · health ${health(data.healthFactor)}` : ""),
  );
}

function writeEnv(state: State, as: Name) {
  const lines = [
    "# Written by scripts/rehearsal/setup.ts: the app on a local anvil fork of Base, fake money. Never production.",
    "# npm run rehearsal:dev loads it; next dev doesn't read this file on its own.",
    `NEXT_PUBLIC_REHEARSAL_RPC=${state.rpc}`,
    `NEXT_PUBLIC_REHEARSAL_FROM_BLOCK=${state.fromBlock}`,
    `NEXT_PUBLIC_REHEARSAL_ACCOUNT=${state.accounts[as].address}`,
    `NEXT_PUBLIC_REHEARSAL_SIGNER=${state.accounts[as].signer}`,
    `NEXT_PUBLIC_GOOSE_GUARD=${state.guard}`,
    `NEXT_PUBLIC_GOOSE_GUARD_BLOCK=${state.guardBlock}`,
    ...(state.planner ? [`NEXT_PUBLIC_GOOSE_PLANNER=${state.planner}`] : []),
    "",
  ];
  writeFileSync(ENV_FILE, lines.join("\n"));
}

main().catch((e) => {
  console.error(`\nsetup failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
