/**
 * The leaderboard end to end on a local Base mainnet fork (anvil). Nothing touches mainnet: the script refuses any RPC
 * that isn't anvil on this machine.
 *
 *   anvil --fork-url https://mainnet.base.org --port 8546
 *   BOARD_FORK_RPC=http://127.0.0.1:8546 npx tsx scripts/board-e2e.ts
 *
 *   1. deploy GooseBoard (contracts/out, `forge build` first), and put the test OracleDouble at Aave's spoke oracle at
 *      today's prices, so prices can move (anvil 1.8 runs the B20 stocks natively);
 *   2. four real JAW accounts (JAW's factory) hold money and stocks before their first move;
 *   3. first moves: anvil 1.8.5 hangs mining a swap through a stock pool (eth_call runs it fine), so the moves that land
 *      are contacts batches, built by the app's code and sent as JAW sends them (the EntryPoint calls
 *      account.executeBatch), with join() at the end, once;
 *   4. money moves after joining: a deposit, a payment between members, savings, and prices;
 *   5. the board is read with the app's own reader (readBoard) and checked against the expected percentages;
 *   6. the review's two ways to cheat it, on the fork: someone else's $5,000 swept to Sam through Uniswap's router is
 *      money Sam put in, not a gain, and $100 of credit Sam draws on Aave V3 against his savings never lifts his percent;
 *   7. last, a buy as a first move (quote → buildBuyCalls → payFromCash → withBoardJoin) is simulated from a fresh account,
 *      as useTx simulates every batch before JAW's sheet. It runs last because anvil 1.8.5 has hung mining the next batch
 *      after an eth_simulateV1 through a stock pool.
 * Leaves the fork running with the board on it, for the dev server (NEXT_PUBLIC_BASE_RPC_URL=<fork>,
 * NEXT_PUBLIC_GOOSE_BOARD=<printed address>, /leaderboard?as=<printed account>).
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = process.env.BOARD_FORK_RPC ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC))
  throw new Error(`Refusing ${RPC}: this script runs on a local anvil fork only`);
// Set before the app's modules read it: the allowlist lets join() through only for the configured board.
process.env.NEXT_PUBLIC_BASE_RPC_URL = RPC;

// anvil's first default key (public, fork-only)
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const JAW_FACTORY: Address = "0x5803c076563C85799989d42Fc00292A8aE52fa9E";
const MANAGER: Address = "0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8";
const ENTRY_POINT: Address = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
/** Morpho Blue holds a few hundred million USDC on Base: the "outside" money comes from it. */
const WHALE: Address = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const factoryAbi = parseAbi(["function createAccount(bytes[] owners, uint256 nonce) payable returns (address)"]);
const accountAbi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function executeBatch(Call[] calls)",
]);
const oracleDoubleAbi = parseAbi(["function setReservePrice(uint256 reserveId, uint256 price)"]);
/** Aerodrome Slipstream's factory (lib/swap/venues.ts): the stock pools that hand out the shares. */
const AERO_FACTORY: Address = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef";
const aeroFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
]);

/** A fork fetches Base's state as it goes: a first swap through a pool can take a few minutes. */
const RECEIPT_TIMEOUT = 15 * 60_000;

const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const artifact = (file: string, name: string) => JSON.parse(readFileSync(`contracts/out/${file}/${name}.json`, "utf8"));

