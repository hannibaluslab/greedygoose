/**
 * GooseGuard on the REAL B20 stock tokens (contracts/docs/FIX-PLAN-2026-10-20.md §6).
 *
 * Foundry can't run B20 code: Base's client runs the stocks natively and their code is the single byte 0xef, so every
 * fork test swaps in StockDouble. This suite runs the Guard end to end against the real tokens with eth_simulateV1 on a
 * keyless public RPC, `validation: false`. Nothing is signed or broadcast, and the app's Alchemy key is never used.
 *
 * - Block 1 (setup): deploy the Guard; create JAW accounts through the factory (owners: a signer and the manager); move
 *   them real NVDAc from an existing holder; supply it to Aave V4 and draw USDC credit to health ≈ 1.02; approve each
 *   agent's permission through the account (the EntryPoint calls account.executeBatch) and register it, exactly as
 *   PlannerForkBase builds them.
 * - Block 2: the runner's performUpkeep at KeeperHub's 5.5M: a two-slice Protect SELL, a one-slice SELL (per-slice gas)
 *   and a Rebalance TRADE (sell NVDAc, buy AAPLc).
 * - Block 3: reads of health, credit, wallet stock and allowances.
 *
 * Run: npx vitest run tests/onchain/guard-b20-sim.test.ts   (needs forge on PATH; GUARD_SIM_RPC picks the other keyless
 * RPC, https://mainnet.base.org)
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  concat,
  createPublicClient,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  numberToHex,
  parseAbi,
  slice,
  toBytes,
  zeroAddress,
  type Abi,
  type Hex,
} from "viem";
import { base } from "viem/chains";

// ==================================================================== the RPC: keyless and public only

const RPC = process.env.GUARD_SIM_RPC ?? "https://base-rpc.publicnode.com";
if (!/^https:\/\/(base-rpc\.publicnode\.com|mainnet\.base\.org)\/?$/.test(RPC)) {
  throw new Error(`guard-b20-sim runs only on a keyless public RPC, not ${RPC}`);
}
const client = createPublicClient({
  chain: base,
  transport: http(RPC, { retryCount: 4, retryDelay: 2_000, timeout: 90_000 }),
});

// ==================================================================== Base

const MANAGER: Hex = "0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8";
const FACTORY: Hex = "0x5803c076563C85799989d42Fc00292A8aE52fa9E";
const ENTRY_POINT: Hex = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const SPOKE: Hex = "0x17905Db0e4A3514467539956c084180616AE7B8D";
const ORACLE: Hex = "0xaBaf048fD7675Ea34a84332371ffd5D55E322A47";
const USDC: Hex = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ROUTER: Hex = "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F";
const NVDA_POOL: Hex = "0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9";
const AAVE_HUB: Hex = "0xa4d5947Eb727A052bae69C593FfC84247EC9864E";
/** JAW's account clone (DeployExecutor.s.sol:65), the one codehash the Guard allows. */
const CLONE_CODEHASH: Hex = "0xc79e2c8f7a03b38abd65a7e073fc3410849544bba74f53360c127775bc891848";
const STOCKS: Hex[] = [
  "0xb200000000000000000000C2e324d24d7eEcd1fb", // AAPLc
  "0xb200000000000000000000d9192b6B456483C2E8", // AMZNc
  "0xb2000000000000000000002D0BA3164cc74f58B7", // GOOGLc
  "0xb2000000000000000000008bC8786B856E61707C", // METAc
  "0xB200000000000000000000Ab99cFa739E253872B", // MSFTc
  "0xb20000000000000000000078ee7ce2fE4908108C", // NVDAc
  "0xb2000000000000000000001e800a7f5189430cD0", // TSLAc
];
const AAPL = 0;
const NVDA = 5;
const AAPLC = STOCKS[AAPL];
const NVDAC = STOCKS[NVDA];
const USDC_RESERVE = 7n;
/** Holds NVDAc and AAPL free, an EOA (sell.test.ts's newcomer, found via NVIDIA's Transfer logs). Re-read every run. */
const KNOWN_HOLDERS: Hex[] = ["0xb5ef91ce939f2c390cff462bb231e74bb228deb4"];

// The test's own actors: fresh addresses nobody controls, used only as simulated senders.
const DEPLOYER: Hex = "0x000000000000000000000000000000000b20a001";
const RUNNER: Hex = "0x000000000000000000000000000000000b20a002";
const SIGNERS: Hex[] = [
  "0x000000000000000000000000000000000b20a011",
  "0x000000000000000000000000000000000b20a012",
  "0x000000000000000000000000000000000b20a013",
];
/** KeeperHub's write (PlannerForkBase: 5.5M, about 5.4M reaches the Guard). */
const KH_GAS = 5_500_000n;
const SETUP_GAS = 15_000_000n;
const WAD = 10n ** 18n;
const TARGET_HF = 1.02e18;

// Sizes, in raw shares (8 decimals).
const SELL_SUPPLY = 20n * 10n ** 8n; // account A: the two-slice sale
const SELL1_SUPPLY = 10n * 10n ** 8n; // account A1: the one-slice sale
const TRADE_FREE = 3n * 10n ** 8n; // account B: free NVDAc for the trade
const TRADE_USD = 100n; // about $100 of NVDAc sold, its floor bought as AAPLc

