// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IAeroRouter, IERC20} from "../src/IProtocols.sol";
import {EntryJob} from "../src/jobs/EntryJob.sol";
import {ExecutorForkBase} from "./GooseExecutorFork.t.sol";
import {IJustaPermissionManager as PM} from "./IJustaPermissionManager.sol";

/// The Entry agent against the real JAW manager and the real venues on a Base fork: Aerodrome's first Slipstream
/// deployment for USDT and USDbC, Uniswap v3 for USDe and Spark's PSM3 for USDS, at their live depth. Fresh JAW
/// accounts, granted the way JAW's screen grants. Plan item 2 steps 1-3: each coin becomes USDC at 99.5% or better in
/// the same wallet, a large balance is split, a swap below the floor waits, and the post-checks and the manager catch a
/// swap to someone else, a coin past its limit and a coin off the list.
contract EntryForkTest is ExecutorForkBase {
    address constant GHO = 0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee;
    bytes4 constant UNAUTHORIZED_CALL = bytes4(keccak256("JustaPermissionManager_UnauthorizedCall(address,bytes4)"));
    bytes4 constant EXCEEDED_SPEND = bytes4(keccak256("JustaPermissionManager_ExceededSpendLimit(uint256,uint256)"));

    function setUp() public {
        _fork();
        x = _deploy(_config());
    }

    // ================================================================== each coin (step 2)

    function test_each_coin_becomes_usdc_at_99_5_percent_or_better_in_the_same_wallet() public {
        for (uint256 k; k < EntryJob.COINS; ++k) {
            (address coin, uint256 decimals,) = EntryJob.coin(k);
            address a = _newJawAccount(string.concat("coin ", vm.toString(k)));
            deal(coin, a, 1_000 * 10 ** decimals);
            _entryOn(a, 1_000e6);
            GooseExecutor.Plan memory plan = x.planOf(a);
            assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Convert));
            assertEq(plan.reason, k, "this coin");
            assertEq(plan.amount, 995e6, "the floor: 99.5% of $1,000");

            vm.recordLogs();
            uint256 before = gasleft();
            _run(_check());
            uint256 gas = before - gasleft();
            (uint256 amountIn, uint256 usdcOut) = _converted(vm.getRecordedLogs());
            console.log(string.concat(IERCMeta(coin).symbol(), ": USDC out, run gas"), usdcOut, gas);
            assertEq(amountIn, 1_000 * 10 ** decimals);
            assertGe(usdcOut, 995e6, "at 99.5% or better");
            assertEq(IERC20(coin).balanceOf(a), 0, "all of it");
            assertEq(USDC.balanceOf(a), usdcOut, "to the account");
            _assertHoldsNothing();
            assertEq(IERC20(coin).balanceOf(address(x)), 0);
            assertEq(_check().length, 0, "nothing left to convert");
        }
    }

    /// A $25,000 USDT balance goes in $10,000 swaps, one a run.
    function test_a_large_balance_is_split_over_runs() public {
        GooseExecutor.Config memory c = _config();
        c.capMax = 100_000e6;
        x = _deploy(c);
        address a = _newJawAccount("whale");
        deal(EntryJob.USDT, a, 25_000e6);
        _entryOn(a, 50_000e6);
        for (uint256 i; i < 3; ++i) {
            _run(_check());
            vm.roll(vm.getBlockNumber() + 1);
        }
        assertEq(IERC20(EntryJob.USDT).balanceOf(a), 0);
        assertGe(USDC.balanceOf(a), 24_875e6);
        assertEq(_check().length, 0);
    }

    /// The day's limit holds: $3,000 of USDbC with a $1,000 limit converts $1,000 today, the rest a day later.
    function test_the_daily_limit_holds() public {
        address a = _newJawAccount("a");
        deal(EntryJob.USDBC, a, 3_000e6);
        _entryOn(a, 1_000e6);
        _run(_check());
        assertEq(IERC20(EntryJob.USDBC).balanceOf(a), 2_000e6);
        assertEq(_check().length, 0, "today's limit is used");
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        _run(_check());
        assertEq(IERC20(EntryJob.USDBC).balanceOf(a), 1_000e6);
    }

    // ================================================================== below the floor (step 2: "waiting")

    /// At a 99.9% floor Aerodrome's USDT pool (99.86%) can't fill: the swap moves nothing, the coin waits an hour, and
    /// the next coin converts meanwhile. It isn't a failure: the account's other jobs keep running.
    function test_below_the_floor_the_coin_waits_and_the_next_one_converts() public {
        GooseExecutor.Config memory c = _config();
        c.entryLimits.floorBps = 10;
        x = _deploy(c);
        address a = _newJawAccount("a");
        deal(EntryJob.USDT, a, 1_000e6);
        deal(EntryJob.USDBC, a, 500e6);
        _entryOn(a, 1_000e6);

        vm.expectEmit(true, true, false, true, address(x));
        emit GooseExecutor.EntryWaiting(a, EntryJob.USDT, 1_000e6, uint32(vm.getBlockTimestamp() + 1 hours));
        _run(_check());
        assertEq(IERC20(EntryJob.USDT).balanceOf(a), 1_000e6, "nothing moved");
        assertEq(USDC.balanceOf(a), 0);
        (,, uint8 fails,,,,,,) = x.accounts(a);
        assertEq(fails, 0, "not a failure");

        assertEq(x.planOf(a).reason, 2, "USDbC, while USDT waits");
        _run(_check());
        assertEq(IERC20(EntryJob.USDBC).balanceOf(a), 0);
        assertGe(USDC.balanceOf(a), 499.5e6);
        assertEq(_check().length, 0, "USDT waits the hour");

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.Convert), "tried again");
    }

    // ================================================================== what the post-checks and the manager catch

    function test_a_swap_to_someone_else_reverts() public {
        address a = _newJawAccount("a");
        deal(EntryJob.USDT, a, 1_000e6);
        _entryOn(a, 1_000e6);
        PM.Call[] memory calls = new PM.Call[](2);
        calls[0] = PM.Call(EntryJob.USDT, 0, abi.encodeCall(IERC20.approve, (EntryJob.AERODROME_V1_ROUTER, 1_000e6)));
        calls[1] = _aeroSwap(EntryJob.USDT, 1_000e6, attacker);
        vm.expectRevert(GooseExecutor.BelowFloor.selector);
        this.convertWith(a, EntryJob.USDT, 1_000e6, 995e6, calls);
    }

    function test_the_manager_refuses_a_coin_past_its_limit_or_off_the_list() public {
        address a = _newJawAccount("a");
        deal(EntryJob.USDT, a, 2_000e6);
        deal(GHO, a, 100e18);
        _entryOn(a, 1_000e6);
        PM.Call[] memory calls = new PM.Call[](2);
        calls[0] = PM.Call(EntryJob.USDT, 0, abi.encodeCall(IERC20.approve, (EntryJob.AERODROME_V1_ROUTER, 1_001e6)));
        calls[1] = _aeroSwap(EntryJob.USDT, 1_001e6, a);
        vm.expectPartialRevert(EXCEEDED_SPEND);
        this.convertWith(a, EntryJob.USDT, 1_001e6, 0, calls);

        calls[0] = PM.Call(GHO, 0, abi.encodeCall(IERC20.approve, (EntryJob.AERODROME_V1_ROUTER, 100e18)));
        vm.expectPartialRevert(UNAUTHORIZED_CALL);
        this.convertWith(a, GHO, 100e18, 0, calls);
    }

    function test_registration_through_the_log_trigger() public {
        address a = _newJawAccount("a");
        vm.recordLogs();
        _grantThroughAccount(_permission(a, GooseExecutor.Job.Entry, 1_000e6));
        (bool needed, bytes memory performData) = x.checkLog(_chainlinkLog(vm.getRecordedLogs()[0]), "");
        assertTrue(needed, "a JAW grant of the Entry template registers through the log trigger");
        vm.prank(forwarder);
        x.performUpkeep(performData);
        (uint8 jobs,,,,,,,,) = x.accounts(a);
        assertEq(jobs, 1 << uint8(GooseExecutor.Job.Entry));
    }

    // ================================================================== helpers

    /// Runs `calls` through the manager as the executor, with `account`'s Entry permission, under a conversion's
    /// post-checks.
    function convertWith(address account, address coin, uint256 amountIn, uint256 minOut, PM.Call[] calldata calls)
        external
    {
        PM.Permission memory p = x.permissionOf(account, GooseExecutor.Job.Entry);
        EntryJob.Before memory b = EntryJob.snapshot(x.env(), account, coin);
        vm.prank(address(x));
        MANAGER.executeBatch(p, calls);
        EntryJob.check(x.env(), account, amountIn, minOut, b);
    }

    function _entryOn(address a, uint160 cap) internal {
        _turnOn(a, GooseExecutor.Job.Entry, cap);
    }

    function _aeroSwap(address coin, uint256 amountIn, address to) internal view returns (PM.Call memory) {
        return PM.Call(
            EntryJob.AERODROME_V1_ROUTER,
            0,
            abi.encodeCall(
                IAeroRouter.exactInputSingle,
                (IAeroRouter.ExactInputSingleParams(coin, address(USDC), 1, to, block.timestamp, amountIn, 0, 0))
            )
        );
    }

    function _converted(Vm.Log[] memory logs) internal view returns (uint256 amountIn, uint256 usdcOut) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(x) && logs[i].topics[0] == GooseExecutor.EntryConverted.selector) {
                return abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        revert("no EntryConverted");
    }
}

interface IERCMeta {
    function symbol() external view returns (string memory);
}
