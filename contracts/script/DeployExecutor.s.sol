// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IJustaPermissionManager} from "../src/IJustaPermissionManager.sol";
import {IAaveV3Pool, IERC20, ISpoke} from "../src/IProtocols.sol";
import {Amounts, Thresholds} from "../src/CashRules.sol";
import {EntryLimits} from "../src/EntryRules.sol";
import {RebalanceLimits} from "../src/RebalanceRules.sol";
import {SellLimits} from "../src/SellRules.sol";
import {IAaveOracle, IAeroRouter} from "../src/IProtocols.sol";
import {EntryJob} from "../src/jobs/EntryJob.sol";

interface ISpokeOracle {
    function ORACLE() external view returns (address);
}

interface IJawAccountFactory {
    function getImplementation() external view returns (address);
}

/// Deploys GooseExecutor. By default a D13 test deploy: daily limits of at most $5, for throwaway accounts, never wired
/// into the production app config. EXECUTOR_CAPS=none deploys with no amount limit (CAP_MAX = the largest uint160),
/// as production will once the audit is done (plan item 6; Adrian, 2026-10-19: Protect is limited by what it does).
///
///   EXECUTOR_OWNER=<multisig> forge script script/DeployExecutor.s.sol --rpc-url <base or base sepolia> --broadcast
///
/// forge deploys each job library in src/jobs first and links its address into the executor (GooseExecutor-as-built.md,
/// "Job modules").
///
/// Then the runners (runner switch plan, step 5), in one session:
///   1. deploy GooseReceiver for the CRE workflow (script/DeployReceiver.s.sol);
///   2. read the KeeperHub workflow wallet's address;
///   3. the owner calls bootstrap([receiver, KeeperHub wallet]) once, with both: bootstrap closes for good, and any
///      later runner waits the 7-day delay;
///   4. queue the NYSE holidays (each waits 7 days, so the same day).
///   A run is `performUpkeep(performData)` with `checkUpkeep(abi.encode(shard, shards))`'s or
///   `checkProtect(shard, shards)`'s answer, at a gas limit of 5,000,000: a sale needs up to about 4.0M (seven stocks,
///   six slices: ProtectSellSevenStockGasForkTest); with less, sales are deferred (the accounts after them still run).
///   A registration is `registerApproved(data)` with a PermissionApproved event's data as logged, read first through
///   `registrationOf(data)` (about 480k gas cold for Protect · sell on all seven stocks).
///
/// Base Sepolia has JAW's manager and factory (same code and addresses as Base) but no Aave, no Coinbase USDC, no
/// equities hub and no stock pools, so a Sepolia deploy only proves the Chainlink plumbing: it takes stand-ins for
/// those from SEPOLIA_AAVE_V3_POOL, SEPOLIA_SPOKE, SEPOLIA_USDC, SEPOLIA_AUSDC, SEPOLIA_ORACLE, SEPOLIA_ROUTER and
/// SEPOLIA_STOCKS (seven addresses, comma-separated). Entry's coins and venues are Base mainnet's, fixed in EntryJob,
/// so a Sepolia deploy has no Entry.
contract DeployExecutor is Script {
    uint256 internal constant BASE = 8453;
    uint256 internal constant BASE_SEPOLIA = 84532;

    /// lib/protocols/config.ts; the same 14,180 bytes at the same address on Base Sepolia (MANAGER-NOTES).
    address internal constant MANAGER = 0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8;
    /// JAW's factory `getImplementation()` on Base and Base Sepolia, read 2026-10-14.
    address internal constant JAW_ACCOUNT = 0xbb4f7d5418Cd8DADB61bb95561179e517572cBCd;
    /// JAW's account factory on Base and Base Sepolia (ACCOUNT_RECIPE_V1's factory in JAW's core SDK 1.6.3).
    address internal constant JAW_FACTORY = 0x5803c076563C85799989d42Fc00292A8aE52fa9E;
    /// The code of every account JAW's factory deploys, the EIP-1167 clone of JAW_ACCOUNT (jawCodehashes()[0]). Read on
    /// Base on 2026-10-20 through a keyless RPC: `cast codehash` of 0x14087c53…59eA, a passkey account the factory made
    /// with owners [passkey, manager]. An account JAW hasn't deployed yet starts earning in one batch the factory deploys
    /// it in first, and that batch's registration can't be simulated (JUSTALAB-DECISIONS.md, "One Face ID for a
    /// never-used account too"): an executor without this hash would revert the whole batch. The deploy refuses to go
    /// without it (checkCode, run).
    bytes32 public constant JAW_CLONE_CODEHASH = 0xc79e2c8f7a03b38abd65a7e073fc3410849544bba74f53360c127775bc891848;
    /// lib/protocols/config.ts, lib/aave/addresses.ts, lib/tokens/registry.ts (verified on-chain 2026-10-12/13).
    address internal constant BASE_AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant BASE_SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_AUSDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    /// The spoke's ORACLE() and Aerodrome Slipstream's router (lib/aave/addresses.ts, lib/swap/venues.ts).
    address internal constant BASE_ORACLE = 0xaBaf048fD7675Ea34a84332371ffd5D55E322A47;
    address internal constant BASE_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    uint256 internal constant USDC_RESERVE_ID = 7;

    /// D13: test deploys cap every daily limit at $5.
    uint160 internal constant TEST_CAP_MAX = 5e6;
    /// No amount limit: Protect is limited by what it does, back to its target (Adrian, 2026-10-19).
    uint160 internal constant NO_CAP_MAX = type(uint160).max;
    /// Accounts per check page, from the worst case measured on a Base fork (ExecutorPageForkTest): accounts that each
    /// owe against all seven stocks, sit in Watch with too little savings to repay from, and have Protect · sell and
    /// Save on too, cost about 251k gas each to check, cold, so 32 of them fit under 8.5M of Base's 10M check limit.
    uint32 internal constant PAGE_SIZE = 32;

    function run() external returns (GooseExecutor executor) {
        GooseExecutor.Config memory c = config(block.chainid, vm.envAddress("EXECUTOR_OWNER"));
        checkCode(c);
        vm.startBroadcast();
        executor = new GooseExecutor(c);
        vm.stopBroadcast();
        // Read back from the executor itself; forge runs this before it sends anything, so a miss sends nothing.
        require(executor.allowedCodehash(JAW_CLONE_CODEHASH), "the executor doesn't allow JAW's account clone");
    }

    /// Before anything is sent: every address the executor is deployed with or its job libraries fix has code (the
    /// manager, Aave, USDC and aUSDC, the oracle, the router, the seven stocks, and JAW's factory and the account
    /// implementation behind the allowed codehashes); the allowed codehashes include JAW's account clone, and JAW's
    /// factory still clones that implementation; and on Base Aerodrome's pool factory, Entry's coins and venues, and the
    /// stocks, USDC and the oracle are the spoke's own.
    function checkCode(GooseExecutor.Config memory c) public view {
        address[16] memory need = [
            address(c.manager),
            address(c.aaveV3Pool),
            address(c.spoke),
            address(c.usdc),
            address(c.aUsdc),
            address(c.oracle),
            c.router,
            JAW_ACCOUNT,
            JAW_FACTORY,
            c.stocks[0],
            c.stocks[1],
            c.stocks[2],
            c.stocks[3],
            c.stocks[4],
            c.stocks[5],
            c.stocks[6]
        ];
        for (uint256 i; i < need.length; ++i) {
            require(need[i].code.length > 0, "no code at a configured address");
        }
        bool clone;
        for (uint256 i; i < c.codehashes.length; ++i) {
            clone = clone || c.codehashes[i] == JAW_CLONE_CODEHASH;
        }
        require(clone, "JAW's account clone isn't allowed");
        require(IJawAccountFactory(JAW_FACTORY).getImplementation() == JAW_ACCOUNT, "JAW's factory clones other code");
        if (block.chainid != BASE) return; // Sepolia's stand-ins have no Entry, no spoke reserves and no pools
        require(IAeroRouter(c.router).factory().code.length > 0, "no code at a configured address");
        for (uint256 k; k < EntryJob.COINS; ++k) {
            (address coin,,) = EntryJob.coin(k);
            require(coin.code.length > 0, "no code at a configured address");
        }
        address[3] memory venues = [EntryJob.AERODROME_V1_ROUTER, EntryJob.UNISWAP_ROUTER, EntryJob.PSM3];
        for (uint256 i; i < venues.length; ++i) {
            require(venues[i].code.length > 0, "no code at a configured address");
        }
        require(ISpokeOracle(address(c.spoke)).ORACLE() == address(c.oracle), "the oracle isn't the spoke's");
        require(c.spoke.getReserve(c.usdcReserveId).underlying == address(c.usdc), "USDC isn't the spoke's reserve");
        for (uint256 r; r < 7; ++r) {
            require(c.spoke.getReserve(r).underlying == c.stocks[r], "a stock isn't the spoke's reserve");
        }
    }

    function config(uint256 chainId, address owner) public view returns (GooseExecutor.Config memory c) {
        if (chainId == BASE) {
            c.aaveV3Pool = IAaveV3Pool(BASE_AAVE_V3_POOL);
            c.spoke = ISpoke(BASE_SPOKE);
            c.usdc = IERC20(BASE_USDC);
            c.aUsdc = IERC20(BASE_AUSDC);
            c.oracle = IAaveOracle(BASE_ORACLE);
            c.router = BASE_ROUTER;
            c.stocks = baseStocks();
        } else if (chainId == BASE_SEPOLIA) {
            c.aaveV3Pool = IAaveV3Pool(vm.envAddress("SEPOLIA_AAVE_V3_POOL"));
            c.spoke = ISpoke(vm.envAddress("SEPOLIA_SPOKE"));
            c.usdc = IERC20(vm.envAddress("SEPOLIA_USDC"));
            c.aUsdc = IERC20(vm.envAddress("SEPOLIA_AUSDC"));
            c.oracle = IAaveOracle(vm.envAddress("SEPOLIA_ORACLE"));
            c.router = vm.envAddress("SEPOLIA_ROUTER");
            address[] memory s = vm.envAddress("SEPOLIA_STOCKS", ",");
            require(s.length == 7, "SEPOLIA_STOCKS needs seven addresses");
            for (uint256 r; r < 7; ++r) {
                c.stocks[r] = s[r];
            }
        } else {
            revert("Base or Base Sepolia only");
        }
        c.manager = IJustaPermissionManager(MANAGER);
        c.usdcReserveId = USDC_RESERVE_ID;
        c.capMax = capMax();
        c.pageSize = PAGE_SIZE;
        c.owner = owner;
        c.codehashes = jawCodehashes();
        c.thresholds = thresholds();
        c.amounts = amounts();
        c.sellLimits = sellLimits();
        c.rebalanceLimits = rebalanceLimits();
        c.entryLimits = entryLimits();
    }

    /// $5 (D13) unless EXECUTOR_CAPS=none.
    function capMax() public view returns (uint160) {
        return keccak256(bytes(vm.envOr("EXECUTOR_CAPS", string("test")))) == keccak256("none") ? NO_CAP_MAX : TEST_CAP_MAX;
    }

    /// The seven stocks on Base, by reserve id (lib/tokens/registry.ts, verified against spoke.getReserve(r)).
    function baseStocks() public pure returns (address[7] memory) {
        return [
            0xb200000000000000000000C2e324d24d7eEcd1fb, // AAPLc
            0xb200000000000000000000d9192b6B456483C2E8, // AMZNc
            0xb2000000000000000000002D0BA3164cc74f58B7, // GOOGLc
            0xb2000000000000000000008bC8786B856E61707C, // METAc
            0xB200000000000000000000Ab99cFa739E253872B, // MSFTc
            0xb20000000000000000000078ee7ce2fE4908108C, // NVDAc
            0xb2000000000000000000001e800a7f5189430cD0 // TSLAc
        ];
    }

    /// The code a JAW account runs: the ERC-1167 proxy JAW's factory deploys (JAW_CLONE_CODEHASH, as read on Base), or
    /// an EIP-7702 delegation to the same implementation.
    function jawCodehashes() public pure returns (bytes32[] memory h) {
        h = new bytes32[](2);
        h[0] = keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", JAW_ACCOUNT, hex"5af43d82803e903d91602b57fd5bf3"));
        h[1] = keccak256(abi.encodePacked(hex"ef0100", JAW_ACCOUNT));
    }

    /// config/risk.ts CASH_AGENT (checked by test/DeployExecutor.t.sol). Protect acts below 1.03 (its line), savings
    /// first, then selling, back to 1.12 (Adrian, 2026-10-19). The weekend card tests a 15% drop against Aave's line
    /// (1.0). Before, 1.10 back to 1.20 (2026-10-15), and 1.50 back to 1.65.
    function thresholds() public pure returns (Thresholds memory) {
        return Thresholds({triggerHf: 1.03e18, targetHf: 1.12e18, stressDrop: 0.15e18, stressFloorHf: 1e18});
    }

    /// config/risk.ts CASH_AGENT and CASH.keepBackUsd (checked by test/DeployExecutor.t.sol).
    function amounts() public pure returns (Amounts memory) {
        return Amounts({minRepay: 0.05e6, minSave: 1e6, keepBack: 1e6, weekendWindow: 6 hours, maxSavesPerDay: 6});
    }

    /// config/risk.ts PROTECT_SELL (checked by test/DeployExecutor.t.sol). Every sale is at once now, so it takes the
    /// urgent floor, 3% under Aave's price (Adrian, 2026-10-19); before, 1% after a heads-up and 3% at once.
    function sellLimits() public pure returns (SellLimits memory) {
        return SellLimits({floorBps: 300, poolCap: 10_000e6, maxSlice: 5_000e6});
    }

    /// config/risk.ts REBALANCER (checked by test/DeployExecutor.t.sol).
    function rebalanceLimits() public pure returns (RebalanceLimits memory) {
        return RebalanceLimits({
            bandBps: 2_000, bandMaxBps: 500, poolGapBps: 50, floorBps: 50, minTrade: 20e6, maxSlice: 25_000e6
        });
    }

    /// config/risk.ts ENTRY (checked by test/DeployExecutor.t.sol).
    function entryLimits() public pure returns (EntryLimits memory) {
        return EntryLimits({floorBps: 50, minEntry: 1e6, maxSwap: 10_000e6});
    }
}