// ==================================================================== ABIs

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);
const factoryAbi = parseAbi(["function createAccount(bytes[] owners, uint256 nonce) payable returns (address)"]);
const accountAbi = parseAbi([
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
  // How a JAW account's executeBatch reports a failed call: its index in the batch and the call's own revert data.
  "error ExecuteError(uint256 index, bytes reason)",
]);
const spokeAbi = parseAbi([
  "function supply(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf)",
  "function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function getUserAccountData(address user) view returns ((uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount))",
  "function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)",
  "function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)",
]);
const oracleAbi = parseAbi(["function getReservePrice(uint256 reserveId) view returns (uint256)"]);
const managerAbi = parseAbi([
  "struct CallPermission { address target; bytes4 selector; address checker; }",
  "struct SpendLimit { address token; uint160 allowance; uint8 unit; uint16 multiplier; }",
  "struct Permission { address account; address spender; uint48 start; uint48 end; uint256 salt; CallPermission[] calls; SpendLimit[] spends; }",
  "function approve(Permission permission) returns (bool)",
]);
const permissionParams = getAbiItem({ abi: managerAbi, name: "approve" }).inputs;
const movesParams = [
  {
    type: "tuple[]",
    components: [
      { name: "account", type: "address" },
      { name: "kind", type: "uint8" },
      { name: "args", type: "uint256[]" },
    ],
  },
] as const;

// ==================================================================== the Guard, built from the source

const CONTRACTS = fileURLToPath(new URL("../../contracts", import.meta.url));
const forge = (what: string) =>
  execSync(`forge inspect src/GooseGuard.sol:GooseGuard ${what}`, { cwd: CONTRACTS, encoding: "utf8" }).trim();
let guardAbi: Abi;
let guardBytecode: Hex;
/** Every Guard error by selector, to name a `Refused` reason, plus the B20 errors a stock transfer can revert with. */
const guardErrors = new Map<string, string>();
/** base-std src/interfaces/IB20.sol and IPolicyRegistry.sol (docs.base.org/specifications/b20). */
const b20Abi = parseAbi([
  "error ContractPaused(uint8 feature)",
  "error PolicyForbids(bytes32 policyScope, uint64 policyId)",
  "function policyId(bytes32 policyScope) view returns (uint64)",
]);
const POLICY_REGISTRY: Hex = "0x8453000000000000000000000000000000000002";
const registryAbi = parseAbi([
  "function policyAdmin(uint64 policyId) view returns (address)",
  "function isAuthorized(uint64 policyId, address account) view returns (bool)",
  "function updateBlocklist(uint64 policyId, bool blocked, address[] accounts)",
]);
const TRANSFER_RECEIVER_POLICY: Hex = "0x8a4b3fa2d8b921852bc0089c6ef0958aa6961897be36fd731330fe2cd23f8363";

// ==================================================================== eth_simulateV1

type SimCall = { from: Hex; to?: Hex; data: Hex; gas?: Hex };
type SimBlock = { calls: SimCall[]; stateOverrides?: Record<string, unknown> };
type SimLog = { address: Hex; topics: Hex[]; data: Hex };
type SimResult = {
  status: Hex;
  returnData: Hex;
  gasUsed: Hex;
  logs: SimLog[];
  error?: { code: number; message: string; data?: Hex };
};

let head: { number: bigint; timestamp: bigint };
let rpcCalls = 0;

/** Blocks on top of the pinned head, 2 s apart (Base's block time). */
async function simulate(blocks: SimBlock[]): Promise<SimResult[][]> {
  rpcCalls++;
  const res = (await client.request({
    method: "eth_simulateV1",
    params: [
      {
        blockStateCalls: blocks.map((b, i) => ({
          blockOverrides: { number: numberToHex(head.number + BigInt(i + 1)), time: numberToHex(time(i + 1)) },
          stateOverrides: b.stateOverrides,
          calls: b.calls,
        })),
        validation: false,
        traceTransfers: false,
      },
      numberToHex(head.number),
    ],
  } as never)) as { calls: SimResult[] }[];
  return res.map((b) => b.calls);
}

const time = (block: number) => head.timestamp + 2n * BigInt(block);
/** A transaction's intrinsic gas (21,000 and its calldata), taken off so the gas compares with forge's (GuardForkBase
 *  `_execGas`). */
const execGas = (r: SimResult, c: SimCall) =>
  BigInt(r.gasUsed) - toBytes(c.data).reduce((g, b) => g + (b === 0 ? 4n : 16n), 21_000n);
const gas = (x: bigint) => numberToHex(x);
const ok = (r: SimResult) => r.status === "0x1";
const call = (from: Hex, to: Hex, data: Hex, g = SETUP_GAS): SimCall => ({ from, to, data, gas: gas(g) });
const read = (to: Hex, data: Hex) => call(DEPLOYER, to, data, 5_000_000n);

function must(r: SimResult, what: string) {
  if (!ok(r)) throw new Error(`${what} reverted: ${r.error?.message ?? ""} ${r.error?.data ?? r.returnData}`);
  return r;
}

const uint = (r: SimResult) => BigInt(must(r, "read").returnData);
const balanceOf = (token: Hex, who: Hex) =>
  read(token, encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [who] }));
const allowance = (token: Hex, owner: Hex, spender: Hex) =>
  read(token, encodeFunctionData({ abi: erc20, functionName: "allowance", args: [owner, spender] }));
