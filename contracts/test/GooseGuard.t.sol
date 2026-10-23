// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {IJustaPermissionManager as PM} from "../src/IJustaPermissionManager.sol";
import {
    IAaveOracle,
    IAaveV3Pool,
    IAeroPool,
    IAeroRouter,
    IChainlinkFeed,
    IERC20,
    IPsm3,
    ISpoke,
    IUniswapRouter
} from "../src/IProtocols.sol";
import {FakeAccount} from "./FakeAccount.sol";
import {GuardHarness} from "./GuardHarness.sol";

/// No fork: the perform frame (who may send, the gas gate, the 4-byte revert copy), registration, the splice into
/// `executeBatch`, every setting, the owner's 48-hour queue, the pause by kind, each move's own rules on mocked reads,
/// and the constructor's bounds (spec-final-v2 §14, item 1). JAW's manager is a stand-in etched at its real address
/// that records the batch it is handed; Aave, the tokens, the pools and the EUR/USD feed are mocked; a FakeAccount
/// stands in for a JAW account. Real batches against Aave and the pools are in the fork suites.
contract GooseGuardTest is Test {
    address constant MANAGER = 0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8;
    address constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant AUSDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address constant KEEPERHUB = 0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93;
    address constant ORACLE = 0xaBaf048fD7675Ea34a84332371ffd5D55E322A47;
    address constant V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address constant AERODROME_V1_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address constant UNISWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant PSM3 = 0x1601843c5E9bC251A3272907010AFa41Fa18347E;
    address constant EUR_USD = 0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F;
    /// Every stock at $100 on Aave in the TRADE and SELL tests, 8 decimals.
    uint256 constant PRICE = 100e8;
    /// KeeperHub's write is 5.5M; about 5.4M reaches the Guard (tests.md trap 7).
    uint256 constant KH_GAS = 5_400_000;
    /// `members` and `accounts` (forge inspect GooseGuard storageLayout).
    uint256 constant MEMBERS_SLOT = 4;
    uint256 constant ACCOUNTS_SLOT = 5;

    uint8 constant SAVE = 0;
    uint8 constant REPAY = 1;
    uint8 constant SELL = 2;
    uint8 constant TRADE = 3;
    uint8 constant CONVERT = 4;
    uint8 constant END = 5;
    uint8 constant REFRESH = 6;
    uint8 constant JOB_SAVE = 0;
    uint8 constant JOB_PROTECT = 1;
    uint8 constant JOB_SELL = 2;
    uint8 constant JOB_REBALANCE = 3;
    uint8 constant JOB_ENTRY = 4;
    uint8 constant ADD_RUNNER = 0;
    uint8 constant REMOVE_RUNNER = 1;
    uint8 constant ALLOW_CODEHASH = 2;
    uint8 constant DISALLOW_CODEHASH = 3;
    uint8 constant SET_OWNER = 4;

    bytes32 constant REFUSED = keccak256("Refused(address,uint8,bytes4)");
    /// What a move that ran comes to in `_outcomes`: the first 4 bytes of its own event's topic.
    bytes4 constant ENDED = bytes4(keccak256("RescueEnded(address)"));
    bytes4 constant REPAID = bytes4(keccak256("ProtectRepaid(address,uint256,uint256,uint256,uint256)"));
    bytes4 constant SAVED = bytes4(keccak256("Saved(address,uint256)"));
    bytes4 constant REBALANCED = bytes4(keccak256("Rebalanced(address,uint256[7],uint256[7])"));
    bytes4 constant INVESTED = bytes4(keccak256("TopUpInvested(address,uint256,uint256[7])"));
    bytes4 constant CONVERTED = bytes4(keccak256("EntryConverted(address,address,uint256,uint256)"));
    bytes4 constant REFRESHED = bytes4(keccak256("ConfigRefreshed(address,uint256,uint256)"));

    GooseGuard g;
    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");
    address helper = makeAddr("helper");
    /// Two contracts with the allowed codehash, standing in for JAW accounts.
    address account;
    address other;

    function setUp() public {
        vm.warp(1_792_600_000); // Wed 2026-10-21
        account = address(new FakeAccount(false));
        other = address(new FakeAccount(false));
        g = new GooseGuard(owner, KEEPERHUB, account.codehash, 300, 50, 100, 1e6, 1e6);
        vm.etch(MANAGER, type(ManagerDouble).runtimeCode);
    }

    // ================================================================== construction

    function test_the_constructor_refuses_each_number_out_of_bounds_and_takes_its_edges() public {
        _deploys(owner, KEEPERHUB, [uint256(100), 30, 25, 0.6e6, 0]);
        _deploys(owner, KEEPERHUB, [uint256(500), 50, 200, 5e6, 10e6]);

        _refused(owner, KEEPERHUB, [uint256(99), 50, 100, 1e6, 1e6]);
        _refused(owner, KEEPERHUB, [uint256(501), 50, 100, 1e6, 1e6]);
        _refused(owner, KEEPERHUB, [uint256(300), 29, 100, 1e6, 1e6]);
        _refused(owner, KEEPERHUB, [uint256(300), 51, 100, 1e6, 1e6]);
        _refused(owner, KEEPERHUB, [uint256(300), 50, 24, 1e6, 1e6]);
        _refused(owner, KEEPERHUB, [uint256(300), 50, 201, 1e6, 1e6]);
        _refused(owner, KEEPERHUB, [uint256(300), 50, 100, 0.6e6 - 1, 1e6]);
        _refused(owner, KEEPERHUB, [uint256(300), 50, 100, 5e6 + 1, 1e6]);
        _refused(owner, KEEPERHUB, [uint256(300), 50, 100, 1e6, 10e6 + 1]);
        _refused(address(0), KEEPERHUB, [uint256(300), 50, 100, 1e6, 1e6]);
        _refused(owner, address(0), [uint256(300), 50, 100, 1e6, 1e6]);
    }

    function test_it_starts_with_the_owner_keeperhub_as_the_only_runner_and_the_clone_codehash() public view {
        assertEq(g.owner(), owner);
        assertFalse(g.paused());
        assertTrue(g.isRunner(KEEPERHUB));
        assertFalse(g.isRunner(owner), "the owner isn't a runner");
        assertTrue(g.codehashOk(account.codehash));
        assertEq(g.SALE_FLOOR_BPS(), 300);
        assertEq(g.SWAP_FLOOR_BPS(), 50);
        assertEq(g.BAND_BPS(), 100);
        assertEq(g.KEEP_BACK(), 1e6);
        assertEq(g.DUST(), 1e6);
        assertEq(g.membersLength(), 0);
    }

    /// The deploy limit is the hard gate here. Spec v2 §11's 16,384 (ceiling 18,432) is logged, not asserted: step 1
    /// projects the full Guard at 18.5–19.5 KB.
    function test_the_guard_fits_the_deploy_limit() public view {
        console2.log("GooseGuard runtime bytes", address(g).code.length);
        assertLe(address(g).code.length, 24_576);
    }

    // ================================================================== the perform frame

    /// KeeperHub, the account itself and the one helper it chose may send its moves; anyone else's move is skipped,
    /// move by move, with no event. A move that gets past the check is refused here for its empty args instead.
    function test_keeperhub_the_account_and_its_chosen_helper_may_send_its_moves_and_no_one_else() public {
        GooseGuard.Move[] memory repay = _moves(account, REPAY, 0);
        assertEq(_perform(KEEPERHUB, repay)[0], GooseGuard.BadArgs.selector, "KeeperHub");
        assertEq(_perform(account, repay)[0], GooseGuard.BadArgs.selector, "the account itself");
        assertEq(_perform(helper, repay).length, 0, "a helper not chosen yet");
        assertEq(_perform(owner, repay).length, 0, "the owner");
        assertEq(_perform(other, repay).length, 0, "another account");

        // A stranger's move is skipped with no event: nobody can write refusals for someone else (review finding 3).
        vm.recordLogs();
        vm.prank(stranger);
        g.performUpkeep(abi.encode(repay));
        assertEq(vm.getRecordedLogs().length, 0, "a stranger's move left an event");

        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.RunnerSet(account, helper);
        vm.prank(account);
        g.setRunner(helper);
        address runner = _acct(account).runner;
        assertEq(runner, helper);
        assertEq(_perform(helper, repay)[0], GooseGuard.BadArgs.selector, "the chosen helper");
        assertEq(_perform(helper, _moves(other, REPAY, 0)).length, 0, "for that account only");

        vm.prank(account);
        g.setRunner(address(0));
        assertEq(_perform(helper, repay).length, 0, "a helper let go");
    }

    /// The check is per move: one perform can carry a sender's own move and someone else's.
    function test_who_may_send_is_checked_move_by_move() public {
        GooseGuard.Move[] memory moves = _and(_moves(other, REPAY, 0), account, REPAY, 0);
        bytes4[] memory out = _perform(other, moves);
        assertEq(out.length, 1, "someone else's move is skipped with no event");
        assertEq(out[0], GooseGuard.BadArgs.selector, "its own move");
    }

    function test_anyone_may_send_END() public {
        assertEq(_perform(stranger, _moves(account, END, 0))[0], GooseGuard.NotNeeded.selector, "no rescue on");
        _startRescue(account, _now() - 8 days);
        assertEq(_perform(stranger, _moves(account, END, 0))[0], ENDED, "a stale rescue, ended by a stranger");
        uint32 rescueAt = _acct(account).rescueAt;
        assertEq(rescueAt, 0);
    }

    /// END: a rescue ends when nothing is owed, when health is back at the target (give or take 0.001), or a second
    /// after its 7 days, and only then. Past 7 days it doesn't even read Aave.
    function test_END_ends_a_rescue_that_is_done_or_older_than_7_days_and_no_other() public {
        uint256 t = _now();
        _startRescue(account, t - 1 hours);
        _mockAave(account, 100e6, 1.1e18);
        assertEq(_perform(stranger, _moves(account, END, 0))[0], GooseGuard.RescueOn.selector, "short of 1.12");

        _mockAave(account, 100e6, 1.119e18);
        assertEq(_perform(stranger, _moves(account, END, 0))[0], ENDED, "at the target, less 0.001");

        _startRescue(account, t - 1 hours);
        _mockAave(account, 0, type(uint256).max);
        assertEq(_perform(stranger, _moves(account, END, 0))[0], ENDED, "nothing owed");

        _startRescue(account, t - 1 hours);
        _mockAave(account, 100e6, 1.1e18);
        vm.prank(account);
        g.setProtect(10_300, 11_000);
        assertEq(_perform(stranger, _moves(account, END, 0))[0], ENDED, "at the account's own target, 1.10");

        _startRescue(account, t - 7 days);
        vm.prank(account);
        g.setProtect(0, 0);
        assertEq(_perform(stranger, _moves(account, END, 0))[0], GooseGuard.RescueOn.selector, "7 days to the second");

        _startRescue(account, t - 7 days - 1);
        vm.clearMockedCalls();
        vm.etch(SPOKE, type(GasSink).runtimeCode); // any read of Aave would burn the frame
        assertEq(_perform(stranger, _moves(account, END, 0))[0], ENDED, "a second past 7 days");
    }

    function test_an_unknown_kind_is_refused_with_BadKind() public {
        assertEq(_perform(KEEPERHUB, _moves(account, 7, 0))[0], GooseGuard.BadKind.selector);
        assertEq(_perform(KEEPERHUB, _moves(account, 255, 0))[0], GooseGuard.BadKind.selector);
        assertEq(_perform(stranger, _moves(account, 255, 0)).length, 0, "only END is open");
    }

    function test_only_the_guard_itself_may_call_run() public {
        GooseGuard.Move memory m = GooseGuard.Move(account, END, new uint256[](0));
        address[4] memory callers = [stranger, owner, KEEPERHUB, account];
        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(GooseGuard.OnlySelf.selector);
            vm.prank(callers[i]);
            g.run(m);
        }
    }

    /// The gate needs the move's cap × 64/63 plus 60k for the loop. Short of it, the move is refused with NoGas and
    /// the next, smaller move still runs.
    function test_a_move_short_of_gas_is_refused_with_NoGas_and_the_next_move_still_runs() public {
        _startRescue(other, _now() - 8 days);
        GooseGuard.Move[] memory moves = _and(_moves(account, REPAY, 2), other, END, 0);
        bytes4[] memory out = _perform(KEEPERHUB, moves, g.capOf(REPAY, new uint256[](2)));
        assertEq(out.length, 2);
        assertEq(out[0], GooseGuard.NoGas.selector);
        assertEq(out[1], ENDED, "END fits in what's left");
    }

    /// A smaller repay may still fit after a big sale is refused for gas (spec §4.0, step 2).
    function test_a_repay_still_runs_after_a_sale_too_big_for_the_gas_left() public {
        GooseGuard.Move[] memory moves = _and(_moves(account, SELL, 6), account, REPAY, 0);
        bytes4[] memory out = _perform(KEEPERHUB, moves, 1_500_000);
        assertEq(out[0], GooseGuard.NoGas.selector, "the sale's cap is 3.16M");
        assertEq(out[1], GooseGuard.BadArgs.selector, "the repay ran");
    }

    function test_with_its_cap_and_the_loops_share_a_move_gets_past_the_gas_gate() public {
        uint256 need = g.capOf(REPAY, new uint256[](0)) * 64 / 63 + 60_000;
        assertEq(_perform(KEEPERHUB, _moves(account, REPAY, 0), need + 50_000)[0], GooseGuard.BadArgs.selector);
    }

    /// A move that burns all its gas uses its cap and no more, gives no reason, and the next move runs.
    function test_a_move_that_burns_all_its_gas_is_held_to_its_cap_and_the_next_move_runs() public {
        vm.etch(SPOKE, type(GasSink).runtimeCode);
        _startRescue(other, _now() - 8 days);
        GooseGuard.Move[] memory moves = _and(_moves(account, REPAY, 2), other, END, 0);
        uint256 cap = g.capOf(REPAY, new uint256[](2));

        vm.recordLogs();
        vm.prank(KEEPERHUB);
        uint256 left = gasleft();
        g.performUpkeep{gas: KH_GAS}(abi.encode(moves));
        uint256 used = left - gasleft();
        bytes4[] memory out = _outcomes(vm.getRecordedLogs());

        console2.log("perform gas with a burner", used);
        assertEq(out[0], bytes4(0), "out of gas gives no reason");
        assertEq(out[1], ENDED);
        assertGt(used, cap * 63 / 64, "the frame had its whole cap");
        assertLt(used, cap + 100_000, "and no more");
    }

    /// A move whose frame reverts with ~400 KB: the perform copies 4 bytes of it, so the move costs no more than its
    /// cap. Copying it all into the perform's memory would cost about 0.38M more and break the bound.
    function test_a_huge_revert_costs_no_more_than_the_cap_and_leaves_its_first_four_bytes() public {
        vm.etch(SPOKE, address(new RevertBomb(400_000)).code);
        GooseGuard.Move[] memory moves = _moves(account, REPAY, 2);
        uint256 cap = g.capOf(REPAY, new uint256[](2));

        vm.recordLogs();
        vm.prank(KEEPERHUB);
        uint256 left = gasleft();
        g.performUpkeep{gas: KH_GAS}(abi.encode(moves));
        uint256 used = left - gasleft();
        bytes4[] memory out = _outcomes(vm.getRecordedLogs());

        console2.log("perform gas with a 400 KB revert", used);
        assertEq(out.length, 1);
        assertEq(out[0], RevertBomb.Boom.selector, "the first 4 bytes, bubbled whole through run");
        assertGt(used, 400_000, "the frame paid for the payload");
        assertLt(used, cap + 100_000, "the perform didn't");
    }

    function test_a_revert_shorter_than_4_bytes_gives_no_reason() public {
        vm.etch(SPOKE, address(new RevertBomb(3)).code);
        assertEq(_perform(KEEPERHUB, _moves(account, REPAY, 2))[0], bytes4(0));
        vm.etch(SPOKE, address(new RevertBomb(4)).code);
        assertEq(_perform(KEEPERHUB, _moves(account, REPAY, 2))[0], RevertBomb.Boom.selector);
    }

    /// Every kind of refusal in one perform: each is refused on its own and the last move still runs. KeeperHub's
    /// write would lose the round's second write if the perform reverted.
    function test_the_perform_never_reverts_for_a_moves_sake() public {
        vm.etch(SPOKE, type(GasSink).runtimeCode);
        _startRescue(other, _now() - 8 days);
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](8);
        moves[0] = GooseGuard.Move(account, 255, new uint256[](0));
        moves[1] = GooseGuard.Move(account, REPAY, new uint256[](3));
        moves[2] = GooseGuard.Move(account, SELL, new uint256[](0));
        moves[3] = GooseGuard.Move(account, REPAY, new uint256[](2)); // Aave burns the frame's gas
        moves[4] = GooseGuard.Move(address(0), END, new uint256[](0));
        moves[5] = GooseGuard.Move(account, SELL, new uint256[](200));
        moves[6] = GooseGuard.Move(account, END, new uint256[](0));
        moves[7] = GooseGuard.Move(other, END, new uint256[](0));

        bytes4[] memory out = _perform(KEEPERHUB, moves, KH_GAS);
        assertEq(out.length, 8);
        assertEq(out[0], GooseGuard.BadKind.selector);
        assertEq(out[1], GooseGuard.BadArgs.selector);
        assertEq(out[2], GooseGuard.BadArgs.selector);
        assertEq(out[3], bytes4(0));
        assertEq(out[4], GooseGuard.NotNeeded.selector);
        assertEq(out[5], GooseGuard.NoGas.selector);
        assertEq(out[6], GooseGuard.NotNeeded.selector);
        assertEq(out[7], ENDED);
    }

    /// The only whole-perform reverts are a malformed Move[] and a reentrant call.
    function test_only_a_malformed_move_list_reverts_the_perform() public {
        assertEq(_perform(KEEPERHUB, new GooseGuard.Move[](0)).length, 0, "an empty list is a no-op");

        vm.expectRevert();
        vm.prank(KEEPERHUB);
        g.performUpkeep(hex"1234");

        WideMove[] memory wide = new WideMove[](1);
        wide[0] = WideMove(account, uint256(256) + END, new uint256[](0)); // a kind past uint8
        vm.expectRevert();
        vm.prank(KEEPERHUB);
        g.performUpkeep(abi.encode(wide));

        wide[0].kind = END;
        assertEq(_perform(KEEPERHUB, abi.encode(wide))[0], GooseGuard.NotNeeded.selector, "the same list, clean");
    }

    // ================================================================== a repay, offline

    /// A repay from the perform, with Aave and the wallet mocked: the Guard hands the manager exactly
    /// `executeBatch(p, calls)` with the account's own registered permission, the move passes its post-checks, and a
    /// rescue starts because 1.05 is short of 1.12.
    function test_a_repay_hands_the_manager_exactly_executeBatch_of_the_registered_permission() public {
        PM.Permission memory p = _register(account, JOB_PROTECT, _now() - 60);
        _mockAave(account, [uint256(100e6), 90e6], [uint256(1e18), 1.05e18]);
        _mockCash(account, 11e6, 0);

        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.ProtectRepaid(account, 10e6, 0, 1e18, 1.05e18);
        vm.prank(KEEPERHUB);
        g.performUpkeep(abi.encode(_repay(account, 50e6, 0)));

        PM.Call[] memory calls = new PM.Call[](2);
        calls[0] = PM.Call(USDC, 0, abi.encodeCall(IERC20.approve, (SPOKE, 10e6)));
        calls[1] = PM.Call(SPOKE, 0, abi.encodeCall(ISpoke.repay, (7, 10e6, account)));
        assertEq(
            ManagerDouble(MANAGER).lastHash(),
            keccak256(abi.encodeCall(PM.executeBatch, (p, calls))),
            "$1 stays in the wallet"
        );
        uint32 rescueAt = _acct(account).rescueAt;
        assertEq(rescueAt, _now(), "a rescue starts short of the target");
    }

    /// A failed post-check rolls the whole move back, the manager's batch included.
    function test_a_failed_post_check_rolls_back_the_batch() public {
        _register(account, JOB_PROTECT, _now() - 60);
        _mockAave(account, 100e6, 1e18); // the debt didn't fall
        _mockCash(account, 11e6, 0);
        assertEq(_perform(KEEPERHUB, _repay(account, 10e6, 0))[0], GooseGuard.DebtNotLower.selector);
        assertEq(ManagerDouble(MANAGER).lastHash(), bytes32(0), "the batch was rolled back");
    }

    /// The account's ExecuteError(index, reason) is unwrapped: the refusal carries the failed call's own selector.
    function test_a_manager_revert_refuses_the_move_with_the_failed_calls_selector() public {
        _register(account, JOB_PROTECT, _now() - 60);
        _mockAave(account, 100e6, 1e18);
        _mockCash(account, 11e6, 0);
        ManagerDouble(MANAGER).failWith(abi.encodeWithSignature("ExecuteError(uint256,bytes)", 1, hex"0badc0de"));
        assertEq(_perform(KEEPERHUB, _repay(account, 10e6, 0))[0], bytes4(hex"0badc0de"));
    }

    /// No registered permission for the job, or the agent switched off: the move is refused before the manager.
    function test_a_move_without_a_registered_permission_is_refused_with_NoGrant() public {
        _mockAave(account, 100e6, 1e18);
        _mockCash(account, 11e6, 0);
        assertEq(_perform(KEEPERHUB, _repay(account, 10e6, 0))[0], GooseGuard.NoGrant.selector, "never registered");
        _register(account, JOB_PROTECT + 1, _now() - 60);
        assertEq(_perform(KEEPERHUB, _repay(account, 10e6, 0))[0], GooseGuard.NoGrant.selector, "another agent's");
        _register(account, JOB_PROTECT, _now() - 60);
        vm.prank(account);
        g.unregister(JOB_PROTECT);
        assertEq(_perform(KEEPERHUB, _repay(account, 10e6, 0))[0], GooseGuard.NoGrant.selector, "switched off");
        assertEq(ManagerDouble(MANAGER).lastHash(), bytes32(0));
    }

    /// Mid-batch, nothing can call back into the Guard: every entry point takes the lock, and `run` is self-only.
    function test_nothing_reenters_the_guard_from_inside_a_batch() public {
        PM.Permission memory p = _register(account, JOB_PROTECT, _now() - 60);
        _mockAave(account, 100e6, 1e18);
        _mockCash(account, 11e6, 0);
        bytes[9] memory calls = [
            abi.encodeCall(GooseGuard.performUpkeep, (abi.encode(new GooseGuard.Move[](0)))),
            abi.encodeCall(GooseGuard.register, (JOB_PROTECT, abi.encode(p))),
            abi.encodeCall(GooseGuard.unregister, (JOB_PROTECT)),
            abi.encodeCall(GooseGuard.setMix, (0)),
            abi.encodeCall(GooseGuard.setProtect, (0, 0)),
            abi.encodeCall(GooseGuard.setRunner, (stranger)),
            abi.encodeCall(GooseGuard.endRescue, ()),
            abi.encodeCall(GooseGuard.applyChange, (ADD_RUNNER, bytes32(uint256(uint160(stranger))))),
            abi.encodeCall(GooseGuard.run, (GooseGuard.Move(account, END, new uint256[](0))))
        ];
        for (uint256 i; i < calls.length; ++i) {
            ManagerDouble(MANAGER).callBack(calls[i]);
            bytes4 want = i < 8 ? GooseGuard.Reentered.selector : GooseGuard.OnlySelf.selector;
            assertEq(_perform(KEEPERHUB, _repay(account, 10e6, 0))[0], want);
        }
    }

    // ================================================================== the splice into executeBatch

    /// The Guard never decodes the permission: it splices the stored tuple into `executeBatch` calldata. Fuzzed over
    /// permissions with 0–8 calls and 0–4 spends and batches of 0–6 calls with 0–160 bytes of data each.
    function test_the_spliced_batch_is_byte_for_byte_abi_encodeCall(uint256 permSeed, uint256 callSeed, uint8 job)
        public
    {
        job = uint8(bound(job, 0, 4));
        GuardHarness h = _harness();
        PM.Permission memory p =
            _permission(address(h), account, _now() - 60, permSeed % 9, (permSeed >> 8) % 5, permSeed);
        vm.prank(account);
        h.register(job, abi.encode(p));

        PM.Call[] memory calls = _calls(callSeed);
        h.execute(account, job, calls);
        assertEq(ManagerDouble(MANAGER).last(), abi.encodeCall(PM.executeBatch, (p, calls)));
    }

    /// Call data of every length around a word boundary, empty included, and no calls at all; under the smallest
    /// permission and the largest one the Guard takes (82 calls, 8,192 bytes).
    function test_the_splice_holds_for_every_data_length_around_a_word_and_both_permission_extremes() public {
        uint256[12] memory lengths = [uint256(0), 1, 4, 31, 32, 33, 63, 64, 65, 68, 100, 1000];
        PM.Call[] memory calls = new PM.Call[](lengths.length);
        for (uint256 i; i < lengths.length; ++i) {
            calls[i] = PM.Call(address(uint160(0x1000 + i)), i, _bytes(i, lengths[i]));
        }
        GuardHarness h = _harness();
        PM.Permission memory small = _permission(address(h), account, _now() - 60, 0, 0, 1);
        PM.Permission memory big = _permission(address(h), account, _now() - 60, 82, 0, 2);
        assertEq(abi.encode(small).length, 0x140);
        assertEq(abi.encode(big).length, 8192);
        vm.startPrank(account);
        h.register(0, abi.encode(small));
        h.register(4, abi.encode(big));
        vm.stopPrank();

        h.execute(account, 0, calls);
        assertEq(ManagerDouble(MANAGER).last(), abi.encodeCall(PM.executeBatch, (small, calls)), "smallest");
        h.execute(account, 4, calls);
        assertEq(ManagerDouble(MANAGER).last(), abi.encodeCall(PM.executeBatch, (big, calls)), "largest");
        h.execute(account, 4, new PM.Call[](0));
        assertEq(ManagerDouble(MANAGER).last(), abi.encodeCall(PM.executeBatch, (big, new PM.Call[](0))), "no calls");
    }

    function test_the_splice_uses_the_newest_registered_permission() public {
        GuardHarness h = _harness();
        PM.Permission memory older = _permission(address(h), account, _now() - 60, 2, 1, 1);
        PM.Permission memory newer = _permission(address(h), account, _now() - 59, 3, 2, 2);
        vm.startPrank(account);
        h.register(JOB_PROTECT, abi.encode(older));
        h.register(JOB_PROTECT, abi.encode(newer));
        vm.stopPrank();
        PM.Call[] memory calls = _calls(7);
        h.execute(account, JOB_PROTECT, calls);
        assertEq(ManagerDouble(MANAGER).last(), abi.encodeCall(PM.executeBatch, (newer, calls)));
    }

    /// The manager's revert comes back word for word: a custom error, a long Error(string), and nothing at all.
    function test_a_manager_revert_comes_back_with_its_own_reason() public {
        GuardHarness h = _harness();
        PM.Permission memory p = _permission(address(h), account, _now() - 60, 2, 1, 1);
        vm.prank(account);
        h.register(JOB_PROTECT, abi.encode(p));
        PM.Call[] memory calls = _calls(3);

        // The account's ExecuteError comes back as the failed call's own reason; anything else word for word.
        bytes[3] memory reasons = [
            abi.encodeWithSignature("ExecuteError(uint256,bytes)", 2, hex"deadbeef"),
            abi.encodeWithSignature("Error(string)", string(_bytes(9, 300))),
            bytes("")
        ];
        bytes[3] memory back = [bytes(hex"deadbeef"), reasons[1], reasons[2]];
        for (uint256 i; i < reasons.length; ++i) {
            ManagerDouble(MANAGER).failWith(reasons[i]);
            vm.expectRevert(back[i]);
            h.execute(account, JOB_PROTECT, calls);
        }
    }

    function test_execute_refuses_an_agent_that_is_off() public {
        GuardHarness h = _harness();
        vm.expectRevert(GooseGuard.NoGrant.selector);
        h.execute(account, JOB_PROTECT, _calls(1));

        vm.startPrank(account);
        h.register(JOB_PROTECT, abi.encode(_permission(address(h), account, _now() - 60, 1, 1, 1)));
        h.unregister(JOB_PROTECT);
        vm.stopPrank();
        vm.expectRevert(GooseGuard.NoGrant.selector);
        h.execute(account, JOB_PROTECT, _calls(1));
        assertEq(ManagerDouble(MANAGER).lastHash(), bytes32(0));
    }

    // ================================================================== registration

    function test_register_takes_the_five_agents_only() public {
        bytes memory p = abi.encode(_permission(address(g), account, _now() - 60, 1, 1, 1));
        vm.startPrank(account);
        vm.expectRevert(GooseGuard.BadJob.selector);
        g.register(5, p);
        vm.expectRevert(GooseGuard.BadJob.selector);
        g.register(255, p);
        vm.expectRevert(GooseGuard.BadJob.selector);
        g.unregister(5);
        for (uint8 job; job < 5; ++job) {
            vm.expectEmit(true, true, false, true, address(g));
            emit GooseGuard.JobOn(account, job, uint48(_now() - 60), uint48(_now() + 365 days));
            g.register(job, p);
        }
        vm.stopPrank();
        uint8 jobs = _acct(account).jobs;
        assertEq(jobs, 0x1f);
    }

    /// 256 to 8,192 bytes. The Guard reads only the head words, so 256 bytes with a valid head register (the
    /// manager refuses them at the first batch, and only this account's moves).
    function test_register_takes_256_to_8192_bytes() public {
        vm.startPrank(account);
        vm.expectRevert(GooseGuard.TooLong.selector);
        g.register(0, _head(0xff, uint160(account), uint160(address(g)), _now() - 60, _now() + 1 days));
        vm.expectRevert(GooseGuard.TooLong.selector);
        g.register(0, _head(8193, uint160(account), uint160(address(g)), _now() - 60, _now() + 1 days));
        vm.expectRevert(GooseGuard.TooLong.selector);
        g.register(0, abi.encode(_permission(address(g), account, _now() - 60, 83, 0, 1)));

        bytes memory head = _head(0x100, uint160(account), uint160(address(g)), _now() - 60, _now() + 1 days);
        g.register(0, head);
        PM.Permission memory big = _permission(address(g), account, _now() - 59, 82, 0, 1);
        g.register(0, abi.encode(big));
        vm.stopPrank();
        assertEq(g.permissionOf(account, 0), abi.encode(big));
    }

    function test_only_an_account_with_an_allowed_codehash_may_register() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(GooseGuard.CodeNotAllowed.selector);
        vm.prank(eoa);
        g.register(1, abi.encode(_permission(address(g), eoa, _now() - 60, 1, 1, 1)));

        address burner = address(new FakeAccount(true)); // other code
        bytes memory p = abi.encode(_permission(address(g), burner, _now() - 60, 1, 1, 1));
        vm.expectRevert(GooseGuard.CodeNotAllowed.selector);
        vm.prank(burner);
        g.register(1, p);

        _applyAfterDelay(ALLOW_CODEHASH, burner.codehash);
        vm.prank(burner);
        g.register(1, p);

        _applyAfterDelay(DISALLOW_CODEHASH, burner.codehash);
        vm.expectRevert(GooseGuard.CodeNotAllowed.selector);
        vm.prank(burner);
        g.register(2, p);
        uint8 jobs = _acct(burner).jobs;
        assertEq(jobs, 1 << 1, "what's registered stays");
    }

    /// The head words: the tuple's offset, the account (the caller, with clean upper bits), the spender (the
    /// Guard), and a window that holds now and ends by uint48's max.
    function test_register_reads_the_head_and_refuses_each_bad_word() public {
        uint256 a = uint160(account);
        uint256 s = uint160(address(g));
        uint256 t = _now();
        vm.startPrank(account);
        _registerRaw(_headWord0(0x40, a, s, t - 60, t + 1 days), GooseGuard.BadArgs.selector);
        _registerRaw(_head(320, uint160(other), s, t - 60, t + 1 days), GooseGuard.NotAccount.selector);
        _registerRaw(_head(320, a | 1 << 160, s, t - 60, t + 1 days), GooseGuard.NotAccount.selector);
        _registerRaw(_head(320, a, uint160(other), t - 60, t + 1 days), GooseGuard.NotSpender.selector);
        _registerRaw(_head(320, a, s | 1 << 200, t - 60, t + 1 days), GooseGuard.NotSpender.selector);
        _registerRaw(_head(320, a, s, t + 1, t + 1 days), GooseGuard.FutureStart.selector);
        _registerRaw(_head(320, a, s, 1 << 48 | (t - 60), t + 1 days), GooseGuard.FutureStart.selector);
        _registerRaw(_head(320, a, s, t - 60, t - 1), GooseGuard.Expired.selector);
        _registerRaw(_head(320, a, s, t - 60, uint256(type(uint48).max) + 1), GooseGuard.Expired.selector);

        _registerRaw(_head(320, a, s, t - 60, type(uint48).max), bytes4(0));
        _registerRaw(_head(320, a, s, t, t), bytes4(0)); // starts and ends now
        vm.stopPrank();
        uint256 start = _startOf(account, 0);
        assertEq(start, t);
    }

    /// Only a strictly newer start replaces an agent's grant, so a same-second swap is refused too (L1). The mark is
    /// per agent.
    function test_only_a_strictly_newer_start_replaces_an_agents_grant() public {
        uint256 t = _now();
        _register(account, 1, t - 60);
        _registerExpect(account, 1, t - 60, GooseGuard.StaleGrant.selector);
        _registerExpect(account, 1, t - 61, GooseGuard.StaleGrant.selector);
        PM.Permission memory newer = _register(account, 1, t - 59);
        uint256 start = _startOf(account, 1);
        assertEq(start, t - 59);
        assertEq(g.permissionOf(account, 1), abi.encode(newer));
        _register(account, 2, t - 600); // another agent: its own mark

        _register(account, 3, t);
        _registerExpect(account, 3, t, GooseGuard.StaleGrant.selector);
        vm.warp(t + 1);
        _register(account, 3, t + 1);
    }

    /// A start of 0 can never be registered: it is never above the empty mark.
    function test_a_grant_starting_at_0_is_stale() public {
        _registerExpect(account, 1, 0, GooseGuard.StaleGrant.selector);
    }

    /// `unregister` clears the agent's bit and nothing else: the permission stays readable and its start stays the
    /// mark, so the old grant (or an older one) can't come back.
    // ================================================================== the adversarial review's findings, fixed

    /// Finding 1, the Guard's side: only a grant the manager approved and hasn't revoked registers, so a well-formed
    /// grant nobody signed can't put an account in the Planner's queue.
    function test_register_takes_only_a_grant_the_manager_approved_and_has_not_revoked() public {
        ManagerDouble(MANAGER).setApproval(false, false);
        _registerExpect(account, JOB_PROTECT, _now() - 60, GooseGuard.NotApproved.selector);
        ManagerDouble(MANAGER).setApproval(true, true);
        _registerExpect(account, JOB_PROTECT, _now() - 60, GooseGuard.NotApproved.selector);
        ManagerDouble(MANAGER).setApproval(true, false);
        _register(account, JOB_PROTECT, _now() - 60);
        (GooseGuard.Account memory acc,) = g.accountOf(account);
        assertTrue(acc.jobs & (1 << JOB_PROTECT) != 0, "an approved grant registers");
    }

    /// Finding 2: the account itself, or its chosen helper, sizes its perform from an estimate (viem's default). A
    /// move short of gas reverts the perform for them (the NoGas refusal is KeeperHub's alone), so the estimate lands
    /// where the repay runs.
    function test_an_estimate_of_the_accounts_own_repay_runs_it() public {
        _register(account, JOB_PROTECT, _now() - 60);
        bytes memory callData = abi.encodeCall(GooseGuard.performUpkeep, (abi.encode(_repay(account, 50e6, 0))));
        uint256 est = _estimate(account, callData);
        bytes4[] memory out = _sendAt(account, callData, est);
        assertEq(out.length, 1);
        assertEq(out[0], REPAID, "at the estimate the repay runs");
        assertGe(est, g.capOf(REPAY, new uint256[](2)), "the estimate covers the move's cap");
    }

    function test_an_estimate_of_the_chosen_helpers_repay_runs_it() public {
        _register(account, JOB_PROTECT, _now() - 60);
        vm.prank(account);
        g.setRunner(helper);
        bytes memory callData = abi.encodeCall(GooseGuard.performUpkeep, (abi.encode(_repay(account, 50e6, 0))));
        uint256 est = _estimate(helper, callData);
        assertEq(_sendAt(helper, callData, est)[0], REPAID, "at the estimate the repay runs");
    }

    /// Finding 3: a stranger's moves are skipped with no event, so nobody writes refusals into another account's feed
    /// (the app counts refusals in a row, and the cards speak up at 3).
    function test_a_stranger_writes_no_refusals_for_another_account() public {
        _register(account, JOB_PROTECT, _now() - 60);
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](6);
        for (uint256 i; i < 6; ++i) {
            moves[i] = GooseGuard.Move(account, i % 2 == 0 ? REPAY : TRADE, new uint256[](0));
        }
        vm.recordLogs();
        vm.prank(stranger);
        g.performUpkeep(abi.encode(moves));
        assertEq(vm.getRecordedLogs().length, 0, "no event for someone else's moves");
        assertEq(ManagerDouble(MANAGER).lastHash(), bytes32(0), "nothing reached the manager");
    }

    /// Checked by the review, holds: a repay that lands short starts a rescue, and a top-up after it in the same
    /// perform is refused (the wallet stays for Protect).
    function test_a_top_up_after_a_repay_that_starts_a_rescue_is_refused_in_the_same_perform() public {
        _rebalancer();
        vm.prank(account);
        g.setTopUps(true, 0);
        _register(account, JOB_PROTECT, _now() - 60);
        _mockAave(account, [uint256(100e6), 90e6], [uint256(1e18), 1.05e18]);
        _mockCash(account, 101e6, 0);
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](2);
        moves[0] = _repay(account, 10e6, 0)[0];
        moves[1] = _tradeMove(10e6, _one(_buy(0, 10e6)))[0];
        bytes4[] memory out = _perform(KEEPERHUB, moves);
        assertEq(out[0], REPAID);
        assertEq(out[1], GooseGuard.RescueOn.selector);
    }

    /// Checked by the review, holds: the floors round down by at most one unit of what comes out. A buy of 1 USDC unit
    /// at $100 is refused (a 0-share floor), 2 units floor at 1 share unit; a 1-share-unit sale floors to 0, refused.
    function test_floors_round_down_by_at_most_one_output_unit() public {
        _rebalancer();
        vm.prank(account);
        g.setTopUps(true, 0);
        assertEq(_trade(1, _one(_buy(0, 1))), GooseGuard.BelowFloor.selector);
        assertEq(_trade(2, _one(_buy(0, 2))), INVESTED);
        assertEq(_trade(0, _one(_sale(5, 1))), GooseGuard.BelowFloor.selector);
    }

    /// Under the line: debt 100, health 1.00 before; 90 and 1.05 after. $11 in the wallet.
    function _armRepay() internal {
        _mockAave(account, [uint256(100e6), 90e6], [uint256(1e18), 1.05e18]);
        _mockCash(account, 11e6, 0);
    }

    /// What eth_estimateGas finds, on execution gas: the least gas at which `from`'s call doesn't revert. The state is
    /// re-mocked before each try (snapshots don't rewind mockCalls' sequences).
    function _estimate(address from, bytes memory callData) internal returns (uint256 hi) {
        uint256 lo;
        hi = KH_GAS;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            _armRepay();
            vm.prank(from);
            (bool ok,) = address(g).call{gas: mid}(callData);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid + 1;
        }
    }

    function _sendAt(address from, bytes memory callData, uint256 gas) internal returns (bytes4[] memory) {
        _armRepay();
        vm.recordLogs();
        vm.prank(from);
        (bool ok,) = address(g).call{gas: gas}(callData);
        assertTrue(ok, "the perform reverted");
        return _outcomes(vm.getRecordedLogs());
    }

    function test_unregister_clears_only_the_agents_bit_and_keeps_its_start() public {
        uint256 t = _now();
        PM.Permission memory p = _register(account, 1, t - 60);
        _register(account, 2, t - 60);

        vm.expectEmit(true, true, false, true, address(g));
        emit GooseGuard.JobOff(account, 1);
        vm.prank(account);
        g.unregister(1);
        GooseGuard.Account memory acc = _acct(account);
        uint8 jobs = acc.jobs;
        uint24 index = acc.index;
        assertEq(jobs, 1 << 2);
        assertEq(index, 1, "still a member");
        assertEq(_startOf(account, 1), t - 60, "the mark stays");
        assertEq(g.permissionOf(account, 1), abi.encode(p));

        vm.expectRevert(GooseGuard.StaleGrant.selector);
        vm.prank(account);
        g.register(1, abi.encode(p));
        _registerExpect(account, 1, t - 61, GooseGuard.StaleGrant.selector);
        _register(account, 1, t - 59);
        jobs = _acct(account).jobs;
        assertEq(jobs, 1 << 1 | 1 << 2);

        vm.prank(stranger);
        g.unregister(2); // a stranger only switches off its own
        jobs = _acct(account).jobs;
        assertEq(jobs, 1 << 1 | 1 << 2);
    }

    function test_an_account_joins_members_once() public {
        uint256 t = _now();
        _register(account, 1, t - 60);
        _register(account, 2, t - 60);
        vm.prank(account);
        g.unregister(1);
        _register(account, 1, t - 59);
        assertEq(g.membersLength(), 1);
        assertEq(g.members(0), account);

        _register(other, 0, t - 60);
        assertEq(g.membersLength(), 2);
        assertEq(g.members(1), other);
        uint24 index = _acct(other).index;
        assertEq(index, 2);
    }

    /// GG-04: register needs JAW's manager to own the account; a no, a revert or an odd answer all count as no.
    function test_register_needs_jaws_manager_to_own_the_account() public {
        bytes memory ask = abi.encodeWithSignature("isOwnerAddress(address)", MANAGER);
        vm.mockCall(account, ask, abi.encode(false));
        _registerExpect(account, 1, _now() - 60, GooseGuard.NotManaged.selector);
        vm.mockCall(account, ask, abi.encode(uint256(2)));
        _registerExpect(account, 1, _now() - 60, GooseGuard.NotManaged.selector);
        vm.mockCallRevert(account, ask, "no");
        _registerExpect(account, 1, _now() - 60, GooseGuard.NotManaged.selector);
        vm.clearMockedCalls();
        assertEq(g.membersLength(), 0, "no member joined");
        assertEq(g.protectMembersLength(), 0);

        _register(account, 1, _now() - 60);
        assertEq(g.membersLength(), 1, "a yes registers");
    }

    /// GG-14: the Protect set holds exactly the accounts with Protect or Protect · sell on; an account leaves it by
    /// swap-and-pop when both are off, and its rescue ends then. `members` keeps everyone.
    function test_the_protect_set_holds_exactly_the_accounts_with_a_protect_agent_on() public {
        uint256 t = _now();
        address third = address(new FakeAccount(false));
        _register(account, JOB_SAVE, t - 60);
        assertEq(g.protectMembersLength(), 0, "Save alone isn't Protect");
        _register(account, JOB_PROTECT, t - 60);
        _register(account, JOB_SELL, t - 60);
        _register(other, JOB_SELL, t - 60);
        _register(third, JOB_PROTECT, t - 60);
        assertEq(g.protectMembersLength(), 3, "an account joins once");
        assertEq(abi.encode(g.protectMembers(0), g.protectMembers(1), g.protectMembers(2)), abi.encode(account, other, third));

        vm.prank(account);
        g.unregister(JOB_PROTECT);
        assertEq(g.protectMembersLength(), 3, "Protect sell still on");
        _startRescue(account, t - 1 hours);
        vm.expectEmit(true, false, false, false, address(g));
        emit GooseGuard.RescueEnded(account);
        vm.prank(account);
        g.unregister(JOB_SELL);
        assertEq(g.protectMembersLength(), 2);
        assertEq(abi.encode(g.protectMembers(0), g.protectMembers(1)), abi.encode(third, other), "swap-and-pop");
        uint32 rescueAt = _acct(account).rescueAt;
        assertEq(rescueAt, 0, "no agent left to carry the rescue");
        assertEq(g.membersLength(), 3, "still members");

        vm.prank(account);
        g.unregister(JOB_SELL); // already out: nothing moves
        vm.prank(stranger);
        g.unregister(JOB_PROTECT);
        assertEq(g.protectMembersLength(), 2);

        vm.prank(other);
        g.unregister(JOB_SELL); // the last entry leaves
        assertEq(g.protectMembersLength(), 1);
        assertEq(g.protectMembers(0), third);
        _register(account, JOB_SELL, t - 59);
        assertEq(g.protectMembersLength(), 2);
        assertEq(g.protectMembers(1), account, "back at the end");
        vm.prank(third);
        g.unregister(JOB_PROTECT); // the first entry leaves
        assertEq(g.protectMembersLength(), 1);
        assertEq(g.protectMembers(0), account);
    }

    /// The Protect set mirrors the jobs after any sequence of registers and unregisters by three accounts.
    function testFuzz_the_protect_set_follows_the_protect_bits(uint256 seed) public {
        address[3] memory who = [account, other, address(new FakeAccount(false))];
        uint256 t = _now() - 1000;
        for (uint256 i; i < 24; ++i) {
            uint256 x = uint256(keccak256(abi.encode(seed, i)));
            address a = who[x % 3];
            uint8 job = uint8(x >> 8) % 5;
            if (x >> 16 & 1 == 0) {
                _register(a, job, ++t);
            } else {
                vm.prank(a);
                g.unregister(job);
            }
            uint256 inSet;
            for (uint256 k; k < 3; ++k) {
                uint8 jobs = _acct(who[k]).jobs;
                bool on = jobs & (1 << JOB_PROTECT | 1 << JOB_SELL) != 0;
                bool found;
                for (uint256 m; m < g.protectMembersLength(); ++m) {
                    if (g.protectMembers(m) == who[k]) {
                        assertFalse(found, "twice in the set");
                        found = true;
                    }
                }
                assertEq(found, on, "the set and the bits disagree");
                if (on) ++inSet;
            }
            assertEq(g.protectMembersLength(), inSet);
        }
    }

    function test_a_new_member_past_the_last_index_is_refused_and_members_still_register() public {
        _register(account, 1, _now() - 60);
        vm.store(address(g), bytes32(MEMBERS_SLOT), bytes32(uint256(type(uint24).max)));
        assertEq(g.membersLength(), type(uint24).max, "the slot layout moved");
        _registerExpect(other, 1, _now() - 60, GooseGuard.TooManyMembers.selector);
        _register(account, 2, _now() - 60);
    }

    function test_permissionOf_returns_exactly_the_registered_bytes(uint256 seed, uint8 job) public {
        job = uint8(bound(job, 0, 4));
        assertEq(g.permissionOf(account, job).length, 0, "nothing yet");
        PM.Permission memory p = _permission(address(g), account, _now() - 60, seed % 9, (seed >> 8) % 5, seed);
        vm.prank(account);
        g.register(job, abi.encode(p));
        assertEq(g.permissionOf(account, job), abi.encode(p));
        assertEq(g.permissionOf(other, job).length, 0, "only the account's own");
    }

    // ================================================================== settings

    function test_setMix_takes_weights_that_add_up_to_100_percent_or_all_zero() public {
        uint112 mix = _pack([uint16(2_500), 0, 0, 0, 0, 5_000, 2_500]);
        assertEq(mix, uint112(2_500) | uint112(5_000) << 80 | uint112(2_500) << 96, "reserve r at bits [16r, 16r + 16)");
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.MixSet(account, mix);
        vm.prank(account);
        g.setMix(mix);
        GooseGuard.Settings memory s = _set(account);
        assertEq(s.mix, mix);
        assertEq(s.mixSetAt, _now());
        assertEq(_set(stranger).mix, 0, "a stranger only sets its own");

        _badMix(mix - 1);
        _badMix(mix + 1);
        _badMix(type(uint16).max);
        _badMix(type(uint112).max);
        _badMix(uint112(10_000) << 16 | 10_000);

        vm.warp(_now() + 1 hours);
        vm.prank(account);
        g.setMix(0);
        s = _set(account);
        assertEq(s.mix, 0, "cleared");
        assertEq(s.mixSetAt, _now(), "a cleared mix is a new mix");
    }

    /// The argument is a uint112: a word with any bit past 112 set is refused by the ABI decoder.
    function test_setMix_refuses_bits_past_the_seventh_weight() public {
        vm.prank(account);
        (bool ok,) = address(g).call(abi.encodeWithSelector(GooseGuard.setMix.selector, uint256(1) << 112 | 10_000));
        assertFalse(ok);
        assertEq(_set(account).mix, 0);
    }

    /// Any split of 100% is taken as packed; one basis point more on any weight is refused.
    function test_setMix_takes_any_mix_that_adds_up_and_refuses_one_bp_more(uint16[6] memory w, uint8 extra) public {
        uint16[7] memory weights;
        uint256 sum;
        for (uint256 r; r < 6; ++r) {
            weights[r] = uint16(bound(w[r], 0, 10_000 - sum));
            sum += weights[r];
        }
        weights[6] = uint16(10_000 - sum);
        uint112 mix = _pack(weights);
        vm.prank(account);
        g.setMix(mix);
        assertEq(_set(account).mix, mix);

        _badMix(mix + (uint112(1) << (16 * (extra % 7))));
    }

    /// A random packed word is taken exactly when its seven weights add up to 10,000 or are all 0.
    function test_setMix_takes_exactly_the_words_whose_weights_add_up(uint112 mix) public {
        uint256 sum;
        for (uint256 r; r < 7; ++r) {
            sum += uint256(mix) >> (16 * r) & type(uint16).max;
        }
        if (sum != 10_000 && sum != 0) {
            _badMix(mix);
            return;
        }
        vm.prank(account);
        g.setMix(mix);
        assertEq(_set(account).mix, mix);
    }

    /// (0, 0) = 1.03 / 1.12. Otherwise the line is at least 1.03, the target at least 0.05 above it and at most 1.40.
    function test_setProtect_keeps_the_line_at_1_03_or_more_and_the_target_0_05_above_it_up_to_1_40() public {
        (uint256 line, uint256 target) = g.linesOf(account);
        assertEq(line, 1.03e18);
        assertEq(target, 1.12e18);

        _lines(10_300, 10_800, true);
        _lines(13_500, 14_000, true);
        _lines(11_000, 12_500, true);
        _lines(0, 0, true);
        _lines(10_299, 11_200, false);
        _lines(10_300, 10_799, false);
        _lines(13_600, 14_000, false);
        _lines(10_300, 14_001, false);
        _lines(0, 11_200, false);
        _lines(10_300, 0, false);
        _lines(type(uint16).max, type(uint16).max, false);

        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.ProtectSet(account, 11_000, 12_000);
        vm.prank(account);
        g.setProtect(11_000, 12_000);
        (line, target) = g.linesOf(stranger);
        assertEq(line, 1.03e18, "a stranger only sets its own");
    }

    function test_setProtect_takes_exactly_the_lines_in_bounds(uint16 line, uint16 target) public {
        _lines(
            line,
            target,
            (line == 0 && target == 0) || (line >= 10_300 && target >= uint256(line) + 500 && target <= 14_000)
        );
    }

    function test_each_setting_writes_only_its_own_field() public {
        vm.startPrank(account);
        g.setMix(10_000);
        g.setProtect(10_500, 11_500);
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.KeepMixSet(account, true);
        g.setKeepMix(true);
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.TopUpsSet(account, true, type(uint48).max);
        g.setTopUps(true, type(uint48).max);
        g.setRunner(helper);
        vm.stopPrank();

        GooseGuard.Settings memory s = _set(account);
        assertEq(s.mix, 10_000);
        assertEq(s.line, 10_500);
        assertEq(s.target, 11_500);
        assertEq(s.mixSetAt, _now());
        assertTrue(s.keepMix);
        assertTrue(s.topUpsOn);
        assertEq(s.keep, type(uint48).max);
        assertEq(_acct(account).runner, helper);

        (GooseGuard.Account memory acc, GooseGuard.Settings memory none) = g.accountOf(stranger);
        assertEq(abi.encode(acc, none), new bytes(12 * 32), "a stranger's are untouched");
    }

    /// The account ends its own rescue at any time (decision 5); with none on it does nothing and doesn't fail.
    function test_endRescue_ends_only_the_callers_own_rescue_and_does_nothing_without_one() public {
        vm.recordLogs();
        vm.prank(account);
        g.endRescue();
        assertEq(vm.getRecordedLogs().length, 0, "no rescue: nothing happens");

        _register(account, 1, _now() - 60);
        vm.prank(account);
        g.setRunner(helper);
        _startRescue(account, _now() - 1 hours);
        _startRescue(other, _now() - 1 hours);

        vm.expectEmit(true, false, false, false, address(g));
        emit GooseGuard.RescueEnded(account);
        vm.prank(account);
        g.endRescue();
        GooseGuard.Account memory acc = _acct(account);
        assertEq(acc.rescueAt, 0);
        assertEq(
            abi.encode(acc.index, acc.jobs, acc.runner), abi.encode(uint24(1), uint8(1 << 1), helper), "the rest stays"
        );
        uint32 rescueAt;
        rescueAt = _acct(other).rescueAt;
        assertEq(rescueAt, _now() - 1 hours, "another account's rescue stays");

        vm.prank(stranger);
        g.endRescue();
        rescueAt = _acct(other).rescueAt;
        assertEq(rescueAt, _now() - 1 hours);
    }

    // ================================================================== owner

    function test_only_the_owner_pauses_and_unpauses() public {
        vm.expectRevert(GooseGuard.NotOwner.selector);
        vm.prank(stranger);
        g.pause();
        vm.expectRevert(GooseGuard.NotOwner.selector);
        vm.prank(KEEPERHUB);
        g.pause();

        vm.expectEmit(false, false, false, true, address(g));
        emit GooseGuard.Paused(true);
        vm.prank(owner);
        g.pause();
        assertTrue(g.paused());

        vm.expectRevert(GooseGuard.NotOwner.selector);
        vm.prank(stranger);
        g.unpause();
        vm.prank(owner);
        g.unpause();
        assertFalse(g.paused());
    }

    /// Pause never stops Protect (Adrian, Oct 22): a repay runs to its end, a sale gets to its own checks, END and
    /// `endRescue()` run, and registration and settings stay open.
    function test_pause_never_stops_protect_END_endRescue_registration_or_settings() public {
        vm.prank(owner);
        g.pause();

        _register(account, JOB_PROTECT, _now() - 60);
        _mockAave(account, [uint256(100e6), 90e6], [uint256(1e18), 1.05e18]);
        _mockCash(account, 11e6, 0);
        assertEq(_perform(KEEPERHUB, _repay(account, 10e6, 0))[0], REPAID, "a repay");
        assertEq(_perform(KEEPERHUB, _moves(account, SELL, 0))[0], GooseGuard.BadArgs.selector, "a sale");

        _startRescue(other, _now() - 8 days);
        assertEq(_perform(stranger, _moves(other, END, 0))[0], ENDED, "END");
        vm.startPrank(account);
        g.endRescue();
        g.setMix(uint112(10_000) << 96);
        g.setProtect(10_400, 11_400);
        g.unregister(JOB_PROTECT);
        vm.stopPrank();
        _register(account, JOB_PROTECT, _now() - 59);
    }

    /// Every change waits 48 hours in public, then anyone may apply it.
    function test_a_change_waits_48_hours_then_anyone_may_apply_it() public {
        bytes32 arg = _arg(helper);
        bytes32 id = _id(0, ADD_RUNNER, arg);
        uint256 eta = _now() + 48 hours;
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.ChangeQueued(id, ADD_RUNNER, arg, eta);
        vm.prank(owner);
        assertEq(g.queueChange(ADD_RUNNER, arg), id);
        assertEq(g.queued(id), eta);

        vm.expectRevert(abi.encodeWithSelector(GooseGuard.TooEarly.selector, eta));
        vm.prank(stranger);
        g.applyChange(ADD_RUNNER, arg);
        vm.warp(eta - 1);
        vm.expectRevert(abi.encodeWithSelector(GooseGuard.TooEarly.selector, eta));
        vm.prank(owner);
        g.applyChange(ADD_RUNNER, arg);
        assertEq(_perform(helper, _moves(account, REPAY, 0)).length, 0, "not yet");

        vm.warp(eta);
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.ChangeApplied(id, ADD_RUNNER, arg);
        vm.prank(stranger);
        g.applyChange(ADD_RUNNER, arg);
        assertTrue(g.isRunner(helper));
        assertEq(g.queued(id), 0);
        assertEq(_perform(helper, _moves(account, REPAY, 0))[0], GooseGuard.BadArgs.selector, "a runner now");

        vm.expectRevert(GooseGuard.NotQueued.selector);
        g.applyChange(ADD_RUNNER, arg);
    }

    /// Removing a runner waits too, so a stolen key can't stop Protect in one transaction.
    function test_removing_keeperhub_waits_48_hours_too() public {
        _applyAfterDelay(ADD_RUNNER, _arg(helper)); // never the last runner (GG-09)
        vm.prank(owner);
        g.queueChange(REMOVE_RUNNER, _arg(KEEPERHUB));
        vm.warp(_now() + 48 hours - 1);
        assertEq(_perform(KEEPERHUB, _moves(account, REPAY, 0))[0], GooseGuard.BadArgs.selector, "still a runner");
        vm.warp(_now() + 1);
        g.applyChange(REMOVE_RUNNER, _arg(KEEPERHUB));
        assertFalse(g.isRunner(KEEPERHUB));
        assertEq(_perform(KEEPERHUB, _moves(account, REPAY, 0)).length, 0);
        assertEq(_perform(account, _moves(account, REPAY, 0))[0], GooseGuard.BadArgs.selector, "the account still can");
    }

    function test_a_new_owner_takes_over_only_by_applying_the_change_themselves() public {
        address next = makeAddr("next owner");
        vm.prank(owner);
        g.queueChange(SET_OWNER, _arg(next));
        vm.warp(_now() + 48 hours);

        vm.expectRevert(GooseGuard.NotNewOwner.selector);
        vm.prank(stranger);
        g.applyChange(SET_OWNER, _arg(next));
        vm.expectRevert(GooseGuard.NotNewOwner.selector);
        vm.prank(owner);
        g.applyChange(SET_OWNER, _arg(next));

        vm.prank(next);
        g.applyChange(SET_OWNER, _arg(next));
        assertEq(g.owner(), next);
        vm.expectRevert(GooseGuard.NotOwner.selector);
        vm.prank(owner);
        g.pause();
        vm.prank(next);
        g.pause();
    }

    function test_queue_cancel_and_apply_refuse_what_is_missing_or_already_there() public {
        bytes32 arg = _arg(helper);
        vm.startPrank(owner);
        bytes32 id = g.queueChange(ADD_RUNNER, arg);
        vm.expectRevert(GooseGuard.AlreadyQueued.selector);
        g.queueChange(ADD_RUNNER, arg);

        vm.expectEmit(true, false, false, false, address(g));
        emit GooseGuard.ChangeCancelled(id);
        g.cancelChange(id);
        assertEq(g.queued(id), 0);
        vm.expectRevert(GooseGuard.NotQueued.selector);
        g.cancelChange(id);
        vm.stopPrank();

        vm.warp(_now() + 48 hours);
        vm.expectRevert(GooseGuard.NotQueued.selector);
        g.applyChange(ADD_RUNNER, arg);
        vm.expectRevert(GooseGuard.NotQueued.selector);
        g.applyChange(REMOVE_RUNNER, arg);

        vm.prank(owner);
        g.queueChange(ADD_RUNNER, arg);
        assertEq(g.queued(id), _now() + 48 hours, "queued again, it waits from now");
        vm.expectRevert(GooseGuard.NotOwner.selector);
        vm.prank(stranger);
        g.cancelChange(id);
        vm.expectRevert(GooseGuard.NotOwner.selector);
        vm.prank(stranger);
        g.queueChange(REMOVE_RUNNER, arg);
    }

    /// Kinds past SET_OWNER, and a zero or dirty address for the address kinds. A codehash may be any 32 bytes.
    function test_queue_refuses_unknown_kinds_and_zero_or_dirty_addresses() public {
        vm.startPrank(owner);
        uint8[3] memory unknown = [uint8(5), 6, 255];
        for (uint256 i; i < unknown.length; ++i) {
            vm.expectRevert(GooseGuard.BadChange.selector);
            g.queueChange(unknown[i], _arg(helper));
        }
        uint8[3] memory addressKinds = [ADD_RUNNER, REMOVE_RUNNER, SET_OWNER];
        for (uint256 i; i < addressKinds.length; ++i) {
            vm.expectRevert(GooseGuard.BadChange.selector);
            g.queueChange(addressKinds[i], bytes32(0));
            vm.expectRevert(GooseGuard.BadChange.selector);
            g.queueChange(addressKinds[i], bytes32(uint256(1) << 160 | uint160(helper)));
            vm.expectRevert(GooseGuard.BadChange.selector);
            g.queueChange(addressKinds[i], bytes32(type(uint256).max));
            // a target of its own: ADD and REMOVE of one runner can't both wait (GG-08)
            g.queueChange(addressKinds[i], bytes32(uint256(uint160(helper)) + i));
        }
        g.queueChange(ALLOW_CODEHASH, bytes32(0));
        g.queueChange(DISALLOW_CODEHASH, bytes32(type(uint256).max));
        vm.stopPrank();
    }

    /// GG-08 (a): a change can't be queued while its opposite for the same target waits or is due (ADD and REMOVE of
    /// one runner, ALLOW and DISALLOW of one codehash), so the owner's last word is the only one that can apply.
    function test_a_change_cant_be_queued_while_its_opposite_waits() public {
        bytes32 h = _arg(helper);
        bytes4 opposite = GooseGuard.OppositeQueued.selector;
        vm.startPrank(owner);
        g.queueChange(REMOVE_RUNNER, h);
        vm.expectRevert(opposite);
        g.queueChange(ADD_RUNNER, h);
        g.queueChange(ADD_RUNNER, _arg(stranger)); // another runner is free
        g.queueChange(ALLOW_CODEHASH, bytes32(uint256(7)));
        vm.expectRevert(opposite);
        g.queueChange(DISALLOW_CODEHASH, bytes32(uint256(7)));
        g.queueChange(DISALLOW_CODEHASH, bytes32(uint256(8)));
        vm.expectRevert(opposite);
        g.queueChange(ALLOW_CODEHASH, bytes32(uint256(8)));

        vm.warp(_now() + 48 hours);
        vm.expectRevert(opposite);
        g.queueChange(ADD_RUNNER, h); // due, not applied: still in the way
        g.cancelChange(_id(0, REMOVE_RUNNER, h));
        g.queueChange(ADD_RUNNER, h); // the owner's last word
        vm.expectRevert(opposite);
        g.queueChange(REMOVE_RUNNER, h);
        vm.stopPrank();

        // Once applied, the other side may be queued.
        g.applyChange(ALLOW_CODEHASH, bytes32(uint256(7)));
        vm.prank(owner);
        g.queueChange(DISALLOW_CODEHASH, bytes32(uint256(7)));
        // SET_OWNER has no opposite: two may wait at once.
        vm.startPrank(owner);
        g.queueChange(SET_OWNER, _arg(stranger));
        g.queueChange(SET_OWNER, _arg(helper));
        vm.stopPrank();
    }

    /// Mariano's PoC: REMOVE queued, then ADD a day later. The ADD is refused, so no one can apply them in an order the
    /// owner didn't mean.
    function test_opposite_changes_can_never_both_be_due() public {
        _applyAfterDelay(ADD_RUNNER, _arg(helper));
        vm.prank(owner);
        g.queueChange(REMOVE_RUNNER, _arg(KEEPERHUB));
        vm.warp(_now() + 1 days);
        vm.expectRevert(GooseGuard.OppositeQueued.selector);
        vm.prank(owner);
        g.queueChange(ADD_RUNNER, _arg(KEEPERHUB));
    }

    /// GG-08 (b): a due change can be applied for 7 days after its ETA, then it is refused; it may be queued again,
    /// and once expired it no longer holds back its opposite.
    function test_a_due_change_expires_7_days_after_its_eta() public {
        bytes32 h = _arg(helper);
        vm.prank(owner);
        g.queueChange(ADD_RUNNER, h);
        uint256 eta = _now() + 48 hours;

        uint256 snap = vm.snapshotState();
        vm.warp(eta + 7 days);
        g.applyChange(ADD_RUNNER, h);
        assertTrue(g.isRunner(helper), "the last second of its 7 days");
        vm.revertToState(snap);

        vm.warp(eta + 7 days + 1);
        vm.expectRevert(GooseGuard.ChangeExpired.selector);
        g.applyChange(ADD_RUNNER, h);
        assertFalse(g.isRunner(helper));

        vm.prank(owner);
        g.queueChange(REMOVE_RUNNER, h); // the expired ADD is no longer in the way
        vm.prank(owner);
        g.cancelChange(_id(0, REMOVE_RUNNER, h));
        vm.prank(owner);
        assertEq(g.queueChange(ADD_RUNNER, h), _id(0, ADD_RUNNER, h), "queued again");
        assertEq(g.queued(_id(0, ADD_RUNNER, h)), _now() + 48 hours, "it waits from now");
        vm.warp(_now() + 48 hours);
        g.applyChange(ADD_RUNNER, h);
        assertTrue(g.isRunner(helper));
    }

    /// GG-08 (c): a new owner bumps the epoch, which is part of every change id, so nothing the old owner queued can
    /// ever apply, a second SET_OWNER included. The new owner queues under the new epoch.
    function test_a_new_owner_voids_every_change_the_old_owner_queued() public {
        address next = makeAddr("next owner");
        bytes32 h = _arg(helper);
        assertEq(g.epoch(), 0);
        vm.startPrank(owner);
        g.queueChange(SET_OWNER, _arg(next));
        g.queueChange(ADD_RUNNER, h);
        g.queueChange(ALLOW_CODEHASH, bytes32(uint256(9)));
        g.queueChange(SET_OWNER, _arg(stranger));
        vm.stopPrank();
        vm.warp(_now() + 48 hours);

        vm.prank(next);
        g.applyChange(SET_OWNER, _arg(next));
        assertEq(g.owner(), next);
        assertEq(g.epoch(), 1);

        vm.expectRevert(GooseGuard.NotQueued.selector);
        g.applyChange(ADD_RUNNER, h);
        vm.expectRevert(GooseGuard.NotQueued.selector);
        g.applyChange(ALLOW_CODEHASH, bytes32(uint256(9)));
        vm.expectRevert(GooseGuard.NotQueued.selector);
        vm.prank(stranger);
        g.applyChange(SET_OWNER, _arg(stranger));
        assertFalse(g.isRunner(helper));
        assertFalse(g.codehashOk(bytes32(uint256(9))));
        assertEq(g.owner(), next);

        vm.prank(next);
        assertEq(g.queueChange(ADD_RUNNER, h), _id(1, ADD_RUNNER, h), "the new owner's epoch");
        vm.warp(_now() + 48 hours);
        g.applyChange(ADD_RUNNER, h);
        assertTrue(g.isRunner(helper));
    }

    /// GG-09: the last runner can never be removed, queued or at once, so Protect rounds always have a runner. Adding
    /// a runner twice or removing one that isn't changes nothing.
    function test_the_last_runner_can_never_be_removed() public {
        assertEq(g.runners(), 1);
        vm.prank(owner);
        g.queueChange(REMOVE_RUNNER, _arg(KEEPERHUB));
        vm.warp(_now() + 48 hours);
        vm.expectRevert(GooseGuard.LastRunner.selector);
        g.applyChange(REMOVE_RUNNER, _arg(KEEPERHUB));
        vm.expectRevert(GooseGuard.LastRunner.selector);
        vm.prank(owner);
        g.removeRunner(KEEPERHUB);
        assertTrue(g.isRunner(KEEPERHUB));

        _applyAfterDelay(ADD_RUNNER, _arg(helper));
        assertEq(g.runners(), 2);
        _applyAfterDelay(ADD_RUNNER, _arg(helper));
        assertEq(g.runners(), 2, "already a runner");
        _applyAfterDelay(REMOVE_RUNNER, _arg(stranger));
        assertEq(g.runners(), 2, "not a runner");

        g.applyChange(REMOVE_RUNNER, _arg(KEEPERHUB)); // still due: now there is another runner
        assertFalse(g.isRunner(KEEPERHUB));
        assertEq(g.runners(), 1);
        vm.expectRevert(GooseGuard.LastRunner.selector);
        vm.prank(owner);
        g.removeRunner(helper);
        assertTrue(g.isRunner(helper));
    }

    /// GG-20: the owner removes a runner at once (a stolen runner key), only the owner, never the last one. Adding
    /// one back still waits 48 hours, and pause still never stops Protect.
    function test_the_owner_removes_a_runner_at_once() public {
        _applyAfterDelay(ADD_RUNNER, _arg(helper));
        vm.expectRevert(GooseGuard.NotOwner.selector);
        vm.prank(stranger);
        g.removeRunner(helper);
        vm.expectRevert(GooseGuard.NotOwner.selector);
        vm.prank(KEEPERHUB);
        g.removeRunner(helper);

        assertEq(_perform(helper, _moves(account, REPAY, 0))[0], GooseGuard.BadArgs.selector, "a runner");
        vm.expectEmit(true, false, false, false, address(g));
        emit GooseGuard.RunnerRemoved(helper);
        vm.prank(owner);
        g.removeRunner(helper);
        assertFalse(g.isRunner(helper));
        assertEq(g.runners(), 1);
        assertEq(_perform(helper, _moves(account, REPAY, 0)).length, 0, "its moves are skipped in the same block");
        vm.expectRevert(GooseGuard.NotRunner.selector);
        vm.prank(owner);
        g.removeRunner(helper);

        vm.prank(owner);
        g.queueChange(ADD_RUNNER, _arg(helper));
        vm.warp(_now() + 48 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(GooseGuard.TooEarly.selector, _now() + 1));
        g.applyChange(ADD_RUNNER, _arg(helper));

        vm.prank(owner);
        g.pause();
        assertEq(_perform(KEEPERHUB, _moves(account, REPAY, 0))[0], GooseGuard.BadArgs.selector, "Protect runs paused");
    }

    /// The owner has no path to a move or to money: `run` is self-only, the perform refuses it, the Guard takes no
    /// ETH, and every setting and registration is the caller's own.
    function test_the_owner_can_never_run_a_move_or_take_money() public {
        vm.expectRevert(GooseGuard.OnlySelf.selector);
        vm.prank(owner);
        g.run(GooseGuard.Move(account, REPAY, new uint256[](2)));
        assertEq(_perform(owner, _moves(account, REPAY, 0)).length, 0);

        vm.deal(owner, 1 ether);
        vm.prank(owner);
        (bool ok,) = address(g).call{value: 1}("");
        assertFalse(ok, "no receive");
        vm.prank(owner);
        (ok,) = address(g).call{value: 1}(abi.encodeCall(GooseGuard.endRescue, ()));
        assertFalse(ok, "nothing payable");

        PM.Permission memory p = _permission(address(g), account, _now() - 60, 1, 1, 1);
        vm.expectRevert(GooseGuard.CodeNotAllowed.selector);
        vm.prank(owner);
        g.register(1, abi.encode(p));
        _startRescue(account, _now() - 1 hours);
        vm.prank(owner);
        g.endRescue();
        uint32 rescueAt = _acct(account).rescueAt;
        assertEq(rescueAt, _now() - 1 hours, "the owner can't end someone's rescue");
    }

    // ================================================================== caps and the pause, kind by kind

    function test_each_kind_has_its_gas_cap() public view {
        assertEq(g.capOf(SAVE, new uint256[](1)), 500_000);
        assertEq(g.capOf(REPAY, new uint256[](2)), 1_200_000);
        assertEq(g.capOf(TRADE, new uint256[](8)), 500_000 + 8 * 320_000);
        assertEq(g.capOf(CONVERT, new uint256[](2)), 660_000);
        assertEq(g.capOf(END, new uint256[](0)), 520_000);
        assertEq(g.capOf(REFRESH, new uint256[](0)), 1_000_000);
        assertEq(g.capOf(255, new uint256[](0)), 520_000, "an unknown kind is refused in the END cap");
    }

    /// A sale's cap counts its slices and, on top, each distinct stock it sells.
    function test_a_sales_cap_counts_slices_and_distinct_stocks() public view {
        uint256[] memory oneStock = new uint256[](6);
        for (uint256 i; i < 6; ++i) {
            oneStock[i] = uint256(5) << 248 | 1e8;
        }
        assertEq(g.capOf(SELL, oneStock), 1_300_000 + 6 * 450_000 + 300_000);
        uint256[] memory fourStocks = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            fourStocks[i] = i << 248 | 1e8;
        }
        assertEq(g.capOf(SELL, fourStocks), 1_300_000 + 4 * 450_000 + 4 * 300_000);
    }

    /// The Rebalance band's losing side: the band, or the swap floor less the pool's 0.05% fee and 0.05% more.
    function test_the_tight_side_is_the_band_or_the_swap_floor_less_10_bps() public {
        assertEq(g.TIGHT_BPS(), 40);
        assertEq(new GooseGuard(owner, KEEPERHUB, 0, 300, 30, 100, 1e6, 1e6).TIGHT_BPS(), 20);
        assertEq(new GooseGuard(owner, KEEPERHUB, 0, 300, 50, 25, 1e6, 1e6).TIGHT_BPS(), 25);
    }

    /// Paused, SAVE, TRADE and CONVERT are refused with IsPaused before any check of their own; REPAY, SELL, END and
    /// REFRESH get past the pause and stop at their own (spec §8). Unpaused, SAVE, TRADE and CONVERT reach theirs.
    function test_pause_refuses_save_trade_and_convert_and_no_other_kind() public {
        _mockAave(account, 0, type(uint256).max);
        bytes4[7] memory paused = [
            GooseGuard.IsPaused.selector,
            GooseGuard.BadArgs.selector,
            GooseGuard.BadArgs.selector,
            GooseGuard.IsPaused.selector,
            GooseGuard.IsPaused.selector,
            GooseGuard.NotNeeded.selector,
            GooseGuard.NothingOwed.selector
        ];
        bytes4[7] memory open;
        for (uint256 kind; kind < 7; ++kind) {
            open[kind] = paused[kind] == GooseGuard.IsPaused.selector ? GooseGuard.BadArgs.selector : paused[kind];
        }

        vm.prank(owner);
        g.pause();
        for (uint8 kind; kind < 7; ++kind) {
            assertEq(_perform(KEEPERHUB, _moves(account, kind, 0))[0], paused[kind], "paused");
        }
        _rebalancer();
        assertEq(_trade(0, _rebal(1e8)), GooseGuard.IsPaused.selector, "a valid trade too");

        vm.prank(owner);
        g.unpause();
        for (uint8 kind; kind < 7; ++kind) {
            assertEq(_perform(KEEPERHUB, _moves(account, kind, 0))[0], open[kind], "unpaused");
        }
        assertEq(_trade(0, _rebal(1e8)), REBALANCED);
    }

    // ================================================================== SAVE

    /// SAVE supplies wallet cash past the $1 keep-back to the account's own Aave V3 savings: approve, then supply on
    /// the account's behalf.
    function test_save_supplies_wallet_cash_past_1_dollar_to_the_accounts_own_savings() public {
        PM.Permission memory p = _register(account, JOB_SAVE, _now() - 60);
        _mockCash(account, 51e6, 0);
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.Saved(account, 50e6);
        vm.prank(KEEPERHUB);
        g.performUpkeep(abi.encode(_args(account, SAVE, _one(type(uint256).max))));

        PM.Call[] memory calls = new PM.Call[](2);
        calls[0] = PM.Call(USDC, 0, abi.encodeCall(IERC20.approve, (V3_POOL, 50e6)));
        calls[1] = PM.Call(V3_POOL, 0, abi.encodeCall(IAaveV3Pool.supply, (USDC, 50e6, account, 0)));
        assertEq(ManagerDouble(MANAGER).lastHash(), keccak256(abi.encodeCall(PM.executeBatch, (p, calls))));

        assertEq(_perform(KEEPERHUB, _args(account, SAVE, _one(0)))[0], GooseGuard.NothingToMove.selector);
        assertEq(_perform(KEEPERHUB, _moves(account, SAVE, 2))[0], GooseGuard.BadArgs.selector);
        _mockCash(account, 1e6, 0);
        assertEq(_perform(KEEPERHUB, _args(account, SAVE, _one(1)))[0], GooseGuard.NothingToMove.selector, "$1 stays");
    }

    /// With top-ups on, SAVE only fills savings up to Keep; the rest waits in the wallet for the mix (decision 1).
    function test_with_top_ups_on_save_fills_savings_only_up_to_keep() public {
        _register(account, JOB_SAVE, _now() - 60);
        vm.prank(account);
        g.setTopUps(true, 30e6);
        _mockCash(account, 51e6, 10e6);
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.Saved(account, 20e6);
        vm.prank(KEEPERHUB);
        g.performUpkeep(abi.encode(_args(account, SAVE, _one(type(uint256).max))));

        _mockCash(account, 51e6, 30e6);
        assertEq(
            _perform(KEEPERHUB, _args(account, SAVE, _one(1)))[0], GooseGuard.NothingToMove.selector, "Keep is met"
        );
        vm.prank(account);
        g.setTopUps(false, 30e6);
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.Saved(account, 50e6);
        vm.prank(KEEPERHUB);
        g.performUpkeep(abi.encode(_args(account, SAVE, _one(type(uint256).max))));
    }

    // ================================================================== TRADE

    /// A rebalance: a sale down toward the target funds a buy of at most the sale's floor. The batch is the two legs'
    /// approve and swap each, in order, on Aerodrome at no less than Aave's price less 0.5%.
    function test_a_rebalance_sells_toward_the_target_and_buys_with_the_sales_floor() public {
        PM.Permission memory p = _rebalancer();
        uint256[7] memory sold;
        sold[5] = 4e8;
        uint256[7] memory bought;
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.Rebalanced(account, sold, bought);
        vm.prank(KEEPERHUB);
        g.performUpkeep(abi.encode(_tradeMove(0, _pair(_sale(5, 4e8), _buy(0, 398e6)))));

        PM.Call[] memory calls = new PM.Call[](4);
        calls[0] = PM.Call(_stock(5), 0, abi.encodeCall(IERC20.approve, (ROUTER, 4e8)));
        calls[1] = _aeroSwap(ROUTER, 10, _stock(5), USDC, 4e8, 398e6); // $400 less 0.5%
        calls[2] = PM.Call(USDC, 0, abi.encodeCall(IERC20.approve, (ROUTER, 398e6)));
        calls[3] = _aeroSwap(ROUTER, 10, USDC, _stock(0), 398e6, 3.9601e8); // 3.98 shares less 0.5%
        assertEq(ManagerDouble(MANAGER).lastHash(), keccak256(abi.encodeCall(PM.executeBatch, (p, calls))));
        assertEq(_acct(account).sessionAt, _now(), "a session opened");
    }

    /// Each leg is `r << 248 | isBuy << 247 | amount`: the bits between are clear, each stock trades once, sales come
    /// first and a top-up only buys. A stock outside the mix is refused with NotInMix.
    function test_trade_legs_decode_strictly() public {
        _rebalancer();
        vm.prank(account);
        g.setTopUps(true, 0);
        uint256 ok = _sale(5, 1e8);
        bytes4 bad = GooseGuard.BadArgs.selector;
        assertEq(_trade(0, _pair(ok, _buy(0, 99.5e6))), REBALANCED, "a clean leg");
        assertEq(_trade(0, _one(_sale(7, 1e8))), bad, "no reserve 7");
        assertEq(_trade(0, _one(_sale(255, 1e8))), bad, "no reserve 255");
        assertEq(_trade(0, _one(_sale(5, 0))), bad, "nothing to trade");
        assertEq(_trade(0, _one(ok | 1 << 128)), bad, "bit 128");
        assertEq(_trade(0, _one(ok | 1 << 246)), bad, "bit 246");
        assertEq(_trade(0, _pair(ok, _sale(5, 2e8))), bad, "the same stock twice");
        assertEq(_trade(10e6, _pair(_buy(0, 1e6), _sale(5, 1e8))), bad, "a sale after a buy");
        assertEq(_trade(10e6, _one(_sale(5, 1e8))), bad, "a sale in a top-up");
        assertEq(_trade(0, _one(_sale(3, 1e8))), GooseGuard.NotInMix.selector, "a sale outside the mix");
        assertEq(_trade(10e6, _one(_buy(3, 1e6))), GooseGuard.NotInMix.selector, "a buy outside the mix");
        assertEq(_perform(KEEPERHUB, _moves(account, TRADE, 1))[0], bad, "no leg");
        assertEq(_perform(KEEPERHUB, _moves(account, TRADE, 9))[0], bad, "more legs than stocks");
        assertEq(_perform(KEEPERHUB, _args(other, TRADE, _pair(0, ok)))[0], GooseGuard.NoMix.selector, "no mix");
    }

    /// Every trade moves its stock toward its target and stops there; the buys spend no more than the sales' floors
    /// plus the top-up.
    function test_every_trade_moves_its_stock_toward_its_target_and_stops_there() public {
        _rebalancer(); // NVDA $500 over its target, AAPL $500 under
        bytes4 crossed = GooseGuard.Crossed.selector;
        assertEq(_trade(0, _one(_sale(5, 5e8 + 1))), crossed, "a sale past the target");
        assertEq(_trade(0, _one(_sale(0, 1))), crossed, "a sale of a stock under its target");
        assertEq(_trade(0, _pair(_sale(5, 1e8), _buy(0, 99.5e6 + 1))), GooseGuard.CashOut.selector, "past the floor");
        assertEq(_trade(0, _pair(_sale(5, 1e8), _buy(0, 99.5e6))), REBALANCED, "the floor exactly");
        assertEq(_trade(0, _rebal(5e8)), REBALANCED, "down to the target exactly");

        // A $1,500 top-up: the total is $2,500, each target $1,250. NVDA is $250 under, AAPL $1,250 under.
        vm.prank(account);
        g.setTopUps(true, 0);
        _mockCash(account, 10_001e6, 0);
        assertEq(_trade(1_500e6, _one(_buy(0, 1_250e6 + 1))), crossed, "a buy past the target");
        assertEq(_trade(1_500e6, _one(_buy(0, 1_250e6))), INVESTED);
        assertEq(_trade(100e6, _one(_buy(0, 100e6 + 1))), GooseGuard.CashOut.selector, "past the top-up");
        _mockStock(account, 5, 20e8); // NVDA now $2,000, over a $1,050 target
        assertEq(_trade(100e6, _one(_buy(5, 1))), crossed, "a buy of a stock over its target");
    }

    /// A move that sells opens a session at most once every 20 hours and sells only in its first hour, unless the user
    /// sets a new mix. A top-up that only buys is never held back (decision 4).
    function test_rebalance_sells_in_one_hour_session_every_20_hours_unless_the_mix_is_new() public {
        _rebalancer();
        vm.prank(account);
        g.setTopUps(true, 0);
        uint256[] memory sale = _rebal(1e8);
        bytes4 paced = GooseGuard.Paced.selector;
        uint256 t = _now();
        assertEq(_trade(0, sale), REBALANCED);
        assertEq(_acct(account).sessionAt, t);
        vm.warp(t + 1 hours - 1);
        assertEq(_trade(0, sale), REBALANCED, "within the session's hour");
        vm.warp(t + 1 hours);
        assertEq(_trade(0, sale), paced, "the hour is over");
        assertEq(_trade(10e6, _one(_buy(0, 10e6))), INVESTED, "a top-up is never paced");
        vm.warp(t + 20 hours - 1);
        assertEq(_trade(0, sale), paced);
        vm.warp(t + 20 hours);
        assertEq(_trade(0, sale), REBALANCED, "20 hours on, a new session");
        assertEq(_acct(account).sessionAt, t + 20 hours);
        vm.warp(t + 22 hours);
        assertEq(_trade(0, sale), paced);
        uint112 mix = _set(account).mix; // the same weights, set again
        vm.prank(account);
        g.setMix(mix);
        assertEq(_trade(0, sale), REBALANCED, "a new mix opens a session at once");
        assertEq(_acct(account).sessionAt, t + 22 hours);
    }

    /// The pool must agree with Aave's price within the band on the side that favours the account, and within the
    /// tight side (0.40%) on the side that costs it, past which the 0.5% floor can't fill after the pool's fee.
    function test_trade_band_is_tight_on_the_side_that_costs_the_account() public {
        _rebalancer();
        vm.prank(account);
        g.setTopUps(true, 0);
        bytes4 off = GooseGuard.OffBand.selector;
        uint256[] memory sale = _rebal(1e8); // its buy's pool sits on Aave's price
        uint256[] memory buy = _one(_buy(0, 10e6));
        _mockPool(5, -35);
        assertEq(_trade(0, sale), REBALANCED, "a sale, the pool 0.35% under");
        _mockPool(5, -45);
        assertEq(_trade(0, sale), off, "a sale, 0.45% under");
        _mockPool(5, 95);
        assertEq(_trade(0, sale), REBALANCED, "a sale, 0.95% over");
        _mockPool(5, 105);
        assertEq(_trade(0, sale), off, "a sale, 1.05% over");
        _mockPool(0, 35);
        assertEq(_trade(10e6, buy), INVESTED, "a buy, 0.35% over");
        _mockPool(0, 45);
        assertEq(_trade(10e6, buy), off, "a buy, 0.45% over");
        _mockPool(0, -95);
        assertEq(_trade(10e6, buy), INVESTED, "a buy, 0.95% under");
        _mockPool(0, -105);
        assertEq(_trade(10e6, buy), off, "a buy, 1.05% under");
    }

    /// A top-up goes into the mix only with top-ups on, out of a rescue, at health max(1.10, line) or more when
    /// something is owed, and from wallet cash past $1 and past what Keep still needs in savings.
    function test_a_top_up_needs_top_ups_on_no_rescue_enough_health_and_spare_cash() public {
        _rebalancer(); // $101 in the wallet, nothing in savings, nothing owed
        uint256[] memory buy = _one(_buy(0, 10e6));
        assertEq(_trade(10e6, buy), GooseGuard.NotTopUp.selector, "top-ups off");
        vm.prank(account);
        g.setTopUps(true, 0);
        assertEq(_trade(10e6, buy), INVESTED);
        assertEq(_trade(100e6, _one(_buy(0, 100e6))), INVESTED, "all but $1");
        assertEq(_trade(100e6 + 1, buy), GooseGuard.TooMuch.selector, "into the $1");

        vm.prank(account);
        g.setTopUps(true, 50e6); // Keep still needs $50 in savings
        assertEq(_trade(50e6, buy), INVESTED);
        assertEq(_trade(50e6 + 1, buy), GooseGuard.TooMuch.selector, "into Keep");
        _mockCash(account, 101e6, 50e6);
        assertEq(_trade(100e6, buy), INVESTED, "Keep is met");

        _startRescue(account, _now() - 1 hours);
        assertEq(_trade(10e6, buy), GooseGuard.RescueOn.selector);
        _startRescue(account, _now() - 7 days - 1);
        assertEq(_trade(10e6, buy), INVESTED, "a rescue past its 7 days");

        _mockAave(account, 100e6, 1.0999e18);
        assertEq(_trade(10e6, buy), GooseGuard.HealthTooLow.selector, "under 1.10");
        _mockAave(account, 100e6, 1.1e18);
        assertEq(_trade(10e6, buy), INVESTED);
        vm.prank(account);
        g.setProtect(11_500, 12_500);
        assertEq(_trade(10e6, buy), GooseGuard.HealthTooLow.selector, "under the user's own line");
        _mockAave(account, 100e6, 1.15e18);
        assertEq(_trade(10e6, buy), INVESTED);
    }

    /// After the batch the wallet's cash fell by at most the top-up; every mix stock needs Aave's price.
    function test_trade_refuses_a_cash_drop_past_the_top_up_and_a_mix_stock_without_a_price() public {
        _rebalancer();
        vm.prank(account);
        g.setTopUps(true, 0);
        _mockCashSteps(account, [uint256(101e6), 101e6 - 1]);
        assertEq(_trade(0, _rebal(1e8)), GooseGuard.CashLower.selector, "a rebalance");
        _mockCashSteps(account, [uint256(101e6), 101e6, 91e6 - 1]);
        assertEq(_trade(10e6, _one(_buy(0, 10e6))), GooseGuard.CashLower.selector, "a top-up");
        _mockCashSteps(account, [uint256(101e6), 101e6, 91e6]);
        assertEq(_trade(10e6, _one(_buy(0, 10e6))), INVESTED);

        vm.mockCall(ORACLE, abi.encodeCall(IAaveOracle.getReservePrice, (0)), abi.encode(0));
        assertEq(_trade(0, _one(_sale(5, 1e8))), GooseGuard.NoPrice.selector, "AAPL unpriced, NVDA traded");
    }

    /// GG-06: a move that sells also buys, and its buys spend the sales' floors to within 10 units of rounding, so a
    /// runner can't take free stock to cash. A refused one opens no session. A top-up only buys and keeps its rules.
    function test_a_trade_that_sells_must_buy_with_the_sales_floors() public {
        _rebalancer(); // NVDA $500 over its target, AAPL $500 under; a one-share sale's floor is $99.50
        vm.prank(account);
        g.setTopUps(true, 0);
        bytes4 toCash = GooseGuard.SellsToCash.selector;
        assertEq(_trade(0, _one(_sale(5, 1e8))), toCash, "a sale alone");
        assertEq(_trade(0, _one(_sale(5, 5e8))), toCash, "a sale alone, down to the target");
        assertEq(_acct(account).sessionAt, 0, "a refused sale opens no session");
        assertEq(_trade(0, _pair(_sale(5, 1e8), _buy(0, 1e6))), toCash, "a token buy");
        assertEq(_trade(0, _pair(_sale(5, 1e8), _buy(0, 99.5e6 - 11))), toCash, "11 units of the floor left");
        assertEq(_trade(0, _pair(_sale(5, 1e8), _buy(0, 99.5e6 - 10))), REBALANCED, "10 units: rounding");
        assertEq(_trade(0, _rebal(1e8)), REBALANCED, "the floor exactly");
        assertEq(_trade(0, _rebal(5e8)), REBALANCED, "down to the target, all of it bought back");
        assertEq(_trade(10e6, _one(_buy(0, 10e6))), INVESTED, "a top-up");
        assertEq(_trade(10e6, _one(_buy(0, 4e6))), INVESTED, "a top-up may leave cash: it only buys");
    }

    /// The audit's drain on the unit book: 23 sell-only moves in one session, each refused, so the stock stays put.
    function test_sell_only_moves_in_a_row_are_all_refused() public {
        _rebalancer();
        for (uint256 i; i < 23; ++i) {
            vm.warp(_now() + 60);
            assertEq(_trade(0, _one(_sale(5, 1e8))), GooseGuard.SellsToCash.selector);
        }
        assertEq(_trade(0, _rebal(1e8)), REBALANCED, "an honest rebalance still runs");
    }

    // ================================================================== CONVERT

    function test_convert_takes_a_coin_from_0_to_4_and_an_amount_the_wallet_holds() public {
        _register(account, JOB_ENTRY, _now() - 60);
        _mockCoin(account, 0, 0);
        bytes4 bad = GooseGuard.BadArgs.selector;
        assertEq(_convert(5, 1e6), bad, "no coin 5");
        assertEq(_convert(type(uint256).max, 1e6), bad);
        assertEq(_perform(KEEPERHUB, _args(account, CONVERT, _one(0)))[0], bad, "one arg");
        assertEq(_perform(KEEPERHUB, _moves(account, CONVERT, 3))[0], bad, "three args");
        assertEq(_convert(0, 1e6), GooseGuard.NothingToMove.selector, "no USDT in the wallet");
        _mockCoin(account, 0, 5e6);
        assertEq(_convert(0, 0), GooseGuard.NothingToMove.selector, "nothing asked");
    }

    /// Each coin on its own venue at no less than 99.5% of face value, rounded up for the account (EURC at Chainlink's
    /// EUR/USD); one unit of USDC short of that floor is refused. Amounts are clamped to what the wallet holds.
    function test_convert_takes_at_least_99_5_percent_of_face_value_on_each_coins_venue() public {
        PM.Permission memory p = _register(account, JOB_ENTRY, _now() - 60);
        _mockFeed(1.08e8, _now());
        uint256[5] memory amountIn = [uint256(1e8 + 1), 100e18 + 1, 100e18, 100e18, 1e8 + 1];
        uint256[5] memory minOut = [uint256(99_500_001), 99_500_001, 99_500_000, 99_500_000, 107_460_002];
        for (uint256 k; k < 5; ++k) {
            _mockCoin(account, k, amountIn[k]);
            _mockCashSteps(account, [uint256(1_000e6), 1_000e6 + minOut[k] - 1]);
            assertEq(_convert(k, type(uint256).max), GooseGuard.BelowFloor.selector, "a unit short");

            _mockCashSteps(account, [uint256(1_000e6), 1_000e6 + minOut[k]]);
            vm.expectEmit(true, true, false, true, address(g));
            emit GooseGuard.EntryConverted(account, _coin(k), amountIn[k], minOut[k]);
            vm.prank(KEEPERHUB);
            g.performUpkeep(abi.encode(_args(account, CONVERT, _pair(k, type(uint256).max))));
            assertEq(
                ManagerDouble(MANAGER).lastHash(),
                keccak256(abi.encodeCall(PM.executeBatch, (p, _convertCalls(k, amountIn[k], minOut[k])))),
                "the coin's own venue"
            );
        }
    }

    /// EURC needs a positive EUR/USD answer at most 2 hours old (decision 10); the dollar coins never read it.
    function test_eurc_needs_a_positive_eur_usd_price_at_most_2_hours_old() public {
        _register(account, JOB_ENTRY, _now() - 60);
        _mockCoin(account, 4, 100e6);
        _mockCoin(account, 0, 100e6);
        _mockCash(account, 1_000e6, 0); // no USDC comes in: a move that gets past the feed stops at the floor
        bytes4 past = GooseGuard.BelowFloor.selector;
        bytes4 stale = GooseGuard.StaleFeed.selector;
        _mockFeed(1.08e8, _now() - 2 hours);
        assertEq(_convert(4, 100e6), past, "2 hours old");
        _mockFeed(1.08e8, _now() - 2 hours - 1);
        assertEq(_convert(4, 100e6), stale, "a second older");
        assertEq(_convert(0, 100e6), past, "USDT doesn't read it");
        _mockFeed(0, _now());
        assertEq(_convert(4, 100e6), stale, "a zero price");
        _mockFeed(-1, _now());
        assertEq(_convert(4, 100e6), stale, "a negative price");
    }

    // ================================================================== REFRESH

    /// REFRESH moves the account to Aave's latest collateral config, under the Protect · sell permission, only when
    /// that raises health (spec §4.7). Pause never stops it.
    function test_refresh_applies_aaves_latest_config_only_when_it_raises_health() public {
        PM.Permission memory p = _register(account, JOB_SELL, _now() - 60);
        _mockAave(account, 0, type(uint256).max);
        assertEq(_perform(KEEPERHUB, _moves(account, REFRESH, 0))[0], GooseGuard.NothingOwed.selector);
        _mockAave(account, 100e6, 1.05e18);
        assertEq(_perform(KEEPERHUB, _moves(account, REFRESH, 0))[0], GooseGuard.NoGain.selector, "unchanged");
        _mockAave(account, [uint256(100e6), 100e6], [uint256(1.05e18), 1.04e18]);
        assertEq(_perform(KEEPERHUB, _moves(account, REFRESH, 0))[0], GooseGuard.NoGain.selector, "lower");

        vm.prank(owner);
        g.pause();
        _mockAave(account, [uint256(100e6), 100e6], [uint256(1.05e18), 1.2e18]);
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.ConfigRefreshed(account, 1.05e18, 1.2e18);
        vm.prank(KEEPERHUB);
        g.performUpkeep(abi.encode(_moves(account, REFRESH, 0)));
        PM.Call[] memory calls = new PM.Call[](1);
        calls[0] = PM.Call(SPOKE, 0, abi.encodeCall(ISpoke.updateUserDynamicConfig, (account)));
        assertEq(ManagerDouble(MANAGER).lastHash(), keccak256(abi.encodeCall(PM.executeBatch, (p, calls))));
    }

    // ================================================================== SELL's checks before the batch

    /// Each leg is `r << 248 | shares` with the bits between clear, at most 16 of them; only stock that backs the
    /// credit; Aave prices it; the pool within 1% of Aave's price either way; a slice worth a floor. A sale that passes
    /// them all gets to the batch (here: no grant).
    function test_sell_refuses_bad_legs_stock_backing_nothing_and_a_pool_off_the_band() public {
        _mockAave(account, 100e6, 1e18);
        _mockStock(account, 5, 0);
        vm.mockCall(SPOKE, abi.encodeCall(ISpoke.getUserReserveStatus, (5, account)), abi.encode(true, true));
        vm.mockCall(SPOKE, abi.encodeCall(ISpoke.getUserReserveStatus, (3, account)), abi.encode(false, false));
        uint256 ok = _sale(5, 1e8);
        bytes4 bad = GooseGuard.BadArgs.selector;
        bytes4 batch = GooseGuard.NoGrant.selector;
        assertEq(_sellOutcome(_one(ok)), batch, "a clean leg");
        assertEq(_sellOutcome(_pair(ok, ok)), batch, "a stock in two slices");
        assertEq(_sellOutcome(_one(_sale(7, 1e8))), bad, "no reserve 7");
        assertEq(_sellOutcome(_one(_sale(5, 0))), bad, "no shares");
        assertEq(_sellOutcome(_one(ok | 1 << 128)), bad, "bit 128");
        assertEq(_sellOutcome(_one(ok | 1 << 247)), bad, "no buy flag in a sale");
        assertEq(_perform(KEEPERHUB, _moves(account, SELL, 17), 10_000_000)[0], bad, "17 legs");
        assertEq(_sellOutcome(_one(_sale(3, 1e8))), GooseGuard.NotCollateral.selector);
        assertEq(_sellOutcome(_one(_sale(5, 1))), GooseGuard.BelowFloor.selector, "a slice worth no floor");

        _mockPool(5, -95);
        assertEq(_sellOutcome(_one(ok)), batch, "0.95% under");
        _mockPool(5, -105);
        assertEq(_sellOutcome(_one(ok)), GooseGuard.OffBand.selector, "1.05% under");
        _mockPool(5, 95);
        assertEq(_sellOutcome(_one(ok)), batch, "0.95% over");
        _mockPool(5, 105);
        assertEq(_sellOutcome(_one(ok)), GooseGuard.OffBand.selector, "1.05% over");
        vm.mockCall(ORACLE, abi.encodeCall(IAaveOracle.getReservePrice, (5)), abi.encode(0));
        assertEq(_sellOutcome(_one(ok)), GooseGuard.NoPrice.selector);
    }

    // ================================================================== helpers: TRADE, CONVERT and SELL

    /// A 50/50 AAPL/NVDA mix with 10 NVDA in the wallet at $100 and no AAPL: NVDA is $500 over its target and AAPL $500
    /// under. $101 of cash, nothing in savings, nothing owed, and the Rebalance agent registered.
    function _rebalancer() internal returns (PM.Permission memory p) {
        vm.prank(account);
        g.setMix(_pack([uint16(5_000), 0, 0, 0, 0, 5_000, 0]));
        _mockStock(account, 0, 0);
        _mockStock(account, 5, 10e8);
        _mockCash(account, 101e6, 0);
        _mockAave(account, 0, type(uint256).max);
        p = _register(account, JOB_REBALANCE, _now() - 60);
    }

    function _sale(uint256 r, uint256 shares) internal pure returns (uint256) {
        return r << 248 | shares;
    }

    function _buy(uint256 r, uint256 usdc) internal pure returns (uint256) {
        return r << 248 | 1 << 247 | usdc;
    }

    /// An honest rebalance on `_rebalancer`'s book: sell `shares` of NVDA, buy AAPL with exactly the sale's floor.
    function _rebal(uint256 shares) internal pure returns (uint256[] memory) {
        return _pair(_sale(5, shares), _buy(0, shares * PRICE * (1e4 - 50) / 1e14));
    }

    function _tradeMove(uint256 invest, uint256[] memory legs) internal view returns (GooseGuard.Move[] memory) {
        uint256[] memory args = new uint256[](legs.length + 1);
        args[0] = invest;
        for (uint256 i; i < legs.length; ++i) {
            args[i + 1] = legs[i];
        }
        return _args(account, TRADE, args);
    }

    function _trade(uint256 invest, uint256[] memory legs) internal returns (bytes4) {
        return _perform(KEEPERHUB, _tradeMove(invest, legs))[0];
    }

    function _sellOutcome(uint256[] memory legs) internal returns (bytes4) {
        return _perform(KEEPERHUB, _args(account, SELL, legs))[0];
    }

    function _convert(uint256 k, uint256 amount) internal returns (bytes4) {
        return _perform(KEEPERHUB, _args(account, CONVERT, _pair(k, amount)))[0];
    }

    /// Stock r at $100 on Aave and in its pool, with `shares` in the wallet.
    function _mockStock(address a, uint256 r, uint256 shares) internal {
        vm.etch(ORACLE, hex"00");
        vm.etch(_stock(r), hex"00");
        vm.mockCall(ORACLE, abi.encodeCall(IAaveOracle.getReservePrice, (r)), abi.encode(PRICE));
        vm.mockCall(_stock(r), abi.encodeCall(IERC20.balanceOf, (a)), abi.encode(shares));
        _mockPool(r, 0);
    }

    /// Stock r's pool `offBps` basis points off Aave's $100: slot0's √price as the Guard reads it (USDC is token0).
    function _mockPool(uint256 r, int256 offBps) internal {
        uint256 price = uint256(int256(PRICE) * (1e4 + offBps) / 1e4);
        uint256 q = _sqrt(price * 1e10);
        uint160 sqrtPriceX96 = uint160((uint256(1) << 96) * 1e10 / q);
        vm.etch(_pool(r), hex"00");
        vm.mockCall(
            _pool(r),
            abi.encodeCall(IAeroPool.slot0, ()),
            abi.encode(sqrtPriceX96, int24(0), uint16(0), uint16(0), uint16(0), true)
        );
    }

    function _mockCoin(address a, uint256 k, uint256 amount) internal {
        vm.etch(_coin(k), hex"00");
        vm.mockCall(_coin(k), abi.encodeCall(IERC20.balanceOf, (a)), abi.encode(amount));
    }

    /// The wallet's USDC, read by read: the last value repeats.
    function _mockCashSteps(address a, uint256[2] memory steps) internal {
        uint256[] memory all = new uint256[](2);
        all[0] = steps[0];
        all[1] = steps[1];
        _mockCashSteps(a, all);
    }

    function _mockCashSteps(address a, uint256[3] memory steps) internal {
        uint256[] memory all = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            all[i] = steps[i];
        }
        _mockCashSteps(a, all);
    }

    function _mockCashSteps(address a, uint256[] memory steps) internal {
        bytes[] memory data = new bytes[](steps.length);
        for (uint256 i; i < steps.length; ++i) {
            data[i] = abi.encode(steps[i]);
        }
        vm.etch(USDC, hex"00");
        vm.mockCalls(USDC, abi.encodeCall(IERC20.balanceOf, (a)), data);
    }

    function _mockFeed(int256 answer, uint256 updatedAt) internal {
        vm.etch(EUR_USD, hex"00");
        vm.mockCall(
            EUR_USD,
            abi.encodeCall(IChainlinkFeed.latestRoundData, ()),
            abi.encode(uint80(1), answer, uint256(0), updatedAt, uint80(1))
        );
    }

    /// An Aerodrome Slipstream swap paid to the account, as the Guard writes it.
    function _aeroSwap(
        address router,
        int24 tickSpacing,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) internal view returns (PM.Call memory) {
        IAeroRouter.ExactInputSingleParams memory swap = IAeroRouter.ExactInputSingleParams(
            tokenIn, tokenOut, tickSpacing, account, _now(), amountIn, minOut, 0
        );
        return PM.Call(router, 0, abi.encodeCall(IAeroRouter.exactInputSingle, (swap)));
    }

    /// spec §4.5's venues: USDT and EURC on Aerodrome v1 at tick spacing 1, USDe and DAI on Uniswap at fee 500 and
    /// 100, USDS on PSM3.
    function _convertCalls(uint256 k, uint256 amountIn, uint256 minOut) internal view returns (PM.Call[] memory c) {
        address coin = _coin(k);
        c = new PM.Call[](2);
        if (k == 1 || k == 3) {
            c[0] = PM.Call(coin, 0, abi.encodeCall(IERC20.approve, (UNISWAP_ROUTER, amountIn)));
            IUniswapRouter.ExactInputSingleParams memory swap = IUniswapRouter.ExactInputSingleParams(
                coin, USDC, k == 1 ? uint24(500) : uint24(100), account, amountIn, minOut, 0
            );
            c[1] = PM.Call(UNISWAP_ROUTER, 0, abi.encodeCall(IUniswapRouter.exactInputSingle, (swap)));
        } else if (k == 2) {
            c[0] = PM.Call(coin, 0, abi.encodeCall(IERC20.approve, (PSM3, amountIn)));
            c[1] = PM.Call(PSM3, 0, abi.encodeCall(IPsm3.swapExactIn, (coin, USDC, amountIn, minOut, account, 0)));
        } else {
            c[0] = PM.Call(coin, 0, abi.encodeCall(IERC20.approve, (AERODROME_V1_ROUTER, amountIn)));
            c[1] = _aeroSwap(AERODROME_V1_ROUTER, 1, coin, USDC, amountIn, minOut);
        }
    }

    /// The stocks, their pools and the cash coins, as GooseGuard pins them (step0-facts.md).
    function _stock(uint256 r) internal pure returns (address) {
        return [
            0xb200000000000000000000C2e324d24d7eEcd1fb,
            0xb200000000000000000000d9192b6B456483C2E8,
            0xb2000000000000000000002D0BA3164cc74f58B7,
            0xb2000000000000000000008bC8786B856E61707C,
            0xB200000000000000000000Ab99cFa739E253872B,
            0xb20000000000000000000078ee7ce2fE4908108C,
            0xb2000000000000000000001e800a7f5189430cD0
        ][r];
    }

    function _pool(uint256 r) internal pure returns (address) {
        return [
            0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0,
            0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b,
            0xB1987CAD1682841b4b641d50E520777eC5Ab5542,
            0xEAF57753BC382E0324a1D43F72E7027705a2273E,
            0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54,
            0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9,
            0x469337fDcc5E8f38e2E4B670B04F57865D13a7BB
        ][r];
    }

    function _coin(uint256 k) internal pure returns (address) {
        return [
            0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2, // USDT
            0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34, // USDe
            0x820C137fa70C8691f0e44Dc420a5e53c168921Dc, // USDS
            0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb, // DAI
            0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42 // EURC
        ][k];
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    // ================================================================== helpers: moves

    function _moves(address a, uint8 kind, uint256 nArgs) internal pure returns (GooseGuard.Move[] memory m) {
        m = new GooseGuard.Move[](1);
        m[0] = GooseGuard.Move(a, kind, new uint256[](nArgs));
    }

    function _and(GooseGuard.Move[] memory m, address a, uint8 kind, uint256 nArgs)
        internal
        pure
        returns (GooseGuard.Move[] memory out)
    {
        out = new GooseGuard.Move[](m.length + 1);
        for (uint256 i; i < m.length; ++i) {
            out[i] = m[i];
        }
        out[m.length] = GooseGuard.Move(a, kind, new uint256[](nArgs));
    }

    function _args(address a, uint8 kind, uint256[] memory args) internal pure returns (GooseGuard.Move[] memory m) {
        m = new GooseGuard.Move[](1);
        m[0] = GooseGuard.Move(a, kind, args);
    }

    function _one(uint256 x) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = x;
    }

    function _pair(uint256 x, uint256 y) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = x;
        a[1] = y;
    }

    function _repay(address a, uint256 fromWallet, uint256 fromSavings)
        internal
        pure
        returns (GooseGuard.Move[] memory m)
    {
        m = _moves(a, REPAY, 2);
        m[0].args[0] = fromWallet;
        m[0].args[1] = fromSavings;
    }

    function _perform(address from, GooseGuard.Move[] memory moves) internal returns (bytes4[] memory) {
        return _perform(from, abi.encode(moves));
    }

    function _perform(address from, GooseGuard.Move[] memory moves, uint256 gas) internal returns (bytes4[] memory) {
        vm.recordLogs();
        vm.prank(from);
        g.performUpkeep{gas: gas}(abi.encode(moves));
        return _outcomes(vm.getRecordedLogs());
    }

    function _perform(address from, bytes memory performData) internal returns (bytes4[] memory) {
        vm.recordLogs();
        vm.prank(from);
        g.performUpkeep(performData);
        return _outcomes(vm.getRecordedLogs());
    }

    /// What each move came to, in order: a refused move's reason, or the event of a move that ran (ENDED, REPAID).
    function _outcomes(Vm.Log[] memory logs) internal view returns (bytes4[] memory out) {
        out = new bytes4[](logs.length);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(g)) continue;
            out[n++] = logs[i].topics[0] == REFUSED ? abi.decode(logs[i].data, (bytes4)) : bytes4(logs[i].topics[0]);
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    /// Starts a rescue as Protect would leave it: `rescueAt` sits at bits [32, 64) of the account's slot.
    function _startRescue(address a, uint256 at) internal {
        bytes32 slot = keccak256(abi.encode(a, ACCOUNTS_SLOT));
        uint256 word = uint256(vm.load(address(g), slot)) & ~(uint256(type(uint32).max) << 32);
        vm.store(address(g), slot, bytes32(word | at << 32));
        uint32 rescueAt = _acct(a).rescueAt;
        assertEq(rescueAt, at, "the slot layout moved");
    }

    // ================================================================== helpers: Aave and the wallet, mocked

    /// The same reading on every call.
    function _mockAave(address a, uint256 debt, uint256 hf) internal {
        vm.etch(SPOKE, hex"00");
        vm.mockCall(SPOKE, abi.encodeCall(ISpoke.getUserTotalDebt, (7, a)), abi.encode(debt));
        vm.mockCall(SPOKE, abi.encodeCall(ISpoke.getUserAccountData, (a)), abi.encode(_reading(hf)));
    }

    /// One reading before the batch and another after it.
    function _mockAave(address a, uint256[2] memory debt, uint256[2] memory hf) internal {
        vm.etch(SPOKE, hex"00");
        bytes[] memory debts = new bytes[](2);
        bytes[] memory data = new bytes[](2);
        for (uint256 i; i < 2; ++i) {
            debts[i] = abi.encode(debt[i]);
            data[i] = abi.encode(_reading(hf[i]));
        }
        vm.mockCalls(SPOKE, abi.encodeCall(ISpoke.getUserTotalDebt, (7, a)), debts);
        vm.mockCalls(SPOKE, abi.encodeCall(ISpoke.getUserAccountData, (a)), data);
    }

    /// $1,000 of stock at a 0.70 factor: far past dust, so a full payoff is never allowed here.
    function _reading(uint256 hf) internal pure returns (ISpoke.UserAccountData memory d) {
        d.healthFactor = hf;
        d.avgCollateralFactor = 0.7e18;
        d.totalCollateralValue = 1_000e26;
    }

    function _mockCash(address a, uint256 cash, uint256 savings) internal {
        vm.etch(USDC, hex"00");
        vm.etch(AUSDC, hex"00");
        vm.mockCall(USDC, abi.encodeCall(IERC20.balanceOf, (a)), abi.encode(cash));
        vm.mockCall(AUSDC, abi.encodeCall(IERC20.balanceOf, (a)), abi.encode(savings));
    }

    // ================================================================== helpers: permissions

    /// A permission shaped like the app's, with `nCalls` call entries and `nSpends` spend limits drawn from `seed`.
    function _permission(address guard, address a, uint256 start, uint256 nCalls, uint256 nSpends, uint256 seed)
        internal
        view
        returns (PM.Permission memory)
    {
        PM.CallPermission[] memory calls = new PM.CallPermission[](nCalls);
        for (uint256 i; i < nCalls; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, "call", i)));
            calls[i] = PM.CallPermission(
                address(uint160(r)), bytes4(bytes32(r)), i % 2 == 0 ? address(0) : address(uint160(r >> 96))
            );
        }
        PM.SpendLimit[] memory spends = new PM.SpendLimit[](nSpends);
        for (uint256 i; i < nSpends; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, "spend", i)));
            spends[i] =
                PM.SpendLimit(address(uint160(r)), uint160(r >> 96), PM.PeriodUnit((r >> 160) % 6), uint16(r >> 240));
        }
        uint256 salt = uint256(keccak256(abi.encode(seed, "salt")));
        return PM.Permission(a, guard, uint48(start), uint48(_now() + 365 days), salt, calls, spends);
    }

    function _register(address a, uint8 job, uint256 start) internal returns (PM.Permission memory p) {
        p = _permission(address(g), a, start, 3, 2, start);
        vm.prank(a);
        g.register(job, abi.encode(p));
    }

    function _registerExpect(address a, uint8 job, uint256 start, bytes4 err) internal {
        PM.Permission memory p = _permission(address(g), a, start, 3, 2, start + 1);
        vm.expectRevert(err);
        vm.prank(a);
        g.register(job, abi.encode(p));
    }

    /// Registers raw bytes for job 0 as the pranked caller; `err` 0 means it must pass.
    function _registerRaw(bytes memory permission, bytes4 err) internal {
        if (err != bytes4(0)) vm.expectRevert(err);
        g.register(0, permission);
    }

    /// `len` bytes laid out like abi.encode(Permission)'s head: the offset, account, spender, start, end; zeros after.
    function _head(uint256 len, uint256 a, uint256 spender, uint256 start, uint256 end)
        internal
        pure
        returns (bytes memory)
    {
        return _headWord0(0x20, a, spender, start, end, len);
    }

    function _headWord0(uint256 word0, uint256 a, uint256 spender, uint256 start, uint256 end)
        internal
        pure
        returns (bytes memory)
    {
        return _headWord0(word0, a, spender, start, end, 320);
    }

    function _headWord0(uint256 word0, uint256 a, uint256 spender, uint256 start, uint256 end, uint256 len)
        internal
        pure
        returns (bytes memory)
    {
        return bytes.concat(abi.encode(word0, a, spender, start, end), new bytes(len - 160));
    }

    /// Called directly, with no gas cap, so the manager's stand-in keeps the whole calldata for a byte diff.
    function _harness() internal returns (GuardHarness) {
        ManagerDouble(MANAGER).recordAll();
        return new GuardHarness(owner, KEEPERHUB, account.codehash);
    }

    /// 0–6 calls, each to a random target with 0–160 bytes of random data and sometimes a value.
    function _calls(uint256 seed) internal pure returns (PM.Call[] memory calls) {
        calls = new PM.Call[](seed % 7);
        for (uint256 i; i < calls.length; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            calls[i] = PM.Call(address(uint160(r)), r % 3 == 0 ? r >> 192 : 0, _bytes(r, (r >> 160) % 161));
        }
    }

    function _bytes(uint256 seed, uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        bytes32 w;
        for (uint256 i; i < n; ++i) {
            if (i % 32 == 0) w = keccak256(abi.encode(seed, i));
            b[i] = w[i % 32];
        }
    }

    // ================================================================== helpers: settings and owner

    function _acct(address a) internal view returns (GooseGuard.Account memory acc) {
        (acc,) = g.accountOf(a);
    }

    function _set(address a) internal view returns (GooseGuard.Settings memory s) {
        (, s) = g.accountOf(a);
    }

    /// The agent's high-water start: word 3 of its stored permission, which `register` writes with it.
    function _startOf(address a, uint8 job) internal view returns (uint256 start) {
        bytes memory p = g.permissionOf(a, job);
        assembly ("memory-safe") {
            start := mload(add(p, 0x80))
        }
    }

    function _pack(uint16[7] memory weights) internal pure returns (uint112 mix) {
        for (uint256 r; r < 7; ++r) {
            mix |= uint112(weights[r]) << (16 * r);
        }
    }

    function _badMix(uint112 mix) internal {
        vm.expectRevert(GooseGuard.BadMix.selector);
        vm.prank(account);
        g.setMix(mix);
    }

    function _lines(uint16 line, uint16 target, bool ok) internal {
        if (!ok) vm.expectRevert(GooseGuard.BadLines.selector);
        vm.prank(account);
        g.setProtect(line, target);
        if (!ok) return;
        (uint256 l, uint256 t) = g.linesOf(account);
        if (line == 0) {
            assertEq(l, 1.03e18);
            assertEq(t, 1.12e18);
        } else {
            assertEq(l, uint256(line) * 1e14);
            assertEq(t, uint256(target) * 1e14);
        }
    }

    /// A change's id: keccak256(abi.encode(epoch, kind, arg)).
    function _id(uint32 epoch, uint8 kind, bytes32 arg) internal pure returns (bytes32) {
        return keccak256(abi.encode(epoch, kind, arg));
    }

    function _arg(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _applyAfterDelay(uint8 kind, bytes32 arg) internal {
        vm.prank(owner);
        g.queueChange(kind, arg);
        vm.warp(_now() + 48 hours);
        vm.prank(stranger);
        g.applyChange(kind, arg);
    }

    function _deploys(address o, address r, uint256[5] memory n) internal {
        GooseGuard d = new GooseGuard(o, r, bytes32(0), n[0], n[1], n[2], n[3], n[4]);
        assertEq(
            abi.encode(d.SALE_FLOOR_BPS(), d.SWAP_FLOOR_BPS(), d.BAND_BPS(), d.KEEP_BACK(), d.DUST()), abi.encode(n)
        );
    }

    function _refused(address o, address r, uint256[5] memory n) internal {
        vm.expectRevert(GooseGuard.OutOfBounds.selector);
        new GooseGuard(o, r, bytes32(0), n[0], n[1], n[2], n[3], n[4]);
    }

    /// GooseGuard compiles via_ir, which can reuse a stale `block.timestamp` after a warp.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }
}

