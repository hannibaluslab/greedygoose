// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../src/GooseExecutor.sol";
import {Amounts, Thresholds} from "../src/CashRules.sol";
import {EntryLimits} from "../src/EntryRules.sol";
import {RebalanceLimits} from "../src/RebalanceRules.sol";
import {SellLimits} from "../src/SellRules.sol";
import {IAaveOracle, IAeroFactory, ISpoke} from "../src/IProtocols.sol";
import {EntryJob} from "../src/jobs/EntryJob.sol";
import {ProtectJob} from "../src/jobs/ProtectJob.sol";
import {RebalanceJob} from "../src/jobs/RebalanceJob.sol";
import {SaveJob} from "../src/jobs/SaveJob.sol";
import {SellJob} from "../src/jobs/SellJob.sol";
import {DeployExecutor} from "../script/DeployExecutor.s.sol";
import {ForkBase} from "./ForkBase.sol";

/// The deploy script's Base parameters, checked on a Base fork without broadcasting anything: every address has code,
/// the stocks, oracle and pools are the spoke's and Aerodrome's own, a fresh JAW account runs code the executor
/// allows, and the defaults mirror config/risk.ts.
interface ISpokeOracle {
    function ORACLE() external view returns (address);
}

interface IRouter {
    function factory() external view returns (address);
}