const accountData = (who: Hex) =>
  read(SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserAccountData", args: [who] }));
const debtOf = (who: Hex) =>
  read(SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserTotalDebt", args: [USDC_RESERVE, who] }));
const suppliedOf = (who: Hex, r: number) =>
  read(SPOKE, encodeFunctionData({ abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(r), who] }));
const priceOf = (r: number) =>
  read(ORACLE, encodeFunctionData({ abi: oracleAbi, functionName: "getReservePrice", args: [BigInt(r)] }));
const decodeData = (r: SimResult) =>
  decodeFunctionResult({ abi: spokeAbi, functionName: "getUserAccountData", data: must(r, "account data").returnData });

// ==================================================================== JAW accounts and permissions

const owners = (signer: Hex) => [
  encodeAbiParameters([{ type: "address" }], [signer]),
  encodeAbiParameters([{ type: "address" }], [MANAGER]),
];
const createAccount = (signer: Hex) =>
  call(
    DEPLOYER,
    FACTORY,
    encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [owners(signer), 0n] }),
  );

/** What a JAW user operation runs on-chain: the EntryPoint calls account.executeBatch(calls). */
const viaAccount = (account: Hex, calls: { target: Hex; data: Hex }[]) =>
  call(
    ENTRY_POINT,
    account,
    encodeFunctionData({
      abi: accountAbi,
      functionName: "executeBatch",
      args: [calls.map((c) => ({ target: c.target, value: 0n, data: c.data }))],
    }),
  );

const approveCall = (token: Hex, spender: Hex, amount: bigint) => ({
  target: token,
  data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [spender, amount] }),
});

/** Supply `shares` of stock r to Aave V4 and turn it on as backing, as the account. */
const backWith = (account: Hex, r: number, shares: bigint) =>
  viaAccount(account, [
    approveCall(STOCKS[r], SPOKE, shares),
    {
      target: SPOKE,
      data: encodeFunctionData({ abi: spokeAbi, functionName: "supply", args: [BigInt(r), shares, account] }),
    },
    {
      target: SPOKE,
      data: encodeFunctionData({
        abi: spokeAbi,
        functionName: "setUsingAsCollateral",
        args: [BigInt(r), true, account],
      }),
    },
  ]);

const drawCredit = (account: Hex, raw: bigint) =>
  viaAccount(account, [
    {
      target: SPOKE,
      data: encodeFunctionData({ abi: spokeAbi, functionName: "borrow", args: [USDC_RESERVE, raw, account] }),
    },
  ]);

type Permission = {
  account: Hex;
  spender: Hex;
  start: number;
  end: number;
  salt: bigint;
  calls: { target: Hex; selector: Hex; checker: Hex }[];
  spends: { token: Hex; allowance: bigint; unit: number; multiplier: number }[];
};
const NO_LIMIT = (1n << 160n) - 1n;
const DAY = 2; // PeriodUnit.Day
const APPROVE: Hex = "0x095ea7b3";

/** PlannerForkBase._on: start a minute ago, a year long, a spend limit per token. */
function permission(account: Hex, guard: Hex, job: number, calls: [Hex, Hex][], tokens: Hex[]): Permission {
  const now = time(1);
  return {
    account,
    spender: guard,
    start: Number(now - 60n),
    end: Number(now + 365n * 86_400n),
    salt: BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint8" }], [account, job]))),
    calls: calls.map(([target, selector]) => ({ target, selector, checker: zeroAddress })),
    spends: tokens.map((token) => ({ token, allowance: NO_LIMIT, unit: DAY, multiplier: 1 })),
  };
}

/** PlannerForkBase._sellOn: Protect · sell over all seven stocks, with the config refresh. */
const sellPermission = (account: Hex, guard: Hex) =>
  permission(
    account,
    guard,
    2,
    [
      ...STOCKS.map((s) => [s, APPROVE] as [Hex, Hex]),
      [SPOKE, "0x0ad58d2f"], // withdraw
      [ROUTER, "0xa026383e"], // exactInputSingle
      [USDC, APPROVE],
      [SPOKE, "0xb1e8f8ef"], // repay
      [SPOKE, "0x826002e2"], // updateUserDynamicConfig
    ],
    [USDC, ...STOCKS],
  );

/** PlannerForkBase._rebalanceOn: approve each stock and USDC, swap on Aerodrome. */
const rebalancePermission = (account: Hex, guard: Hex) =>
  permission(
    account,
    guard,
    3,
    [...STOCKS.map((s) => [s, APPROVE] as [Hex, Hex]), [USDC, APPROVE], [ROUTER, "0xa026383e"]],
    [USDC, ...STOCKS],
  );

/** The grant and the registration in one user operation, as the app sends them. */
const grantAndRegister = (guard: Hex, job: number, p: Permission) =>
  viaAccount(p.account, [
    { target: MANAGER, data: encodeFunctionData({ abi: managerAbi, functionName: "approve", args: [p] }) },
    {
      target: guard,
      data: encodeFunctionData({
        abi: guardAbi,
        functionName: "register",
        args: [job, encodeAbiParameters(permissionParams, [p] as never)],
      }),
    },
  ]);

type Move = { account: Hex; kind: number; args: bigint[] };
const perform = (guard: Hex, moves: Move[]) =>
  call(
    RUNNER,
    guard,
    encodeFunctionData({
      abi: guardAbi,
      functionName: "performUpkeep",
      args: [encodeAbiParameters(movesParams, [moves])],
    }),
    KH_GAS,
  );

const sellLeg = (r: number, shares: bigint) => (BigInt(r) << 248n) | shares;
const buyLeg = (r: number, usdc: bigint) => (BigInt(r) << 248n) | (1n << 247n) | usdc;