async function main() {
  const client = createPublicClient({ chain: base, transport: http(RPC) });
  const test = createTestClient({ chain: base, transport: http(RPC), mode: "anvil" });
  const deployer = createWalletClient({ chain: base, transport: http(RPC), account: DEPLOYER });
  await test.request({ method: "anvil_nodeInfo" as never }).catch(() => {
    throw new Error(`${RPC} isn't anvil`);
  });
  ok((await client.getChainId()) === 8453, "a fork of Base mainnet");

  // 1. the board, and stand-ins for what a fork can't run
  const boardArt = artifact("GooseBoard.sol", "GooseBoard");
  const deployHash = await deployer.deployContract({ abi: boardArt.abi, bytecode: boardArt.bytecode.object });
  const receipt = await client.waitForTransactionReceipt({ hash: deployHash, timeout: RECEIPT_TIMEOUT });
  const board = receipt.contractAddress!;
  process.env.NEXT_PUBLIC_GOOSE_BOARD = board;
  console.log(`GooseBoard ${board} (block ${receipt.blockNumber})`);

  const { AAVE } = await import("@/lib/aave/addresses");
  const { aaveOracleAbi } = await import("@/lib/aave/abis/IAaveOracle");
  const { EQUITIES, USDC } = await import("@/lib/tokens/registry");
  const { buildAddSavingsCalls } = await import("@/lib/guardian/permission");
  const { buildBuyCalls, quoteBuy } = await import("@/lib/swap/buy");
  const { payFromCash, readCash } = await import("@/lib/cash");
  const { withBoardJoin } = await import("@/lib/board/join");
  const { gooseBoardAbi } = await import("@/lib/board/abi");
  const { readBoard } = await import("@/lib/board/read");
  const { addContactsCalls, removeContactCalls } = await import("@/lib/efp/contacts");
  const { fetchFollowing } = await import("@/lib/efp/read");

  const prices = await client.multicall({
    allowFailure: false,
    contracts: EQUITIES.map(
      (e) =>
        ({
          address: AAVE.SPOKE_ORACLE,
          abi: aaveOracleAbi,
          functionName: "getReservePrice",
          args: [BigInt(e.reserveId)],
        }) as const,
    ),
  });
  await test.setCode({
    address: AAVE.SPOKE_ORACLE,
    bytecode: artifact("OracleDouble.sol", "OracleDouble").deployedBytecode.object,
  });
  const setPrice = async (reserveId: number, price: bigint) => {
    const h = await deployer.writeContract({
      address: AAVE.SPOKE_ORACLE,
      abi: oracleDoubleAbi,
      functionName: "setReservePrice",
      args: [BigInt(reserveId), price],
    });
    await client.waitForTransactionReceipt({ hash: h, timeout: RECEIPT_TIMEOUT });
  };
  for (const e of EQUITIES) await setPrice(e.reserveId, prices[e.reserveId]);
  ok(true, "Aave's oracle stood in, at today's prices");

  // 2. JAW accounts, as JAW's SDK makes them (a signer and the permission manager as owners)
  const accounts: Record<string, Address> = {};
  for (const name of ["sam", "kit", "leo", "ana"]) {
    const owners = [pad(privateKeyToAccount(keccak256(toHex(name))).address), pad(MANAGER)];
    const { result, request } = await client.simulateContract({
      account: DEPLOYER,
      address: JAW_FACTORY,
      abi: factoryAbi,
      functionName: "createAccount",
      args: [owners, 0n],
    });
    await client.waitForTransactionReceipt({ hash: await deployer.writeContract(request), timeout: RECEIPT_TIMEOUT });
    accounts[name] = result;
  }
  const { sam, kit, leo, ana } = accounts;
  console.log(
    Object.entries(accounts)
      .map(([n, a]) => `${n} ${a}`)
      .join("\n"),
  );

  await test.impersonateAccount({ address: WHALE });
  await test.setBalance({ address: WHALE, value: parseEther("1") });
  const whale = createWalletClient({ chain: base, transport: http(RPC), account: WHALE });
  const deposit = async (to: Address, usd: number) => {
    const h = await whale.writeContract({
      address: USDC.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, BigInt(usd * 1e6)],
    });
    await client.waitForTransactionReceipt({ hash: h, timeout: RECEIPT_TIMEOUT });
  };
  // Before joining: what each starts from.
  const NVDA = EQUITIES.find((e) => e.symbol === "NVDAc")!;
  const TSLA = EQUITIES.find((e) => e.symbol === "TSLAc")!;
  // Stocks arrive from outside too: shares sent from a pool (a plain B20 transfer, which anvil mines).
  const giveShares = async (stock: Address, to: Address, raw: bigint) => {
    const from = await client.readContract({
      address: AERO_FACTORY,
      abi: aeroFactoryAbi,
      functionName: "getPool",
      args: [stock, USDC.address, 10],
    });
    await test.impersonateAccount({ address: from });
    await test.setBalance({ address: from, value: parseEther("1") });
    const pool = createWalletClient({ chain: base, transport: http(RPC), account: from });
    const h = await pool.writeContract({ address: stock, abi: erc20Abi, functionName: "transfer", args: [to, raw] });
    await client.waitForTransactionReceipt({ hash: h, timeout: RECEIPT_TIMEOUT });
  };
  await deposit(sam, 1_000);
  await giveShares(NVDA.address, sam, 4n * 10n ** 8n);
  await deposit(kit, 500);
  await giveShares(TSLA.address, kit, 2n * 10n ** 8n);
  await deposit(leo, 10);
  await deposit(ana, 2_000);

  // 3. first moves, built by the app's code, sent as JAW sends them
  await test.impersonateAccount({ address: ENTRY_POINT });
  await test.setBalance({ address: ENTRY_POINT, value: parseEther("1") });
  const entryPoint = createWalletClient({ chain: base, transport: http(RPC), account: ENTRY_POINT });
  const userOp = async (account: Address, calls: { to: Address; data: Hex; value: bigint }[]) => {
    const h = await entryPoint.writeContract({
      address: account,
      abi: accountAbi,
      functionName: "executeBatch",
      args: [calls.map((c) => ({ target: c.to, value: c.value, data: c.data }))],
    });
    const r = await client.waitForTransactionReceipt({ hash: h, timeout: RECEIPT_TIMEOUT });
    if (r.status !== "success") throw new Error(`batch reverted for ${account}`);
    return r.blockNumber;
  };
  const buy = async (who: Address, stock: (typeof EQUITIES)[number], usd: number) => {
    const quote = (await quoteBuy(client, stock, BigInt(usd * 1e6)))!;
    // The swap's deadline counts from an hour ahead: a fork can take minutes to mine a first swap.
    const nowSec = Number((await client.getBlock()).timestamp) + 3_600;
    return payFromCash(
      who,
      quote.amountIn,
      await readCash(client, who),
      buildBuyCalls({ user: who, stock, quote, nowSec }),
    );
  };
  const addContacts = async (who: Address, contacts: Address[]) =>
    addContactsCalls(who, contacts, await fetchFollowing(client, who));
  const firstMove = async (who: Address, what: string, move: { to: Address; data: Hex; value: bigint }[]) => {
    const batch = await withBoardJoin(client, who, move);
    ok(
      batch.length === move.length + 1 && batch.at(-1)!.to === board,
      `${short(who)}'s first move: ${what}, then join() (${batch.length} calls)`,
    );
    return userOp(who, batch);
  };
  await firstMove(sam, "add Kit and Ana to contacts", await addContacts(sam, [kit, ana]));
  await firstMove(kit, "add Sam to contacts", await addContacts(kit, [sam]));
  await firstMove(leo, "add Sam to contacts", await addContacts(leo, [sam]));
  await firstMove(ana, "add Kit and Sam to contacts", await addContacts(ana, [kit, sam]));
  const listed = await Promise.all(
    [sam, kit, leo, ana].map((a) =>
      client.readContract({ address: board, abi: gooseBoardAbi, functionName: "listed", args: [a] }),
    ),
  );
  ok(listed.every(Boolean), "all four are on the board, each from its first move");

  // Later moves don't join again: adding to the list Sam has now, and Remove's EFP op.
  const later = await withBoardJoin(client, sam, await addContacts(sam, [leo]));
  ok(later.length === 1 && later[0].to !== board, "a later move carries no join(): add Leo to the list Sam has");
  await userOp(sam, later);
  await userOp(sam, await withBoardJoin(client, sam, removeContactCalls(sam, ana, await fetchFollowing(client, sam))));
  const samFollows = await fetchFollowing(client, sam);
  ok(
    samFollows.addresses.length === 2 &&
      samFollows.addresses.includes(kit.toLowerCase() as Address) &&
      samFollows.addresses.includes(leo.toLowerCase() as Address),
    "Sam's contacts on Base: Kit and Leo (Ana removed on-chain)",
  );

  // What Sam and Kit hold at the end of their join blocks, read directly, for the expected percentages.
  const atJoin = async (who: Address, stock: (typeof EQUITIES)[number]) => {
    const blockNumber = await client.readContract({
      address: board,
      abi: gooseBoardAbi,
      functionName: "joinedAt",
      args: [who],
    });
    const [usdc, shares] = await Promise.all([
      client.readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [who],
        blockNumber,
      }),
      client.readContract({
        address: stock.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [who],
        blockNumber,
      }),
    ]);
    const stockUsd = (Number(shares) / 1e8) * (Number(prices[stock.reserveId]) / 1e8);
    return { worth: Number(usdc) / 1e6 + stockUsd, stockUsd };
  };
  const [sam0, kit0] = [await atJoin(sam, NVDA), await atJoin(kit, TSLA)];

  // 4. after joining: Ana deposits, Sam pays Kit, Sam saves, prices move
  await deposit(ana, 500);
  await userOp(sam, [
    {
      to: USDC.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [kit, 100_000_000n] }),
      value: 0n,
    },
  ]);
  await userOp(
    sam,
    buildAddSavingsCalls(sam, 200_000_000n).map((c) => ({ ...c, value: 0n })),
  );
  await setPrice(NVDA.reserveId, (prices[NVDA.reserveId] * 108n) / 100n);
  await setPrice(TSLA.reserveId, (prices[TSLA.reserveId] * 95n) / 100n);
  await test.mine({ blocks: 3 });

  // 5. the board, read the way the app reads it
  const { rows } = await readBoard({ state: client, logs: client, board });
  const byAccount = (a: Address) => rows.find((r) => r.account.toLowerCase() === a.toLowerCase())!;
  for (const r of rows)
    console.log(
      `  ${r.rank ?? "–"}  ${short(r.account)}  ${r.pct === null ? "Not ranked yet" : `${(r.pct * 100).toFixed(2)}%`}`,
    );
  const samPct = (0.08 * sam0.stockUsd) / sam0.worth;
  const kitPct = (-0.05 * kit0.stockUsd) / (kit0.worth + 100); // Sam's $100 is money Kit put in
  ok(
    Math.abs(byAccount(sam).pct! - samPct) < 1e-4,
    `Sam +${(samPct * 100).toFixed(2)}%: NVIDIA +8% on his shares; the payment to Kit and his savings don't count`,
  );
  ok(
    Math.abs(byAccount(kit).pct! - kitPct) < 1e-4,
    `Kit ${(kitPct * 100).toFixed(2)}%: Tesla −5%; Sam's payment isn't a gain`,
  );
  ok(Math.abs(byAccount(ana).pct!) < 1e-6, "Ana 0.00%: a deposit after joining isn't a gain");
  ok(byAccount(leo).pct === null && byAccount(leo).rank === null, "Leo isn't ranked yet: $10 put in");
  ok(byAccount(sam).rank === 1 && byAccount(ana).rank === 2 && byAccount(kit).rank === 3, "ranked Sam, Ana, Kit");

  // 6. the review's cheats
  const samGain = 0.08 * sam0.stockUsd;
  const ALT: Address = "0x00000000000000000000000000000000000a17a1";
  await test.impersonateAccount({ address: ALT });
  await test.setBalance({ address: ALT, value: parseEther("1") });
  const alt = createWalletClient({ chain: base, transport: http(RPC), account: ALT });
  await deposit(ALT, 5_000);
  const { UNISWAP } = await import("@/lib/swap/venues");
  await client.waitForTransactionReceipt({
    hash: await alt.writeContract({
      address: USDC.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [UNISWAP.SWAP_ROUTER_02, 5_000_000_000n],
    }),
    timeout: RECEIPT_TIMEOUT,
  });
  const sweep = await client.waitForTransactionReceipt({
    hash: await alt.writeContract({
      address: UNISWAP.SWAP_ROUTER_02,
      abi: parseAbi(["function sweepToken(address token, uint256 amountMinimum, address recipient) payable"]),
      functionName: "sweepToken",
      args: [USDC.address, 0n, sam],
    }),
    timeout: RECEIPT_TIMEOUT,
  });
  ok(sweep.status === "success", "someone else sweeps $5,000 to Sam through Uniswap's router");
  await test.mine({ blocks: 2 });
  const swept = (await readBoard({ state: client, logs: client, board })).rows.find(
    (r) => r.account.toLowerCase() === sam.toLowerCase(),
  )!;
  const sweptPct = samGain / (sam0.worth + 5_000);
  ok(
    Math.abs(swept.pct! - sweptPct) < 1e-4,
    `Sam ${(swept.pct! * 100).toFixed(2)}%: the $5,000 is money he put in, the gain is still NVIDIA's (${(sweptPct * 100).toFixed(2)}%)`,
  );

  const { GUARDIAN } = await import("@/lib/guardian/config");
  const v3Pool = parseAbi([
    "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  ]);
  await userOp(sam, [
    {
      to: GUARDIAN.AAVE_V3_POOL,
      data: encodeFunctionData({ abi: v3Pool, functionName: "borrow", args: [USDC.address, 100_000_000n, 2n, 0, sam] }),
      value: 0n,
    },
  ]);
  await test.mine({ blocks: 2 });
  const drawn = (await readBoard({ state: client, logs: client, board })).rows.find(
    (r) => r.account.toLowerCase() === sam.toLowerCase(),
  )!;
  const drawnPct = samGain / (sam0.worth + 5_000 + 100);
  ok(
    drawn.pct! <= swept.pct! && Math.abs(drawn.pct! - drawnPct) < 1e-4,
    `Sam ${(drawn.pct! * 100).toFixed(2)}% after drawing $100 on Aave V3 against his savings: credit spreads the gain, never lifts it`,
  );

  // 7. a first buy, simulated (last: see the top of this file)
  const [newcomer] = await (async () => {
    const owners = [pad(privateKeyToAccount(keccak256(toHex("new"))).address), pad(MANAGER)];
    const { result, request } = await client.simulateContract({
      account: DEPLOYER,
      address: JAW_FACTORY,
      abi: factoryAbi,
      functionName: "createAccount",
      args: [owners, 0n],
    });
    await client.waitForTransactionReceipt({ hash: await deployer.writeContract(request), timeout: RECEIPT_TIMEOUT });
    await deposit(result, 1_000);
    return [result];
  })();
  const buyBatch = await withBoardJoin(client, newcomer, await buy(newcomer, NVDA, 500));
  const sim = await client.simulateCalls({ account: newcomer, calls: buyBatch.map(({ to, data }) => ({ to, data })) });
  ok(
    buyBatch.at(-1)!.to === board && sim.results.every((r) => r.status === "success"),
    `a first buy ($500 of NVIDIA) carries join() at the end and simulates (${buyBatch.length} calls)`,
  );

  console.log(
    `\nBoard e2e: ALL PASSED\n\nNEXT_PUBLIC_BASE_RPC_URL=${RPC}\nNEXT_PUBLIC_GOOSE_BOARD=${board}\npreview: /leaderboard?as=${sam}`,
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