/// A Move with its kind widened, to send a kind no uint8 holds.
struct WideMove {
    address account;
    uint256 kind;
    uint256[] args;
}

/// Stands in for JAW's manager at its real address. It keeps the hash of the last call's calldata (one write, so it
/// fits inside a move's gas cap), and the calldata itself after `recordAll`; or it reverts with the reason it was
/// given; or it first calls back into its caller (the Guard) and passes on that call's revert.
contract ManagerDouble {
    bytes32 public lastHash;
    bytes public last;
    bool internal all;
    bool internal failing;
    bytes internal reason;
    bytes internal callback;

    function failWith(bytes calldata r) external {
        failing = true;
        reason = r;
    }

    function callBack(bytes calldata data) external {
        callback = data;
    }

    function recordAll() external {
        all = true;
    }

    bool public unapproved;
    bool public revoked;

    function setApproval(bool approved, bool isRevoked_) external {
        unapproved = !approved;
        revoked = isRevoked_;
    }

    fallback() external {
        // The Guard's registration asks isApproved(p) and isRevoked(p): approved and not revoked unless a test says so.
        if (msg.sig == PM.isApproved.selector || msg.sig == PM.isRevoked.selector) {
            bool answer = msg.sig == PM.isApproved.selector ? !unapproved : revoked;
            assembly ("memory-safe") {
                mstore(0, answer)
                return(0, 32)
            }
        }
        if (failing) {
            bytes memory r = reason;
            assembly ("memory-safe") {
                revert(add(r, 0x20), mload(r))
            }
        }
        if (callback.length != 0) {
            (bool ok, bytes memory r) = msg.sender.call(callback);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(r, 0x20), mload(r))
                }
            }
        }
        lastHash = keccak256(msg.data);
        if (all) last = msg.data;
    }
}

/// Stands in for Aave's Spoke: every call reverts with `SIZE` bytes that start with `Boom()`.
contract RevertBomb {
    error Boom();

    uint256 internal immutable SIZE;

    constructor(uint256 size) {
        SIZE = size;
    }

    fallback() external {
        uint256 size = SIZE;
        bytes4 boom = Boom.selector;
        assembly {
            mstore(0, boom)
            revert(0, size)
        }
    }
}

/// Stands in for Aave's Spoke: every call burns all the gas it is given.
contract GasSink {
    fallback() external {
        assembly {
            invalid()
        }
    }
}
