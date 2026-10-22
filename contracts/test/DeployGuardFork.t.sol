// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeployGuard} from "../script/DeployGuard.s.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GoosePlanner} from "../src/GoosePlanner.sol";
import {console2} from "forge-std/console2.sol";
import {ForkBase} from "./ForkBase.sol";
import {GuardHarness} from "./GuardHarness.sol";

/// The deploy script against Base: every address the Guard fixes checks out, the script's stocks and pools are the
/// Guard's own, JAW's factory deploys the clone the Guard lets register, and a deploy wires the Guard and the Planner.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract DeployGuardForkTest -vv
contract DeployGuardForkTest is ForkBase {
    DeployGuard deploy;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"), 52_946_000);
        deploy = new DeployGuard();
    }

    function test_every_address_the_guard_fixes_checks_out_on_base() public view {
        deploy.checkCode();
    }

    function test_the_scripts_stocks_and_pools_are_the_guards_own() public {
        GuardHarness h = new GuardHarness(address(this), address(1), bytes32(0));
        (address[7] memory stocks, address[7] memory pools) = deploy.stocksAndPools();
        for (uint256 r; r < 7; ++r) {
            (address stock, address pool) = h.stockAndPool(r);
            assertEq(stock, stocks[r], "a stock differs from the Guard's");
            assertEq(pool, pools[r], "a pool differs from the Guard's");
            assertEq(stock, STOCKS[r], "a stock differs from the tests'");
        }
    }

    function test_jaws_factory_deploys_the_clone_the_guard_lets_register() public {
        address account = _newJawAccount("clone");
        assertEq(account.codehash, 0xc79e2c8f7a03b38abd65a7e073fc3410849544bba74f53360c127775bc891848);
    }

    function test_a_deploy_wires_the_guard_and_the_planner() public {
        address owner = makeAddr("owner");
        vm.setEnv("GUARD_OWNER", vm.toString(owner));
        (GooseGuard guard, GoosePlanner planner) = deploy.run();
        assertEq(guard.owner(), owner);
        assertTrue(guard.isRunner(0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93), "KeeperHub isn't the runner");
        assertEq(address(planner.GUARD()), address(guard));
        assertEq(guard.SALE_FLOOR_BPS(), 300);
        assertEq(guard.SWAP_FLOOR_BPS(), 50);
        assertEq(guard.BAND_BPS(), 100);
        assertEq(guard.TIGHT_BPS(), 40);
        assertEq(guard.KEEP_BACK(), 1e6);
        assertEq(guard.DUST(), 1e6);
        assertLe(address(guard).code.length, 24_576, "over the deploy limit");
        console2.log("GooseGuard runtime bytes", address(guard).code.length);
    }
}
