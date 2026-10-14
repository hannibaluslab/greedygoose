// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../src/GooseExecutor.sol";
import {Amounts, Thresholds} from "../src/CashRules.sol";
import {SellLimits} from "../src/SellRules.sol";
import {ISpoke} from "../src/IProtocols.sol";
import {DeployExecutor} from "../script/DeployExecutor.s.sol";
import {ForkBase} from "./ForkBase.sol";
import {IAeroFactory} from "./IJustaPermissionManager.sol";

/// The deploy script's Base parameters, checked on a Base fork without broadcasting anything: every address has code,
/// the stocks, oracle and pools are the spoke's and Aerodrome's own, a fresh JAW account runs code the executor
/// allows, and the defaults mirror config/risk.ts.
interface ISpokeOracle {
    function ORACLE() external view returns (address);
}

interface IRouter {
    function factory() external view returns (address);
}

contract DeployExecutorTest is ForkBase {
    address constant AERO_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;

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

    function test_a_fresh_jaw_account_runs_allowed_code() public {
        bytes32[] memory allowed = deploy.jawCodehashes();
        assertEq(_newJawAccount("alice").codehash, allowed[0], "JAW's factory proxy");
        assertEq(allowed[1], keccak256(abi.encodePacked(hex"ef0100", JAW_FACTORY.getImplementation())), "7702");
    }

    function test_defaults_mirror_config_risk() public view {
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
        assertEq(l.headsUpHf, vm.parseJsonUint(json, ".sell.headsUpHf"));
        assertEq(l.nowHf, vm.parseJsonUint(json, ".sell.nowHf"));
        assertEq(l.targetHf, vm.parseJsonUint(json, ".sell.targetHf"));
        assertEq(l.headsUpDelay, vm.parseJsonUint(json, ".sell.headsUpDelay"));
        assertEq(l.floorBps, vm.parseJsonUint(json, ".sell.floorBps"));
        assertEq(l.actFloorBps, vm.parseJsonUint(json, ".sell.actFloorBps"));
        assertEq(l.poolCap, vm.parseJsonUint(json, ".sell.poolCap"));
        assertEq(l.maxSlice, vm.parseJsonUint(json, ".sell.maxSlice"));
    }

    function test_only_base_and_base_sepolia() public {
        vm.expectRevert("Base or Base Sepolia only");
        deploy.config(1, makeAddr("owner"));
    }
}
