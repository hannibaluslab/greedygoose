// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IERC20} from "../src/IProtocols.sol";
import {TopUps} from "../src/CashRules.sol";
import {RebalanceJob} from "../src/jobs/RebalanceJob.sol";
import {TopUpsForkBase} from "./TopUpsFork.t.sol";
import {IJustaPermissionManager as PM, IJustanAccount} from "./IJustaPermissionManager.sol";

/// Top-ups wired end to end with the app's own bytes (M5): the batch scripts/fork/top-ups-batch.ts prints is what the
/// app's TypeScript builds for Rebalance's sheet (rebalanceSave, rebalanceChange, the grants as useAgents `changePlan`
/// makes them, agentChangePlan with the allowlist), and it runs here, unchanged, as a JAW user operation on a Base
/// fork against the next executor (the real manager, Aave V3 savings and Aerodrome's stock pools, CAP_MAX the largest
/// uint160). One Face ID turns top-ups on: [earning's grant if it's off, the Rebalancer's with the savings withdraw,
/// setMix, setTopUps(true, $500), a registration for each]; a top-up is then counted by Save and goes into the mix the
/// next market morning. Turning Rebalance off is one Face ID too, [revoke, setTopUps(false)], and nothing goes in after.
///
/// It runs the app's TypeScript through tsx, so it needs the app's node_modules, Node 22 on the PATH, `--ffi` and
/// APP_BYTES=1; CI's plain `forge test` skips it:
///   APP_BYTES=1 BASE_RPC_URL=https://mainnet.base.org forge test --ffi --match-contract TopUpsAppForkTest
contract TopUpsAppForkTest is TopUpsForkBase {
    uint256 constant KEEP = 500e6;
    uint8 constant SAVE_BIT = 1 << 0;
    uint8 constant REBALANCE_BIT = 1 << 3;

    function setUp() public {
        if (!vm.envOr("APP_BYTES", false)) return;
        _setUpTopUps();
        vm.setEnv("NEXT_PUBLIC_GOOSE_EXECUTOR", vm.toString(address(x)));
    }

    /// Earning off, no mix and Rebalance off: Save on Rebalance's sheet with top-ups on is one batch that turns on
    /// earning and the Rebalancer with the withdraw, sets the mix and the switch, and registers both. A $300 top-up on
    /// Tuesday afternoon is counted by Save and goes into NVIDIA, the stock furthest below target, Wednesday at 10:00.
    function test_one_batch_turns_top_ups_on_and_a_top_up_goes_in_the_next_market_morning() public {
        vm.skip(!vm.envOr("APP_BYTES", false), "needs APP_BYTES=1 and --ffi");
        address a = _holding("app-on");
        (uint256 start, uint256 salt) = _pick(a);
        (PM.Call[] memory calls, bytes[] memory grants) = _app("on", a, start, salt, "off");
        assertEq(calls.length, 6, "two approves, setMix, setTopUps, two registrations");
        assertEq(grants.length, 2, "the Rebalancer's grant and earning's");
        _send(a, calls);

        assertEq(_jobs(a), SAVE_BIT | REBALANCE_BIT, "earning and the Rebalancer on, in one batch");
        PM.Permission memory rebalance = abi.decode(grants[0], (PM.Permission));
        assertEq(abi.encode(x.permissionOf(a, GooseExecutor.Job.Rebalance)), grants[0], "the registry holds it");
        assertEq(abi.encode(x.permissionOf(a, GooseExecutor.Job.Save)), grants[1]);
        assertEq(rebalance.spends[1].token, address(AUSDC), "the withdraw's aUSDC limit follows USDC's");
        assertEq(rebalance.calls[0].target, address(POOL), "the savings withdraw comes first");
        assertTrue(MANAGER.isApproved(rebalance));
        assertEq(x.mixes(a), RebalanceJob.mixOf(fiftyFifty), "the mix");
        TopUps memory t = _topUpsOf(a);
        assertTrue(t.on, "the account's own switch");
        assertEq(t.keep, KEEP, "Keep $500 as cash");
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "46/54, in its band: nothing to trade");

        _warpNy(0, 15 hours);
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.TopUpCounted(a, 300e6, 300e6);
        _topUp(a, 300e6);

        _warpNy(1, 10 hours - 1);
        assertEq(_check().length, 0, "Wednesday 9:59:59: never the day it arrived, nor before the window");
        _warpNy(0, 10 hours);
        GooseExecutor.Plan memory plan = x.planOf(a);
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Rebalance), "Wednesday 10:00");
        assertEq(plan.reason, RebalanceJob.INVEST, "puts top-ups in");
        assertEq(plan.amount, 300e6);

        uint256 savings = AUSDC.balanceOf(a);
        uint256 cash = USDC.balanceOf(a);
        uint256 apple = IERC20(STOCKS[AAPL]).balanceOf(a);
        uint256 nvda = IERC20(STOCKS[NVDA]).balanceOf(a);
        vm.recordLogs();
        _run(_check());
        (uint256 amount, uint256[7] memory bought) = _invested(vm.getRecordedLogs());
        assertEq(amount, 300e6, "the $300 went in");
        assertApproxEqAbs(savings - AUSDC.balanceOf(a), 300e6, 2, "from savings, give or take Aave's rounding");
        assertEq(USDC.balanceOf(a), cash, "the wallet's cash doesn't move");
        assertGt(bought[NVDA], 0, "NVIDIA, the stock furthest below its target");
        assertEq(IERC20(STOCKS[NVDA]).balanceOf(a), nvda + bought[NVDA]);
        assertEq(IERC20(STOCKS[AAPL]).balanceOf(a), apple, "Apple, over its target, untouched");
        _assertHoldsNothing();
        _holdsNoStock();
    }

    /// Earning already on: the same Save carries no grant for it, only the Rebalancer's.
    function test_with_earning_on_the_batch_grants_the_rebalancer_alone() public {
        vm.skip(!vm.envOr("APP_BYTES", false), "needs APP_BYTES=1 and --ffi");
        address a = _holding("app-saving");
        _turnOn(a, GooseExecutor.Job.Save, 1_000e6);
        (uint256 start, uint256 salt) = _pick(a);
        (PM.Call[] memory calls, bytes[] memory grants) = _app("on", a, start, salt, "on");
        assertEq(calls.length, 4, "one approve, setMix, setTopUps, one registration");
        assertEq(grants.length, 1);
        _send(a, calls);
        assertEq(_jobs(a), SAVE_BIT | REBALANCE_BIT);
        assertTrue(_topUpsOf(a).on);
    }

    /// Turn off Rebalance with top-ups on: one batch revokes its grant and switches top-ups off. A top-up after it is
    /// put away by Save and counted by nobody, and nothing goes into the mix the next morning.
    function test_turning_rebalance_off_revokes_its_grant_and_stops_top_ups_in_one_batch() public {
        vm.skip(!vm.envOr("APP_BYTES", false), "needs APP_BYTES=1 and --ffi");
        address a = _holding("app-off");
        (uint256 start, uint256 salt) = _pick(a);
        (PM.Call[] memory on, bytes[] memory grants) = _app("on", a, start, salt, "off");
        _send(a, on);

        (PM.Call[] memory off, bytes[] memory held) = _app("off", a, start, salt, "");
        assertEq(held[0], grants[0], "it revokes exactly the grant the executor runs");
        assertEq(off.length, 2, "revoke, setTopUps(false)");
        _send(a, off);
        PM.Permission memory rebalance = abi.decode(grants[0], (PM.Permission));
        assertTrue(MANAGER.isRevoked(rebalance), "revoked in JAW's manager");
        TopUps memory t = _topUpsOf(a);
        assertFalse(t.on, "top-ups off");
        assertEq(t.keep, KEEP, "Keep stays as it was");

        _warpNy(0, 15 hours);
        vm.recordLogs();
        _topUp(a, 300e6);
        assertFalse(_counted(vm.getRecordedLogs()), "Save puts it away and counts nothing");
        assertEq(uint256(_topUpsOf(a).today), 0);

        _warpNy(1, 10 hours);
        uint256 nvda = IERC20(STOCKS[NVDA]).balanceOf(a);
        uint256 apple = IERC20(STOCKS[AAPL]).balanceOf(a);
        vm.recordLogs();
        address[] memory work = _check();
        if (work.length > 0) _run(work);
        (uint256 amount,) = _invested(vm.getRecordedLogs());
        assertEq(amount, 0, "nothing goes into the mix");
        assertEq(IERC20(STOCKS[NVDA]).balanceOf(a), nvda, "no buy");
        assertEq(IERC20(STOCKS[AAPL]).balanceOf(a), apple);
    }

    // ================================================================== helpers

    /// A fresh JAW account with $4,600 of NVIDIA and $5,400 of Apple (46/54 against a 50/50 mix, inside its band),
    /// $1,000 in savings and $1 of fuel, nothing switched on.
    function _holding(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        deal(STOCKS[NVDA], a, 4_600e6 * 1e10 / _price(NVDA));
        deal(STOCKS[AAPL], a, 5_400e6 * 1e10 / _price(AAPL));
        _withSavings(a, 1_000e6);
        deal(address(USDC), a, 1e6);
        assertEq(_jobs(a), 0);
    }

    /// The grants' start and salt, as lib/agents/picks.ts picks them: five minutes behind the clock (the device's,
    /// which the allowlist holds a start to, and the fork's, which the executor runs on), and a salt of the account's.
    function _pick(address a) internal view returns (uint256 start, uint256 salt) {
        uint256 wall = vm.unixTime() / 1000;
        uint256 forkNow = vm.getBlockTimestamp();
        start = (wall < forkNow ? wall : forkNow) - 5 minutes;
        salt = uint256(keccak256(abi.encode("app bytes", a))) >> 8;
    }

    /// The app's batch for `mode`, from its own TypeScript (scripts/fork/top-ups-batch.ts), and the grants in it.
    function _app(string memory mode, address a, uint256 start, uint256 salt, string memory save)
        internal
        returns (PM.Call[] memory calls, bytes[] memory grants)
    {
        string[] memory cmd = new string[](11);
        cmd[0] = "../node_modules/.bin/tsx";
        cmd[1] = "--tsconfig";
        cmd[2] = "../tsconfig.json";
        cmd[3] = "../scripts/fork/top-ups-batch.ts";
        cmd[4] = mode;
        cmd[5] = vm.toString(a);
        cmd[6] = vm.toString(start);
        cmd[7] = vm.toString(salt);
        cmd[8] = vm.toString(uint256(x.CAP_MAX()));
        cmd[9] = _prices();
        cmd[10] = save;
        (calls, grants) = abi.decode(vm.ffi(cmd), (PM.Call[], bytes[]));
    }

    /// Aave's prices now, by reserve id, as the app reads them: 8 decimals, comma-separated.
    function _prices() internal view returns (string memory s) {
        for (uint256 r; r < 7; ++r) {
            s = string.concat(s, r == 0 ? "" : ",", vm.toString(_price(r)));
        }
    }

    /// The batch the way a JAW user operation lands: the EntryPoint calls account.executeBatch.
    function _send(address a, PM.Call[] memory calls) internal {
        vm.prank(ENTRY_POINT);
        IJustanAccount(a).executeBatch(calls);
    }
}