// ==================================================================== logs

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

function guardEvents(logs: SimLog[], guard: Hex) {
  return logs
    .filter((l) => same(l.address, guard))
    .map((l) => decodeEventLog({ abi: guardAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }));
}

/** A `Refused` reason by name: a Guard error, or the inner revert's selector. */
const reasonName = (reason: Hex) => guardErrors.get(reason.toLowerCase()) ?? `inner revert ${reason}`;

function approvals(logs: SimLog[], token: Hex, owner: Hex, spender: Hex): bigint[] {
  return logs
    .filter((l) => same(l.address, token))
    .map((l) => {
      try {
        return decodeEventLog({ abi: erc20, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      } catch {
        return null;
      }
    })
    .filter(
      (e): e is { eventName: "Approval"; args: { owner: Hex; spender: Hex; value: bigint } } =>
        e?.eventName === "Approval" && same(e.args.owner, owner) && same(e.args.spender, spender),
    )
    .map((e) => e.args.value);
}

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const APPROVAL_TOPIC = keccak256(toBytes("Approval(address,address,uint256)"));
/** Where in the logs `token` last emitted `topic` with `owner` (from) first. */
const lastLog = (logs: SimLog[], token: Hex, topic: Hex, owner: Hex) =>
  logs.findLastIndex((l) => same(l.address, token) && l.topics[0] === topic && same(slice(l.topics[1], 12), owner));

const transfers = (logs: SimLog[], token: Hex) =>
  logs
    .filter((l) => same(l.address, token) && l.topics[0] === TRANSFER_TOPIC)
    .map((l) => ({
      from: getAddress(slice(l.topics[1], 12)),
      to: getAddress(slice(l.topics[2], 12)),
      value: BigInt(l.data),
    }));

// ==================================================================== holders of real NVDAc

type Source = { holder: Hex; amount: bigint };

/** EOAs that together hold `need` raw NVDAc at the pinned block: a known holder when it holds enough, else the largest
 *  holders among the token's own recent Transfer senders and receivers (the keyless RPC's ~10,000-block log window). */
async function findHolders(token: Hex, need: bigint): Promise<Source[]> {
  const [known] = await simulate([{ calls: KNOWN_HOLDERS.map((h) => balanceOf(token, h)) }]);
  for (let i = 0; i < KNOWN_HOLDERS.length; i++) {
    if (uint(known[i]) >= need) return [{ holder: getAddress(KNOWN_HOLDERS[i]), amount: need }];
  }

  rpcCalls++;
  const logs = await client.getLogs({
    address: token,
    event: getAbiItem({ abi: erc20, name: "Transfer" }),
    fromBlock: head.number - 9_000n,
    toBlock: head.number,
  });
  const skip = new Set([NVDA_POOL, AAVE_HUB, SPOKE, ROUTER, zeroAddress].map((a) => a.toLowerCase()));
  const seen = [
    ...new Set(logs.reverse().flatMap((l) => [l.args.to!, l.args.from!].map((a) => a.toLowerCase() as Hex))),
  ]
    .filter((a) => !skip.has(a))
    .slice(0, 60);
  const [balances] = await simulate([{ calls: seen.map((h) => balanceOf(token, h)) }]);
  const ranked = seen
    .map((holder, i) => ({ holder, balance: uint(balances[i]) }))
    .filter((x) => x.balance > 0n)
    .sort((x, y) => (y.balance > x.balance ? 1 : y.balance < x.balance ? -1 : 0));
  const out: Source[] = [];
  let left = need;
  for (const { holder, balance } of ranked) {
    if (left === 0n) break;
    rpcCalls++;
    const code = await client.getCode({ address: holder, blockNumber: head.number });
    // A plain EOA, or one delegated under EIP-7702 (0xef0100 ‖ address): both send a transfer as themselves.
    if (code && code !== "0x" && !code.startsWith("0xef0100")) continue;
    const amount = balance < left ? balance : left;
    out.push({ holder: getAddress(holder), amount });
    left -= amount;
  }
  if (left > 0n)
    throw new Error(`EOAs seen in the last 9,000 blocks hold ${need - left} of the ${need} raw ${token} needed`);
  return out;
}

// ==================================================================== the run

type Run = {
  guard: Hex;
  a: Hex; // two-slice SELL
  a1: Hex; // one-slice SELL
  b: Hex; // TRADE
  sources: Source[];
  nvdaPrice: bigint;
  aaplPrice: bigint;
  legs: bigint[];
  leg1: bigint;
  tradeShares: bigint;
  tradeFloor: bigint;
  setup: SimResult[];
  moves: SimResult[];
  after: SimResult[];
  blocks: SimBlock[];
};
let run: Run;

/** Block 1's setup, up to (not including) the credit draw and the grants. */
function setupCalls(guard: Hex, sources: Source[], a: Hex, a1: Hex, b: Hex): SimCall[] {
  const transfer = (from: Hex, to: Hex, amount: bigint) =>
    call(from, NVDAC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] }));
  const ctor = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [DEPLOYER, RUNNER, CLONE_CODEHASH, 300n, 50n, 100n, 10n ** 6n, 10n ** 6n],
  );
  return [
    { from: DEPLOYER, data: concat([guardBytecode, ctor]), gas: gas(SETUP_GAS) }, // CREATE at DEPLOYER's nonce 0
    createAccount(SIGNERS[0]),
    createAccount(SIGNERS[1]),
    createAccount(SIGNERS[2]),
    // The holders' real NVDAc goes to the deployer first, then out to the three accounts.
    ...sources.map((s) => transfer(s.holder, DEPLOYER, s.amount)),
    transfer(DEPLOYER, a, SELL_SUPPLY),
    transfer(DEPLOYER, a1, SELL1_SUPPLY),
    transfer(DEPLOYER, b, TRADE_FREE),
    backWith(a, NVDA, SELL_SUPPLY),
    backWith(a1, NVDA, SELL1_SUPPLY),
  ];
}

