// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../src/GooseExecutor.sol";
import {Amounts, Thresholds} from "../src/CashRules.sol";
import {DeployExecutor} from "../script/DeployExecutor.s.sol";
import {ForkBase} from "./ForkBase.sol";

/// The deploy script's Base parameters, checked on a Base fork without broadcasting anything: every address has code,
/// a fresh JAW account runs code the executor allows, and the defaults mirror config/risk.ts.
contract DeployExecutorTest is ForkBase {
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
    }

    function test_only_base_and_base_sepolia() public {
        vm.expectRevert("Base or Base Sepolia only");
        deploy.config(1, makeAddr("owner"));
    }
}
