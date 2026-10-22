// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GuardPasskeyForkBase} from "./GuardPasskeyForkBase.sol";
import {IJustaPermissionManager as PM} from "./IJustaPermissionManager.sol";
import {PackedUserOperation} from "./OneTapNewAccountFork.t.sol";

/// Not a JAW account: it says the manager owns it, and when the manager asks it to run a batch it calls back into the
/// Guard with `payload` instead, reverting with whatever the Guard reverted with (or ReentryWorked if it didn't).
contract ReentrantAccount {
    error ReentryWorked();

    address internal immutable GUARD;
    bytes public payload;

    constructor(address guard) {
        GUARD = guard;
    }

    function setPayload(bytes calldata p) external {
        payload = p;
    }

    function isOwnerAddress(address) external pure returns (bool) {
        return true;
    }

    function executeBatch(PM.Call[] calldata) external {
        (bool ok, bytes memory ret) = GUARD.call(payload);
        if (ok) revert ReentryWorked();
        assembly ("memory-safe") {
            revert(add(ret, 0x20), mload(ret))
        }
    }
}

/// Build step 8 (spec-final-v2.md §14, item 13): reentrancy and decision 2 (the user's own runner).
///
/// - The account runs its own move through the real EntryPoint v0.8, signed by a real P-256 passkey in WebAuthn form
///   (the OneTapNewAccountFork harness): EntryPoint → account.executeBatch → Guard.performUpkeep → manager.executeBatch
///   → account.executeBatch again, nested.
/// - A runner the account chose with setRunner sends its moves directly, and only its moves.
/// - A JAW session key whose permission lists Guard.performUpkeep drives the account into the Guard through the
///   manager: the Guard's own call back into the manager is refused cleanly.
/// - A contract account calling back into the Guard from inside its batch: every entry point is locked.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardReentrancyForkTest -vv
contract GooseGuardReentrancyForkTest is GuardPasskeyForkBase {
    /// JAW's permission manager's own lock (Solady's ReentrancyGuard error).
    bytes4 constant MANAGER_REENTRANCY = bytes4(keccak256("Reentrancy()"));

    function setUp() public {
        _setUpGuard();
    }

    /// An NVDAc-backed account at 1.02, the credit's cash in savings with $50 left in the wallet.
    function _position(address a) internal {
        _backUsd(a, NVDA, 4_000e6);
        _drawTo(a, 1.02e18);
        _save(a, _bal(address(USDC), a) - 50e6);
    }

    // ================================================================== the account runs its own move

    /// The user's passkey account sends its own repay to the Guard in a user operation. The nested executeBatch (the
    /// manager calling back into the account while the EntryPoint's call is still open) is allowed by JustanAccount:
    /// the repay runs, inside a successful user operation.
    function test_the_account_runs_its_own_move_through_the_entry_point() public {
        address a = FACTORY.createAccount(_passkeyOwners(), 0);
        assertEq(a.codehash, _newJawAccount("clone").codehash, "not JAW's clone");
        _position(a);
        _protectOn(a);

        uint256 repay = _repayTo(a, 1.10e18);
        PM.Call[] memory calls = new PM.Call[](1);
        calls[0] = PM.Call(address(g), 0, abi.encodeCall(GooseGuard.performUpkeep, (_one(a, REPAY, _a2(0, repay)))));
        PackedUserOperation memory op = _userOp(a, "", calls);
        bytes32 hash = EP.getUserOpHash(op);
        uint256 debt = _debt(a);

        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bool found, bool success) = _outcome(logs, hash);
        bytes4 refused = _reason(logs, a);
        console2.log("user operation found, success", found, success);
        console2.log("the Guard's refusal (0 = ran):");
        console2.logBytes4(refused);
        assertTrue(found && success, "the user operation failed");
        assertEq(refused, bytes4(0), "the self-run move was refused");
        assertTrue(_logged(logs, GooseGuard.ProtectRepaid.selector, a), "no ProtectRepaid");
        assertApproxEqAbs(debt - _debt(a), repay, 2, "not repaid");
    }

    /// The same user operation signed by another passkey is refused in validation: nothing runs.
    function test_another_passkey_cant_send_the_accounts_move() public {
        address a = FACTORY.createAccount(_passkeyOwners(), 0);
        _position(a);
        _protectOn(a);
        PM.Call[] memory calls = new PM.Call[](1);
        calls[0] = PM.Call(
            address(g), 0, abi.encodeCall(GooseGuard.performUpkeep, (_one(a, REPAY, _a2(0, _repayTo(a, 1.10e18)))))
        );
        PackedUserOperation memory op = _userOp(a, "", calls);
        passkey = uint256(keccak256("someone else's passkey")) % P256_N;
        op.signature = _passkeySignature(EP.getUserOpHash(op));
        uint256 debt = _debt(a);
        vm.expectRevert(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA24 signature error"));
        _handle(op);
        assertEq(_debt(a), debt);
    }

    // ================================================================== a runner the account chose

    /// The account names a helper with setRunner: the helper sends the account's repay directly and it runs; the same
    /// helper's move for another account is skipped (no event); once the account clears it, the helper is skipped too.
    function test_a_chosen_runner_sends_only_its_accounts_moves() public {
        address a = _newJawAccount("chooser");
        _position(a);
        _protectOn(a);
        address other = _newJawAccount("other");
        _position(other);
        _protectOn(other);
        address helper = makeAddr("my own agent");
        vm.prank(a);
        g.setRunner(helper);

        GooseGuard.Move[] memory moves = new GooseGuard.Move[](2);
        moves[0] = _move(other, REPAY, _a2(0, _repayTo(other, 1.10e18)));
        moves[1] = _move(a, REPAY, _a2(0, _repayTo(a, 1.10e18)));
        Holdings memory h = _holdings(other);
        uint256 debt = _debt(a);
        (, Vm.Log[] memory logs) = _performAs(helper, abi.encode(moves));
        assertEq(_reasons(logs).length, 0, "a refusal was written");
        assertLt(_debt(a), debt, "the helper's own account's move didn't run");
        _assertUnchanged(other, h);

        vm.prank(a);
        g.setRunner(address(0));
        _drawMoreTo(a, 1.02e18);
        debt = _debt(a);
        (, logs) = _performAs(helper, _one(a, REPAY, _a2(0, 10e6)));
        assertEq(_reasons(logs).length, 0, "a refusal was written");
        assertEq(_debt(a), debt, "a cleared runner still ran");
        // The account itself may always send its own (and anyone may send END).
        (, logs) = _performAs(a, _one(a, REPAY, _a2(10e6, 0)));
        assertEq(_reason(logs, a), bytes4(0), "the account's own move was refused");
    }

    // ================================================================== a JAW session key

    /// A session key holds the account's permission to call Guard.performUpkeep, and sends it through JAW's manager.
    /// The account then calls the Guard (so the Guard sees the account itself), and the Guard's own call back into
    /// the manager is refused by the manager's lock. The Guard records it as a refusal; the session key's batch
    /// doesn't revert, and nothing moves.
    function test_a_jaw_session_key_through_the_manager_is_refused_cleanly() public {
        address a = _newJawAccount("session");
        _position(a);
        _protectOn(a);
        address sessionKey = makeAddr("session key");
        PM.CallPermission[] memory perms = new PM.CallPermission[](1);
        perms[0] = _cp(address(g), GooseGuard.performUpkeep.selector);
        address[] memory tokens = new address[](1);
        tokens[0] = address(USDC);
        PM.Permission memory p = _permission(a, perms, tokens);
        p.spender = sessionKey;
        _grantThroughAccount(p);

        PM.Call[] memory calls = new PM.Call[](1);
        calls[0] = PM.Call(
            address(g), 0, abi.encodeCall(GooseGuard.performUpkeep, (_one(a, REPAY, _a2(0, _repayTo(a, 1.10e18)))))
        );
        Holdings memory h = _holdings(a);
        vm.recordLogs();
        vm.prank(sessionKey);
        (bool ok, bytes memory ret) = address(MANAGER).call(abi.encodeCall(PM.executeBatch, (p, calls)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes4 reason = _reason(logs, a);
        console2.log("session key's batch ok", ok);
        if (!ok) console2.logBytes(ret);
        console2.log("the Guard's refusal:");
        console2.logBytes4(reason);
        assertTrue(ok, "the session key's batch reverted");
        assertEq(reason, MANAGER_REENTRANCY, "not refused by the manager's lock");
        _assertUnchanged(a, h);
    }

    // ================================================================== re-entering the Guard

    /// A contract account calls back into the Guard from inside the manager's batch: performUpkeep, register,
    /// unregister, every setter, endRescue and applyChange are locked (Reentered); `run` only answers the Guard
    /// itself (OnlySelf). Each attempt only refuses the attacker's own move.
    function test_a_contract_cant_re_enter_the_guard() public {
        ReentrantAccount evil = new ReentrantAccount(address(g));
        address e = address(evil);
        g.queueChange(2, e.codehash);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        g.applyChange(2, e.codehash);
        _position(e);
        PM.Permission memory p = _protectP(e);
        vm.startPrank(e);
        MANAGER.approve(p);
        g.register(JOB_PROTECT, abi.encode(p));
        vm.stopPrank();

        bytes[9] memory payloads = [
            abi.encodeCall(GooseGuard.performUpkeep, (_one(e, REPAY, _a2(0, 1e6)))),
            abi.encodeCall(GooseGuard.register, (JOB_SAVE, abi.encode(p))),
            abi.encodeCall(GooseGuard.unregister, (JOB_PROTECT)),
            abi.encodeCall(GooseGuard.setMix, (uint112(10_000))),
            abi.encodeCall(GooseGuard.setRunner, (makeAddr("evil runner"))),
            abi.encodeCall(GooseGuard.setProtect, (10_300, 11_200)),
            abi.encodeCall(GooseGuard.endRescue, ()),
            abi.encodeCall(GooseGuard.applyChange, (0, bytes32(uint256(uint160(e))))),
            abi.encodeCall(GooseGuard.run, (_move(e, REPAY, _a2(0, 1e6))))
        ];
        for (uint256 i; i < 9; ++i) {
            evil.setPayload(payloads[i]);
            Holdings memory h = _holdings(e);
            (, Vm.Log[] memory logs) = _perform(_one(e, REPAY, _a2(0, _repayTo(e, 1.10e18))));
            bytes4 want = i == 8 ? GooseGuard.OnlySelf.selector : GooseGuard.Reentered.selector;
            assertEq(_reason(logs, e), want, "a re-entry wasn't locked out");
            _assertUnchanged(e, h);
        }
        (GooseGuard.Account memory acc,) = g.accountOf(e);
        assertEq(acc.runner, address(0), "the runner changed");
        assertEq(acc.jobs, 1 << JOB_PROTECT, "registrations changed");
    }
}