/** USDC credit that takes the account to health `hf` (ForkBase._drawTo). */
const creditTo = (d: { totalCollateralValue: bigint; avgCollateralFactor: bigint }, hf: bigint) =>
  (((d.totalCollateralValue * d.avgCollateralFactor) / WAD) * WAD) / hf / 10n ** 20n;

/** The largest stock withdrawal (raw shares) that keeps health at least 1, for an account backed by one stock. */
function maxFirstWithdraw(
  d: { totalCollateralValue: bigint; avgCollateralFactor: bigint },
  debtRaw: bigint,
  price: bigint,
) {
  const power = (d.totalCollateralValue * d.avgCollateralFactor) / WAD; // value units
  const debt = debtRaw * 10n ** 20n;
  const value = ((power - debt) * WAD) / d.avgCollateralFactor; // value units of stock
  return value / (price * 10n ** 10n); // one raw share is worth price × 1e10 value units
}

beforeAll(async () => {
  guardBytecode = forge("bytecode") as Hex;
  guardAbi = JSON.parse(forge("abi --json")) as Abi;
  for (const item of [...guardAbi, ...b20Abi, ...accountAbi]) {
    if (item.type !== "error") continue;
    const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
    guardErrors.set(slice(keccak256(toBytes(sig)), 0, 4), item.name);
  }

  rpcCalls++;
  const latest = await client.getBlock({ blockTag: "latest" });
  head = { number: latest.number, timestamp: latest.timestamp };
  const guard = getContractAddress({ from: DEPLOYER, nonce: 0n });

  // 1. The accounts' addresses (the factory's return), the prices and the NVDAc holders.
  const need = SELL_SUPPLY + SELL1_SUPPLY + TRADE_FREE;
  const [sources, probe] = await Promise.all([
    findHolders(NVDAC, need),
    simulate([{ calls: [...SIGNERS.map(createAccount), priceOf(NVDA), priceOf(AAPL)] }]),
  ]);
  const [a, a1, b] = probe[0].slice(0, 3).map((r) => getAddress(slice(must(r, "createAccount").returnData, 12)));
  const [nvdaPrice, aaplPrice] = probe[0].slice(3).map(uint);

  // 2. Block 1 without the credit, to size the credit on Aave's own reading.
  const pre = await simulate([{ calls: [...setupCalls(guard, sources, a, a1, b), accountData(a), accountData(a1)] }]);
  pre[0].slice(0, -2).forEach((r, i) => must(r, `setup call ${i}`));
  const [dA, dA1] = pre[0].slice(-2).map(decodeData);
  const creditA = creditTo(dA, BigInt(TARGET_HF));
  const creditA1 = creditTo(dA1, BigInt(TARGET_HF));

  // The sale: slices of 60% of the most the first withdrawal may take with health staying at 1 or more.
  const leg = (maxFirstWithdraw(dA, creditA, nvdaPrice) * 6n) / 10n;
  const leg1 = (maxFirstWithdraw(dA1, creditA1, nvdaPrice) * 6n) / 10n;
  const legs = [leg, leg];
  // The trade: about $100 of NVDAc, its floor (Aave's price less the 0.5% swap floor) into AAPLc.
  const tradeShares = (TRADE_USD * 10n ** 6n * 10n ** 10n) / nvdaPrice;
  const tradeFloor = (tradeShares * nvdaPrice * 9950n) / 10n ** 14n;
  const mix = 5000n | (5000n << BigInt(16 * NVDA)); // 50% AAPLc, 50% NVDAc

  // 3. The whole run: setup, the moves, the reads.
  const blocks: SimBlock[] = [
    {
      calls: [
        ...setupCalls(guard, sources, a, a1, b),
        drawCredit(a, creditA),
        drawCredit(a1, creditA1),
        grantAndRegister(guard, 2, sellPermission(a, guard)),
        grantAndRegister(guard, 2, sellPermission(a1, guard)),
        viaAccount(b, [
          { target: guard, data: encodeFunctionData({ abi: guardAbi, functionName: "setMix", args: [mix] }) },
        ]),
        grantAndRegister(guard, 3, rebalancePermission(b, guard)),
        read(guard, encodeFunctionData({ abi: guardAbi, functionName: "owner" })),
        accountData(a),
        accountData(a1),
        debtOf(a),
        suppliedOf(a, NVDA),
        suppliedOf(a1, NVDA),
        balanceOf(USDC, b),
      ],
    },
    {
      calls: [
        perform(guard, [{ account: a, kind: 2, args: legs.map((s) => sellLeg(NVDA, s)) }]),
        perform(guard, [{ account: a1, kind: 2, args: [sellLeg(NVDA, leg1)] }]),
        perform(guard, [{ account: b, kind: 3, args: [0n, sellLeg(NVDA, tradeShares), buyLeg(AAPL, tradeFloor)] }]),
      ],
    },
    {
      calls: [
        accountData(a),
        accountData(a1),
        debtOf(a),
        suppliedOf(a, NVDA),
        suppliedOf(a1, NVDA),
        balanceOf(NVDAC, a),
        balanceOf(NVDAC, a1),
        allowance(NVDAC, a, ROUTER),
        allowance(USDC, a, SPOKE),
        allowance(NVDAC, a1, ROUTER),
        allowance(USDC, a1, SPOKE),
        balanceOf(NVDAC, b),
        balanceOf(AAPLC, b),
        balanceOf(USDC, b),
        allowance(NVDAC, b, ROUTER),
        allowance(USDC, b, ROUTER),
        allowance(AAPLC, b, ROUTER),
      ],
    },
  ];
  const [setup, moves, after] = await simulate(blocks);
  run = {
    guard,
    a,
    a1,
    b,
    sources,
    nvdaPrice,
    aaplPrice,
    legs,
    leg1,
    tradeShares,
    tradeFloor,
    setup,
    moves,
    after,
    blocks,
  };
  console.log(
    `head ${head.number}, guard ${guard}, accounts A ${a} A1 ${a1} B ${b}, NVDAc from ${sources.map((x) => `${x.holder} (${x.amount})`).join(", ")}\n` +
      `NVDAc $${Number(nvdaPrice) / 1e8}, AAPLc $${Number(aaplPrice) / 1e8}; credit A ${Number(creditA) / 1e6} USDC, ` +
      `A1 ${Number(creditA1) / 1e6}; slices A ${legs.join(" + ")}, A1 ${leg1}; trade ${tradeShares} raw NVDAc → ` +
      `≥ ${Number(tradeFloor) / 1e6} USDC of AAPLc`,
  );
}, 300_000);

