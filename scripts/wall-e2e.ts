/**
 * Greedy Fatalities end to end on a local Base mainnet fork (anvil). Nothing touches mainnet: the script refuses any RPC
 * that isn't anvil on this machine.
 *
 *   anvil --fork-url https://mainnet.base.org --port 8546
 *   (cd contracts && forge build)
 *   WALL_FORK_RPC=http://127.0.0.1:8546 npx tsx scripts/wall-e2e.ts
 *
 *   1. deploy GooseBoard, and put the test OracleDouble at Aave's spoke oracle at today's prices;
 *   2. Kit joins, then the Wall opens; Sam joins after it, puts 40 NVIDIA in as backing and takes credit near the limit;
 *   3. in one block, as a liquidator usually lands it, NVIDIA's price drops and part of Sam's NVIDIA is sold to pay
 *      Sam's credit (Aave V4's liquidationCall);
 *   4. the Wall is read with the app's own reader (readWall): Sam alone, at the leverage from what Sam held the block
 *      before, valued at the sale block's price (not the old price the block before still has);
 *   5. Sam leaves the board, then joins again: still on the Wall, at the same row.
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  parseGwei,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = process.env.WALL_FORK_RPC ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC))
  throw new Error("WALL_FORK_RPC must be anvil on this machine");

// anvil's well-known test keys: worthless outside a local fork.
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const SAM = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const KIT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const LIQUIDATOR = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
/** A USDC holder on Base (as scripts/board-e2e.ts uses). */
const WHALE: Address = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const AERO_FACTORY: Address = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef";
const aeroFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
]);
const oracleDoubleAbi = parseAbi(["function setReservePrice(uint256 reserveId, uint256 price)"]);
const RECEIPT_TIMEOUT = 15 * 60_000;

const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const artifact = (file: string, name: string) => JSON.parse(readFileSync(`contracts/out/${file}/${name}.json`, "utf8"));