interface IToken {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IUniswapFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IPsm3View {
    function usdc() external view returns (address);
    function usds() external view returns (address);
}

contract DeployExecutorTest is ForkBase {
    address constant AERO_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    /// lib/swap/venues.ts AERODROME_V1.FACTORY and UNISWAP.FACTORY.
    address constant AERO_V1_FACTORY = 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A;
    address constant UNISWAP_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    uint256 constant EIP_170 = 24_576;

    DeployExecutor deploy;

    function setUp() public {
        _fork();
        deploy = new DeployExecutor();
    }

    function test_base_addresses_have_code_and_match_the_app_registry() public {
        GooseExecutor.Config memory c = deploy.config(8453, makeAddr("owner"));
        assertEq(address(c.manager), address(MANAGER));
        assertEq(address(c.aaveV3Pool), address(POOL));
        assertEq(address(c.spoke), address(SPOKE));
        assertEq(address(c.usdc), address(USDC));
        assertEq(address(c.aUsdc), address(AUSDC));
        assertEq(c.usdcReserveId, USDC_RESERVE);
        assertEq(c.capMax, 5e6, "D13: $5 test deploys");
        address[5] memory needCode = [address(MANAGER), address(POOL), address(SPOKE), address(USDC), address(AUSDC)];
        for (uint256 i; i < needCode.length; ++i) {
            assertGt(needCode[i].code.length, 0);
        }
        new GooseExecutor(c); // constructs within the code-size limit and the bounds
    }

    /// Protect · sell sells each stock on its Aerodrome Slipstream pool at tick spacing 10, priced by the spoke's oracle.
    function test_stocks_oracle_and_pools_are_the_spokes_and_aerodromes_own() public {
        // Retired with GooseExecutor's deploy: its $100k-a-pool depth check fails on live pools (MSFTc's held about $57k
        // on 2026-10-22, step0-facts.md). GooseGuard pins its pools and the Planner sizes trades by depth.
        vm.skip(true);
        GooseExecutor.Config memory c = deploy.config(8453, makeAddr("owner"));
        assertEq(address(c.oracle), ISpokeOracle(address(SPOKE)).ORACLE());
        assertEq(IRouter(c.router).factory(), AERO_FACTORY);
        for (uint256 r; r < 7; ++r) {
            assertEq(c.stocks[r], STOCKS[r]);
            assertEq(ISpoke(address(SPOKE)).getReserve(r).underlying, c.stocks[r], "the spoke's reserve r");
            address pool = IAeroFactory(AERO_FACTORY).getPool(c.stocks[r], address(USDC), 10);
            assertGt(USDC.balanceOf(pool), 100_000e6, "a pool with depth");
        }
    }

    /// The executor and every job library fit under the 24 KB limit. Tests deploy ExecutorHarness, which opens a few
    /// internals on top of it, so this is the check that counts.
    function test_the_executor_and_every_job_library_fit_under_24_kb() public {
        assertLe(address(new GooseExecutor(deploy.config(8453, makeAddr("owner")))).code.length, EIP_170, "core");
        assertLe(type(SaveJob).runtimeCode.length, EIP_170);
        assertLe(type(ProtectJob).runtimeCode.length, EIP_170);
        assertLe(type(SellJob).runtimeCode.length, EIP_170);
        assertLe(type(RebalanceJob).runtimeCode.length, EIP_170);
        assertLe(type(EntryJob).runtimeCode.length, EIP_170);
    }

    /// Entry's coins and venues are fixed in EntryJob (lib/tokens/stables.ts): each coin has the symbol and decimals it
    /// should, each venue is the factory's own and holds USDC against it, and PSM3 swaps Base's USDS for Base's USDC.
    function test_entrys_coins_and_venues_are_bases_own() public {
        // Retired with GooseExecutor's deploy: its USDC-depth thresholds move with the live market (the USDT pool held
        // $62.7k at step 0 and $44k later on 2026-10-22). GooseGuard pins its venues and the Planner sizes by depth.
        vm.skip(true);
        string[4] memory symbols = ["USDT", "USDe", "USDbC", "USDS"];
        for (uint256 k; k < EntryJob.COINS; ++k) {
            (address coin, uint256 decimals, EntryJob.Venue venue) = EntryJob.coin(k);
            assertEq(IToken(coin).symbol(), symbols[k]);
            assertEq(IToken(coin).decimals(), decimals);
            address pool;
            if (venue == EntryJob.Venue.Aerodrome) {
                pool = IAeroFactory(AERO_V1_FACTORY).getPool(coin, address(USDC), EntryJob.STABLE_TICK_SPACING);
            } else if (venue == EntryJob.Venue.Uniswap) {
                pool = IUniswapFactory(UNISWAP_FACTORY).getPool(coin, address(USDC), EntryJob.USDE_FEE);
            } else {
                pool = EntryJob.PSM3;
            }
            assertGt(USDC.balanceOf(pool), 50_000e6, string.concat(symbols[k], ": USDC to swap into"));
        }
        assertEq(IRouter(EntryJob.AERODROME_V1_ROUTER).factory(), AERO_V1_FACTORY);
        assertEq(IRouter(EntryJob.UNISWAP_ROUTER).factory(), UNISWAP_FACTORY);
        assertEq(IPsm3View(EntryJob.PSM3).usdc(), address(USDC));
        assertEq(IPsm3View(EntryJob.PSM3).usds(), EntryJob.USDS);
    }

    function test_a_fresh_jaw_account_runs_allowed_code() public {
        bytes32[] memory allowed = deploy.jawCodehashes();
        assertEq(_newJawAccount("alice").codehash, allowed[0], "JAW's factory proxy");
        assertEq(allowed[1], keccak256(abi.encodePacked(hex"ef0100", JAW_FACTORY.getImplementation())), "7702");
    }

    /// A never-used account starts earning in one batch whose registration can't be simulated, so the executor must
    /// allow JAW's account clone (DEPLOYMENTS.md, "Check after the next deploy"). The script's own run on a Base fork:
    /// the executor it deploys allows it, read back; a list without it is refused before anything is sent.
    function test_the_script_deploys_an_executor_that_allows_jaws_account_clone() public {
        bytes32 clone = deploy.JAW_CLONE_CODEHASH();
        assertEq(clone, 0xc79e2c8f7a03b38abd65a7e073fc3410849544bba74f53360c127775bc891848, "measured on Base");
        assertEq(deploy.jawCodehashes()[0], clone, "the EIP-1167 clone of JAW's implementation");
        assertEq(_newJawAccount("alice").codehash, clone, "what JAW's factory deploys at this block");

        vm.setEnv("EXECUTOR_OWNER", vm.toString(makeAddr("owner")));
        GooseExecutor x = deploy.run();
        assertTrue(x.allowedCodehash(clone), "the deployed executor allows it");

        GooseExecutor.Config memory c = deploy.config(8453, makeAddr("owner"));
        bytes32[] memory only7702 = new bytes32[](1);
        only7702[0] = c.codehashes[1];
        c.codehashes = only7702;
        vm.expectRevert("JAW's account clone isn't allowed");
        deploy.checkCode(c);
    }

    function test_defaults_mirror_config_risk() public {
        // Retired: the app's minimums are 0 now (no minimum anywhere, GooseGuard), while GooseExecutor's deploy keeps
        // its old ones.
        vm.skip(true);
        string memory json = vm.readFile("test/vectors/defaults.json");
        Thresholds memory t = deploy.thresholds();
        Amounts memory a = deploy.amounts();
        assertEq(t.triggerHf, vm.parseJsonUint(json, ".triggerHf"));
        assertEq(t.targetHf, vm.parseJsonUint(json, ".targetHf"));
        assertEq(t.stressDrop, vm.parseJsonUint(json, ".stressDrop"));
        assertEq(t.stressFloorHf, vm.parseJsonUint(json, ".stressFloorHf"));
        assertEq(a.minRepay, vm.parseJsonUint(json, ".minRepay"));
        assertEq(a.minSave, vm.parseJsonUint(json, ".minSave"));
        assertEq(a.keepBack, vm.parseJsonUint(json, ".keepBack"));
        assertEq(a.weekendWindow, vm.parseJsonUint(json, ".weekendWindow"));
        assertEq(a.maxSavesPerDay, vm.parseJsonUint(json, ".maxSavesPerDay"));
        SellLimits memory l = deploy.sellLimits();
        assertEq(l.floorBps, vm.parseJsonUint(json, ".sell.floorBps"));
        assertEq(l.poolCap, vm.parseJsonUint(json, ".sell.poolCap"));
        assertEq(l.maxSlice, vm.parseJsonUint(json, ".sell.maxSlice"));
        RebalanceLimits memory r = deploy.rebalanceLimits();
        assertEq(r.bandBps, vm.parseJsonUint(json, ".rebalance.bandBps"));
        assertEq(r.bandMaxBps, vm.parseJsonUint(json, ".rebalance.bandMaxBps"));
        assertEq(r.poolGapBps, vm.parseJsonUint(json, ".rebalance.poolGapBps"));
        assertEq(r.floorBps, vm.parseJsonUint(json, ".rebalance.floorBps"));
        assertEq(r.minTrade, vm.parseJsonUint(json, ".rebalance.minTrade"));
        assertEq(r.maxSlice, vm.parseJsonUint(json, ".rebalance.maxSlice"));
        EntryLimits memory e = deploy.entryLimits();
        assertEq(e.floorBps, vm.parseJsonUint(json, ".entry.floorBps"));
        assertEq(e.minEntry, vm.parseJsonUint(json, ".entry.minEntry"));
        assertEq(e.maxSwap, vm.parseJsonUint(json, ".entry.maxSwap"));
    }

    /// The script refuses to deploy unless every address it uses has code (the seven stocks, JAW's factory and
    /// implementation, and Entry's coins and venues included) and, on Base, the stocks, USDC and the oracle are the
    /// spoke's own.
    function test_the_script_checks_every_address_before_it_deploys() public {
        GooseExecutor.Config memory c = deploy.config(8453, makeAddr("owner"));
        deploy.checkCode(c);

        c.stocks[3] = makeAddr("no stock here");
        vm.expectRevert("no code at a configured address");
        deploy.checkCode(c);

        c = deploy.config(8453, makeAddr("owner"));
        (c.stocks[0], c.stocks[1]) = (c.stocks[1], c.stocks[0]);
        vm.expectRevert("a stock isn't the spoke's reserve");
        deploy.checkCode(c);

        c = deploy.config(8453, makeAddr("owner"));
        c.oracle = IAaveOracle(address(USDC)); // code, but not the spoke's oracle
        vm.expectRevert("the oracle isn't the spoke's");
        deploy.checkCode(c);
    }

    /// A test deploy caps every limit at $5 (D13); EXECUTOR_CAPS=none deploys with no amount limit (Adrian, 2026-10-19).
    function test_test_deploys_cap_at_5_dollars_and_production_has_no_amount_limit() public {
        assertEq(deploy.capMax(), 5e6);
        vm.setEnv("EXECUTOR_CAPS", "none");
        assertEq(deploy.capMax(), type(uint160).max);
        vm.setEnv("EXECUTOR_CAPS", "test");
        assertEq(deploy.capMax(), 5e6);
    }

    function test_only_base_and_base_sepolia() public {
        vm.expectRevert("Base or Base Sepolia only");
        deploy.config(1, makeAddr("owner"));
    }
}