/** Runs a refused move again as the Guard itself (`run(move)` from the Guard, after `before` in block 2), to read
 *  its full revert data. */
async function why(move: Move, before: SimCall[] = []): Promise<string> {
  const blocks: SimBlock[] = [
    run.blocks[0],
    {
      calls: [
        ...before,
        call(run.guard, run.guard, encodeFunctionData({ abi: guardAbi, functionName: "run", args: [move] }), KH_GAS),
      ],
    },
  ];
  const r = (await simulate(blocks))[1].at(-1)!;
  if (ok(r)) return "runs now";
  return explain((r.error?.data ?? r.returnData) as Hex);
}

/** Revert data by name, nested errors included: ExecuteError(2, PolicyForbids(…)). */
function explain(data: Hex): string {
  try {
    const e = decodeErrorResult({ abi: [...guardAbi, ...b20Abi, ...accountAbi], data });
    const args = (e.args ?? []).map((x) => (typeof x === "string" && x.length > 10 ? explain(x as Hex) : String(x)));
    return `${e.errorName}(${args.join(", ")})`;
  } catch {
    return data;
  }
}

/** The perform didn't revert and the Guard refused nothing; prints the reason and full revert data if it did. */
async function expectRan(r: SimResult, move: Move, label: string) {
  expect(ok(r), `${label}: perform reverted: ${r.error?.message} ${r.error?.data}`).toBe(true);
  const refused = guardEvents(r.logs, run.guard).filter((e) => e.eventName === "Refused");
  for (const e of refused) {
    const reason = (e.args as unknown as { reason: Hex }).reason;
    console.log(`${label}: REFUSED ${reasonName(reason)} → ${await why(move)}`);
  }
  expect(refused.map((e) => reasonName((e.args as unknown as { reason: Hex }).reason))).toEqual([]);
}

// ==================================================================== the checks