async function main() {
  const client = createPublicClient({ chain: base, transport: http(RPC) });
  const test = createTestClient({ chain: base, transport: http(RPC), mode: "anvil" });
  const wallet = (account: typeof DEPLOYER) => createWalletClient({ chain: base, transport: http(RPC), account });
  await test.request({ method: "anvil_nodeInfo" as never }).catch(() => {
    throw new Error(`${RPC} isn't anvil`);
  });
  ok((await client.getChainId()) === 8453, "a fork of Base mainnet");
  const mined = async (hash: Hex) => {
    const r = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT });
    if (r.status !== "success") throw new Error(`reverted: ${hash}`);
    return r;
  };

  const { AAVE } = await import("@/lib/aave/addresses");
  const { spokeAbi } = await import("@/lib/aave/abis/ISpoke");
  const { aaveOracleAbi } = await import("@/lib/aave/abis/IAaveOracle");
  const { buildSupplyCalls, buildCreditCalls } = await import("@/lib/aave/tx");
  const { EQUITIES, USDC } = await import("@/lib/tokens/registry");
  const { gooseBoardAbi } = await import("@/lib/board/abi");
  const { readWall } = await import("@/lib/board/read");
  const { readHoldings, readPrices } = await import("@/lib/board/worth");
  const { saleMultiple } = await import("@/lib/board/wall");
  const NVDA = EQUITIES.find((e) => e.symbol === "NVDAc")!;

  // 1. the board, and Aave's oracle stood in at today's prices
  const deployer = wallet(DEPLOYER);
  const boardArt = artifact("GooseBoard.sol", "GooseBoard");
  const board = (await mined(await deployer.deployContract({ abi: boardArt.abi, bytecode: boardArt.bytecode.object })))
    .contractAddress!;
  console.log(`GooseBoard ${board}`);
  // Every reserve's price, USDC's too: a stand-in without it would value Sam's credit at $0.
  const RESERVES = [...EQUITIES.map((e) => e.reserveId), USDC.reserveId];
  const read = await client.multicall({
    allowFailure: false,
    contracts: RESERVES.map(
      (id) =>
        ({
          address: AAVE.SPOKE_ORACLE,
          abi: aaveOracleAbi,
          functionName: "getReservePrice",
          args: [BigInt(id)],
        }) as const,
    ),
  });
  const today = new Map(RESERVES.map((id, i) => [id, read[i]]));
  await test.setCode({
    address: AAVE.SPOKE_ORACLE,
    bytecode: artifact("OracleDouble.sol", "OracleDouble").deployedBytecode.object,
  });
  const setPrice = (
    reserveId: number,
    price: bigint,
    fees?: { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  ) =>
    deployer.writeContract({
      address: AAVE.SPOKE_ORACLE,
      abi: oracleDoubleAbi,
      functionName: "setReservePrice",
      args: [BigInt(reserveId), price],
      ...fees,
    });
  for (const [id, price] of today) await mined(await setPrice(id, price));
  ok(true, "Aave's oracle stood in, at today's prices");

  for (const a of [SAM, KIT, LIQUIDATOR]) await test.setBalance({ address: a.address, value: parseEther("1") });
  const join = async (who: typeof SAM) =>
    mined(await wallet(who).writeContract({ address: board, abi: gooseBoardAbi, functionName: "join" }));

  // 2. Kit joins, the Wall opens, then Sam joins
  await join(KIT);
  const from = await client.getBlockNumber();
  await join(SAM);
  ok(true, `Kit joined, the Wall opens from block ${from}, Sam joined after`);

  const pool = await client.readContract({
    address: AERO_FACTORY,
    abi: aeroFactoryAbi,
    functionName: "getPool",
    args: [NVDA.address, USDC.address, 10],
  });
  await test.impersonateAccount({ address: pool });
  await test.setBalance({ address: pool, value: parseEther("1") });
  const SHARES = 40n * 10n ** 8n;
  await mined(
    await createWalletClient({ chain: base, transport: http(RPC), account: pool }).writeContract({
      address: NVDA.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [SAM.address, SHARES],
    }),
  );
  const sam = wallet(SAM);
  for (const call of buildSupplyCalls({ user: SAM.address, stock: NVDA, amountRaw: SHARES }))
    await mined(await sam.sendTransaction({ to: call.to, data: call.data }));
  const data = await client.readContract({
    address: AAVE.SPOKE,
    abi: spokeAbi,
    functionName: "getUserAccountData",
    args: [SAM.address],
  });
  // Credit near the limit, health about 1.02 (lib/aave/math.ts: value units 1e26 = $1, the factor in WAD).
  const creditRaw = (data.totalCollateralValue * data.avgCollateralFactor * 100n) / 10n ** 18n / 10n ** 20n / 102n;
  for (const call of buildCreditCalls({ user: SAM.address, amountRaw: creditRaw }))
    await mined(await sam.sendTransaction({ to: call.to, data: call.data }));
  ok(creditRaw > 0n, `Sam backs credit with 40 NVIDIA and took $${Number(creditRaw) / 1e6} near the limit`);

  // A liquidator with USDC, approved ahead.
  await test.impersonateAccount({ address: WHALE });
  await test.setBalance({ address: WHALE, value: parseEther("1") });
  await mined(
    await createWalletClient({ chain: base, transport: http(RPC), account: WHALE }).writeContract({
      address: USDC.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [LIQUIDATOR.address, creditRaw * 2n],
    }),
  );
  const liquidator = wallet(LIQUIDATOR);
  await mined(
    await liquidator.writeContract({
      address: USDC.address,
      abi: erc20Abi,
      functionName: "approve",
      args: [AAVE.SPOKE, creditRaw * 2n],
    }),
  );

  // 3. one block: NVIDIA drops 6%, and part of Sam's NVIDIA is sold to pay Sam's credit
  await test.setAutomine(false);
  // The price update first in the block (a higher tip), the sale right after it, as a liquidator backruns it.
  const dropped = (today.get(NVDA.reserveId)! * 94n) / 100n;
  const priceTx = await setPrice(NVDA.reserveId, dropped, {
    gas: 200_000n,
    maxFeePerGas: parseGwei("20"),
    maxPriorityFeePerGas: parseGwei("10"),
  });
  const saleTx = await liquidator.writeContract({
    address: AAVE.SPOKE,
    abi: spokeAbi,
    functionName: "liquidationCall",
    // As much as Aave lets go (it caps what a sale covers and never leaves dust).
    args: [BigInt(NVDA.reserveId), BigInt(USDC.reserveId), SAM.address, maxUint256, false],
    gas: 3_000_000n,
    maxFeePerGas: parseGwei("20"),
    maxPriorityFeePerGas: 1n,
  });
  await test.mine({ blocks: 1 });
  await test.setAutomine(true);
  const [p, s] = await Promise.all([mined(priceTx), mined(saleTx)]);
  ok(
    p.blockNumber === s.blockNumber && p.transactionIndex < s.transactionIndex,
    `the price drop, then the sale, in one block (${s.blockNumber})`,
  );

  // 4. the Wall, read by the app
  const before = (await readHoldings(client, [SAM.address], s.blockNumber - 1n))[0];
  const atSale = saleMultiple(before, await readPrices(client, s.blockNumber));
  const atOldPrice = saleMultiple(before, await readPrices(client, s.blockNumber - 1n));
  const wall = await readWall({ state: client, logs: client, board, from });
  console.log(wall.rows);
  ok(wall.rows.length === 1, "one row on the Wall");
  ok(wall.rows[0].account.toLowerCase() === SAM.address.toLowerCase(), "it's Sam; Kit had nothing sold");
  ok(wall.rows[0].block === s.blockNumber && wall.rows[0].rank === 1, "at the sale's block, ranked 1");
  ok(
    typeof atSale === "number" && wall.rows[0].multiple === atSale,
    `the multiple is at the sale block's price: ${String(atSale)}x`,
  );
  ok(
    typeof atOldPrice === "number" && typeof atSale === "number" && atSale > atOldPrice,
    `not the block before's old price (${String(atOldPrice)}x)`,
  );
  ok(wall.rows[0].time > 0, "with the sale's time");

  // 5. leaving doesn't take Sam off; joining again doesn't move the row
  await mined(await sam.writeContract({ address: board, abi: gooseBoardAbi, functionName: "leave" }));
  const afterLeave = await readWall({ state: client, logs: client, board, from });
  ok(afterLeave.rows.length === 1 && afterLeave.rows[0].multiple === atSale, "Sam left the board: still on the Wall");
  await join(SAM);
  const afterRejoin = await readWall({ state: client, logs: client, board, from });
  ok(afterRejoin.rows.length === 1 && afterRejoin.rows[0].block === s.blockNumber, "Sam joined again: same row");

  // And the Wall opening after the sale shows nobody.
  const later = await readWall({ state: client, logs: client, board, from: s.blockNumber });
  ok(later.rows.length === 0, "a Wall that opens after the sale shows nobody");
  console.log("\nGreedy Fatalities end to end: all checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