describe("GooseGuard on the real B20 stocks (eth_simulateV1, nothing sent)", () => {
  it("block 1 sets up: the Guard, three JAW accounts, real NVDAc supplied, credit at health ≈ 1.02, agents registered", () => {
    run.setup.forEach((r, i) => must(r, `block 1 call ${i}`));
    const n = run.setup.length;
    expect(getAddress(slice(run.setup[n - 7].returnData, 12))).toBe(getAddress(DEPLOYER));
    const [dA, dA1] = [decodeData(run.setup[n - 6]), decodeData(run.setup[n - 5])];
    console.log(`health after block 1: A ${Number(dA.healthFactor) / 1e18}, A1 ${Number(dA1.healthFactor) / 1e18}`);
    expect(Number(dA.healthFactor) / 1e18).toBeCloseTo(1.02, 3);
    expect(Number(dA1.healthFactor) / 1e18).toBeCloseTo(1.02, 3);
    expect(uint(run.setup[n - 3])).toBe(SELL_SUPPLY);
    // Every JobOn the registrations emitted came from the Guard, one per agent.
    const jobs = run.setup.flatMap((r) => guardEvents(r.logs, run.guard)).filter((e) => e.eventName === "JobOn");
    expect(jobs).toHaveLength(3);
    // The real NVDAc moved: holders → the deployer → each account, then the two backers → Aave.
    const moved = run.setup.flatMap((r) => transfers(r.logs, NVDAC));
    expect(moved.filter((t) => same(t.to, DEPLOYER)).map((t) => t.value)).toEqual(run.sources.map((x) => x.amount));
    expect(moved.filter((t) => same(t.from, DEPLOYER)).map((t) => t.value)).toEqual([
      SELL_SUPPLY,
      SELL1_SUPPLY,
      TRADE_FREE,
    ]);
  });

  it("a two-slice Protect SELL of real NVDAc runs: ProtectSold, approvals reset to 0, no stock left, health up to ≤ target + 0.01", async () => {
    const move: Move = { account: run.a, kind: 2, args: run.legs.map((s) => sellLeg(NVDA, s)) };
    const r = run.moves[0];
    await expectRan(r, move, "SELL ×2");
    const logs = r.logs;
    const sold = guardEvents(logs, run.guard).find((e) => e.eventName === "ProtectSold");
    expect(sold, "no ProtectSold").toBeDefined();
    const { shares, repaid, hfBefore, hfAfter } = sold!.args as unknown as {
      shares: bigint[];
      repaid: bigint;
      hfBefore: bigint;
      hfAfter: bigint;
    };
    const total = run.legs[0] + run.legs[1];
    expect(shares[NVDA]).toBe(total);
    expect(hfAfter).toBeGreaterThan(hfBefore);

    // The manager ran one batch and reset every approval it made through the account, the real B20's included.
    expect(
      logs.filter((l) => same(l.address, MANAGER) && l.topics[0] === keccak256(toBytes("CallsExecuted(bytes32)"))),
    ).toHaveLength(1);
    const nvdaApprovals = approvals(logs, NVDAC, run.a, ROUTER);
    const usdcApprovals = approvals(logs, USDC, run.a, SPOKE);
    console.log(`SELL ×2 NVDAc→router approvals ${nvdaApprovals.join(" → ")}; USDC→spoke ${usdcApprovals.join(" → ")}`);
    // The real B20's transferFrom emits no Approval, so the second one is the manager's approve(router, 0) through the
    // account, after the last swap: the B20 reset ran and didn't revert the batch.
    expect(nvdaApprovals).toEqual([total, 0n]);
    expect(lastLog(logs, NVDAC, APPROVAL_TOPIC, run.a)).toBeGreaterThan(lastLog(logs, NVDAC, TRANSFER_TOPIC, run.a));
    expect(usdcApprovals.at(-1)).toBe(0n);

    // Exact B20 moves: Aave → account, account → the pool, slice by slice.
    const moved = transfers(logs, NVDAC);
    const intoAccount = moved.filter((t) => same(t.to, run.a)).map((t) => t.value);
    const outOfAccount = moved.filter((t) => same(t.from, run.a)).map((t) => t.value);
    expect(intoAccount).toEqual(run.legs);
    expect(outOfAccount).toEqual(run.legs);
    expect(moved.filter((t) => same(t.from, run.a)).every((t) => same(t.to, NVDA_POOL))).toBe(true);

    // Block 3's reads.
    const n = run.setup.length;
    const before = decodeData(run.setup[n - 6]);
    const after = decodeData(run.after[0]);
    expect(uint(run.after[5])).toBe(0n); // no NVDAc left in the wallet
    expect(uint(run.after[7])).toBe(0n); // NVDAc → router
    expect(uint(run.after[8])).toBe(0n); // USDC → spoke
    expect(uint(run.setup[n - 3]) - uint(run.after[3])).toBe(total); // backing fell by exactly the shares sold
    expect(uint(run.after[2])).toBeLessThan(uint(run.setup[n - 4])); // credit fell
    expect(uint(run.setup[n - 4]) - uint(run.after[2])).toBeGreaterThanOrEqual(repaid - 100n); // less 4 s of interest
    expect(after.healthFactor).toBeGreaterThan(before.healthFactor);
    expect(after.healthFactor).toBeLessThanOrEqual(1_130_000_000_000_000_000n); // default target 1.12 + 0.01
    console.log(
      `SELL ×2: ${total} raw NVDAc, repaid ${Number(repaid) / 1e6} USDC; health ${Number(before.healthFactor) / 1e18} → ` +
        `${Number(after.healthFactor) / 1e18}; gas ${BigInt(r.gasUsed)}, execution ${execGas(r, run.blocks[1].calls[0])} ` +
        `(the move's cap 2,500,000)`,
    );
  });

  it("a one-slice SELL runs too, and the second slice's gas is measured on the real tokens", async () => {
    const move: Move = { account: run.a1, kind: 2, args: [sellLeg(NVDA, run.leg1)] };
    const r = run.moves[1];
    await expectRan(r, move, "SELL ×1");
    expect(guardEvents(r.logs, run.guard).some((e) => e.eventName === "ProtectSold")).toBe(true);
    expect(uint(run.after[6])).toBe(0n);
    expect(uint(run.after[9])).toBe(0n);
    expect(uint(run.after[10])).toBe(0n);
    const one = execGas(r, run.blocks[1].calls[1]);
    const two = execGas(run.moves[0], run.blocks[1].calls[0]);
    console.log(
      `execution gas (no intrinsic): perform with 1 slice ${one}, 2 slices ${two}, a second slice of the same stock ${two - one}`,
    );
    expect(two).toBeGreaterThan(one);
  });

  it("a Rebalance TRADE on real tokens runs: sells NVDAc, buys AAPLc, approvals reset, cash not lower", async () => {
    const move: Move = {
      account: run.b,
      kind: 3,
      args: [0n, sellLeg(NVDA, run.tradeShares), buyLeg(AAPL, run.tradeFloor)],
    };
    const r = run.moves[2];
    await expectRan(r, move, "TRADE");
    const ev = guardEvents(r.logs, run.guard).find((e) => e.eventName === "Rebalanced");
    expect(ev, "no Rebalanced").toBeDefined();
    const { sold, bought } = ev!.args as unknown as { sold: bigint[]; bought: bigint[] };
    expect(sold[NVDA]).toBe(run.tradeShares);
    expect(bought[AAPL]).toBeGreaterThan(0n);
    // The floor: at least the USDC spent at Aave's price, less the 0.5% swap floor.
    expect(bought[AAPL]).toBeGreaterThanOrEqual((run.tradeFloor * 10n ** 10n * 9950n) / (run.aaplPrice * 10_000n));

    const usdcBefore = uint(run.setup.at(-1)!);
    expect(uint(run.after[11])).toBe(TRADE_FREE - run.tradeShares);
    expect(uint(run.after[12])).toBe(bought[AAPL]);
    expect(uint(run.after[13])).toBeGreaterThanOrEqual(usdcBefore);
    expect(uint(run.after[14])).toBe(0n);
    expect(uint(run.after[15])).toBe(0n);
    expect(uint(run.after[16])).toBe(0n);
    expect(approvals(r.logs, NVDAC, run.b, ROUTER).at(-1)).toBe(0n);
    expect(approvals(r.logs, USDC, run.b, ROUTER).at(-1)).toBe(0n);
    // Real AAPLc came from the pool into the account.
    expect(
      transfers(r.logs, AAPLC)
        .filter((t) => same(t.to, run.b))
        .map((t) => t.value),
    ).toEqual([bought[AAPL]]);
    console.log(
      `TRADE: sold ${sold[NVDA]} raw NVDAc, bought ${bought[AAPL]} raw AAPLc, cash +${Number(uint(run.after[13]) - usdcBefore) / 1e6} USDC; ` +
        `gas ${BigInt(r.gasUsed)}, execution ${execGas(r, run.blocks[1].calls[2])} (the move's cap ${500_000 + 320_000 * 3})`,
    );
  });

  it("negative: an account on the stocks' B20 blocklist is refused, the perform doesn't revert, and the next move runs", async () => {
    // The receiver policy NVDAc checks (CLAUDE.md: ID 5, a blocklist on B20's PolicyRegistry), and its admin.
    const policyRead = read(
      NVDAC,
      encodeFunctionData({ abi: b20Abi, functionName: "policyId", args: [TRANSFER_RECEIVER_POLICY] }),
    );
    const policy = uint((await simulate([{ calls: [policyRead] }]))[0][0]);
    const adminRead = read(
      POLICY_REGISTRY,
      encodeFunctionData({ abi: registryAbi, functionName: "policyAdmin", args: [policy] }),
    );
    const admin = getAddress(
      slice(must((await simulate([{ calls: [adminRead] }]))[0][0], "policyAdmin").returnData, 12),
    );

    // Block 2: the policy's admin blocks account A, then one perform carries A's sale and A1's.
    const block = call(
      admin,
      POLICY_REGISTRY,
      encodeFunctionData({ abi: registryAbi, functionName: "updateBlocklist", args: [policy, true, [run.a]] }),
    );
    const moveA: Move = { account: run.a, kind: 2, args: run.legs.map((s) => sellLeg(NVDA, s)) };
    const moveA1: Move = { account: run.a1, kind: 2, args: [sellLeg(NVDA, run.leg1)] };
    const authorized = read(
      POLICY_REGISTRY,
      encodeFunctionData({ abi: registryAbi, functionName: "isAuthorized", args: [policy, run.a] }),
    );
    const [, [blocked, isAuth, r], [supplied, debt]] = await simulate([
      run.blocks[0],
      { calls: [block, authorized, perform(run.guard, [moveA, moveA1])] },
      { calls: [suppliedOf(run.a, NVDA), debtOf(run.a)] },
    ]);
    must(blocked, "updateBlocklist as the policy's admin");
    expect(uint(isAuth)).toBe(0n);

    expect(ok(r), `the perform reverted: ${r.error?.message} ${r.error?.data}`).toBe(true);
    const events = guardEvents(r.logs, run.guard);
    const refused = events.filter((e) => e.eventName === "Refused") as unknown as {
      args: { account: Hex; kind: number; reason: Hex };
    }[];
    expect(refused).toHaveLength(1);
    expect(getAddress(refused[0].args.account)).toBe(run.a);
    const full = await why(moveA, [block]);
    console.log(
      `blocklisted (policy ${policy}, admin ${admin}): A refused ${reasonName(refused[0].args.reason)}, in full ${full}; ` +
        `A1 ran in the same perform`,
    );
    // The Guard keeps 4 bytes: a JAW account wraps every failed call in ExecuteError(index, data), so the event says
    // ExecuteError whatever failed. In full: call 2 of the batch (after the two approves), the Spoke's withdraw, which
    // the B20 refused on its receiver policy.
    expect(reasonName(refused[0].args.reason)).toBe("ExecuteError");
    expect(full).toBe(`ExecuteError(2, PolicyForbids(${TRANSFER_RECEIVER_POLICY}, ${policy}))`);
    const soldFor = events
      .filter((e) => e.eventName === "ProtectSold")
      .map((e) => getAddress((e.args as unknown as { account: Hex }).account));
    expect(soldFor).toEqual([run.a1]);
    // A's position didn't move: the whole move rolled back.
    const n = run.setup.length;
    expect(uint(supplied)).toBe(uint(run.setup[n - 3]));
    expect(uint(debt)).toBeGreaterThanOrEqual(uint(run.setup[n - 4]));
    console.log(`eth RPC requests this run: ${rpcCalls}`);
  });
});
