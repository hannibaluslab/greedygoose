// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {DeployExecutor} from "../script/DeployExecutor.s.sol";
import {ForkBase} from "./ForkBase.sol";
import {IERC20} from "../src/IProtocols.sol";
import {IJustaPermissionManager as PM, IJustanAccount, IAaveV3Pool} from "./IJustaPermissionManager.sol";

/// The parts of JustanAccount this suite uses on top of IJustanAccount. The account itself may call its owner setter
/// (MultiOwnable), so it can ride in its own batch. A failing call in executeBatch reverts the whole batch with
/// ExecuteError(the call's index, its revert data), measured here.
interface IJawAccount {
    error ExecuteError(uint256 index, bytes error);

    function addOwnerAddress(address owner) external;
}

/// One Face ID for an agent's grant (Adrian, 2026-10-20, drops D14): the app's own wallet_sendCalls batch, the way
/// Leo's Guardian granted (GreedyGoose hooks/useGuardian.ts), instead of JAW's permission screen followed by the
/// registration batch. For Start earning the batch is
///
///   [USDC.approve(pool, x), pool.supply(USDC, x, account, 0),   Start earning only
///    account.addOwnerAddress(manager),                           only when the manager isn't an owner yet
///    manager.approve(save),                                      what JAW's grant sends, last in its user operation
///    executor.registerApproved(abi.encode(save))]                what the runner would send from the event
///
/// run through account.executeBatch called by the EntryPoint, as every JAW user operation runs, so the calls are
/// atomic with msg.sender = the account. The executor is the production GooseExecutor from this branch, deployed with
/// DeployExecutor's Base config (D13: CAP_MAX $5). JAW's relay entry (storePermissionInRelay) is off-chain, after the
/// receipt; this suite checks the batch logs exactly the one PermissionApproved the SDK reads its hash from. Nothing is
/// signed or sent. Needs BASE_RPC_URL.
abstract contract OneTapGrantForkBase is ForkBase {
    GooseExecutor x;
    address owner = makeAddr("owner");
    address forwarder = makeAddr("forwarder");
    /// Save's starting limit, $1,000 a day, held to CAP_MAX (lib/agents/permissions.ts startCapRaw).
    uint160 cap;
    uint256 salts;

    /// config/risk.ts CASH.feeBufferUsd ($0.50 since 2026-10-20, the fuel tank): Start earning leaves this in the
    /// wallet for JAW's USDC fee after the batch.
    uint256 constant FEE_BUFFER = 0.5e6;
    /// The dev preview account's idle cash in tests/onchain/start-earning.test.ts.
    uint256 constant WALLET = 42.25e6;

    function _setUpExecutor() internal {
        _fork();
        x = new GooseExecutor(new DeployExecutor().config(8453, owner));
        address[] memory f = new address[](1);
        f[0] = forwarder;
        vm.prank(owner);
        x.bootstrap(f);
        cap = x.CAP_MAX() < 1_000e6 ? x.CAP_MAX() : 1_000e6;
    }

    /// Save's template as the app builds it (lib/agents/permissions.ts, checker 0 as JAW grants it): approve USDC and
    /// supply to Aave V3 savings, USDC at `cap` a day, a year from `start`, a random salt.
    function _saveGrant(address account, uint48 start) internal returns (PM.Permission memory p) {
        p.account = account;
        p.spender = address(x);
        p.start = start;
        p.end = start + 365 days;
        p.salt = uint256(keccak256(abi.encode("one tap", ++salts)));
        p.calls = new PM.CallPermission[](2);
        p.calls[0] = PM.CallPermission(address(USDC), IERC20.approve.selector, address(0));
        p.calls[1] = PM.CallPermission(address(POOL), IAaveV3Pool.supply.selector, address(0));
        p.spends = new PM.SpendLimit[](1);
        p.spends[0] = PM.SpendLimit(address(USDC), cap, PM.PeriodUnit.Day, 1);
        (bool ok, GooseExecutor.Job job, uint160 c,) = x.registrationOf(abi.encode(p));
        assertTrue(ok, "the executor reads it as a grant");
        assertEq(uint8(job), uint8(GooseExecutor.Job.Save));
        assertEq(c, cap);
    }

    /// The one batch: [approve + supply when `supplyRaw` > 0, addOwnerAddress(manager) when `addOwner`,
    /// manager.approve, executor.registerApproved]; `registerFirst` swaps the last two.
    function _oneTap(address account, PM.Permission memory p, uint256 supplyRaw, bool addOwner, bool registerFirst)
        internal
        view
        returns (PM.Call[] memory calls)
    {
        calls = new PM.Call[]((supplyRaw > 0 ? 2 : 0) + (addOwner ? 1 : 0) + 2);
        uint256 n;
        if (supplyRaw > 0) {
            calls[n++] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(POOL), supplyRaw)));
            calls[n++] =
                PM.Call(address(POOL), 0, abi.encodeCall(IAaveV3Pool.supply, (address(USDC), supplyRaw, account, 0)));
        }
        if (addOwner) {
            calls[n++] = PM.Call(account, 0, abi.encodeCall(IJawAccount.addOwnerAddress, (address(MANAGER))));
        }
        PM.Call memory approve = PM.Call(address(MANAGER), 0, abi.encodeCall(PM.approve, (p)));
        PM.Call memory register =
            PM.Call(address(x), 0, abi.encodeCall(GooseExecutor.registerApproved, (abi.encode(p))));
        calls[n++] = registerFirst ? register : approve;
        calls[n] = registerFirst ? approve : register;
    }

    /// What executeBatch reverts with when call `index` reverts with the custom error `selector`.
    function _failedAt(uint256 index, bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IJawAccount.ExecuteError.selector, index, abi.encodeWithSelector(selector));
    }

    /// The batch the way a JAW user operation lands: the EntryPoint calls account.executeBatch.
    function _execute(address account, PM.Call[] memory calls) internal {
        vm.prank(ENTRY_POINT);
        IJustanAccount(account).executeBatch(calls);
    }

    function _assertSaveOn(address a, PM.Permission memory p) internal view {
        assertTrue(MANAGER.isApproved(p), "approved in JAW's manager");
        assertFalse(MANAGER.isRevoked(p));
        (uint8 jobs, GooseExecutor.Grant memory save,,,) = x.jobsOf(a);
        assertEq(jobs, 1, "Save on, nothing else");
        assertEq(save.cap, cap);
        assertEq(save.start, p.start);
        assertEq(save.end, p.end);
        assertEq(abi.encode(x.permissionOf(a, GooseExecutor.Job.Save)), abi.encode(p), "the registry holds the grant");
    }

    /// A JAW account the manager doesn't own: only the user's signer.
    function _newSoloJawAccount(string memory name) internal returns (address) {
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(makeAddr(name));
        return JAW_FACTORY.createAccount(owners, 0);
    }
}

contract OneTapGrantForkTest is OneTapGrantForkBase {
    function setUp() public {
        _setUpExecutor();
    }

    // ================================================================== the one batch

    /// A JAW passkey account (the factory makes the manager an owner): four calls, one user operation.
    function test_start_earning_grants_and_registers_save_in_one_batch() public {
        address a = _newJawAccount("alice");
        deal(address(USDC), a, WALLET);
        uint256 supplied = WALLET - FEE_BUFFER;
        PM.Permission memory p = _saveGrant(a, uint48(vm.getBlockTimestamp()));
        PM.Call[] memory calls = _oneTap(a, p, supplied, false, false);
        assertEq(calls.length, 4, "approve, supply, manager.approve, registerApproved");

        vm.recordLogs();
        _execute(a, calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        console.log("Save's daily limit in the grant, raw USDC:", cap);

        _assertSaveOn(a, p);
        assertEq(x.memberCount(), 1);
        assertApproxEqAbs(AUSDC.balanceOf(a), supplied, 2, "savings rose by the supply");
        assertEq(USDC.balanceOf(a), FEE_BUFFER, "the wallet keeps the fee buffer");
        assertEq(USDC.allowance(a, address(POOL)), 0, "the exact approve is used up");
        _assertOneApprovedLog(logs, p);

        _assertSaveSweepsATopUp(a, p);
    }

    /// An account the manager doesn't own yet (an EIP-7702 account, or one made outside JAW's SDK): the batch adds it
    /// first, as JAW's SDK and Leo's Guardian do. Five calls, still one user operation.
    function test_an_account_the_manager_does_not_own_adds_it_in_the_same_batch() public {
        address a = _newSoloJawAccount("solo");
        assertFalse(IJustanAccount(a).isOwnerAddress(address(MANAGER)));
        deal(address(USDC), a, WALLET);
        uint256 supplied = WALLET - FEE_BUFFER;
        PM.Permission memory p = _saveGrant(a, uint48(vm.getBlockTimestamp()));
        PM.Call[] memory calls = _oneTap(a, p, supplied, true, false);
        assertEq(calls.length, 5, "approve, supply, addOwnerAddress, manager.approve, registerApproved");

        vm.recordLogs();
        _execute(a, calls);

        assertTrue(IJustanAccount(a).isOwnerAddress(address(MANAGER)), "the manager is an owner");
        _assertSaveOn(a, p);
        assertApproxEqAbs(AUSDC.balanceOf(a), supplied, 2, "savings rose by the supply");
        _assertOneApprovedLog(vm.getRecordedLogs(), p);
        _assertSaveSweepsATopUp(a, p);
    }

    /// Any other agent's grant has no supply in front: two calls.
    function test_a_grant_alone_is_two_calls() public {
        address a = _newJawAccount("alice");
        PM.Permission memory p = _saveGrant(a, uint48(vm.getBlockTimestamp()));
        PM.Call[] memory calls = _oneTap(a, p, 0, false, false);
        assertEq(calls.length, 2);
        _execute(a, calls);
        _assertSaveOn(a, p);
    }

    // ================================================================== the order is pinned

    /// The executor reads the manager's approval, so registerApproved must come after manager.approve. The other way
    /// round the registration reverts and takes the whole batch with it: no savings, no grant, no registration.
    function test_registering_before_the_approve_reverts_the_whole_batch() public {
        address a = _newJawAccount("alice");
        deal(address(USDC), a, WALLET);
        PM.Permission memory p = _saveGrant(a, uint48(vm.getBlockTimestamp()));
        PM.Call[] memory calls = _oneTap(a, p, WALLET - FEE_BUFFER, false, true);

        vm.expectRevert(_failedAt(2, GooseExecutor.NotApproved.selector)); // the registration, third
        _execute(a, calls);
        _assertNothingHappened(a, p);
    }

    /// Without addOwnerAddress(manager) on an account the manager doesn't own, the registration refuses
    /// (ManagerNotOwner) and the whole batch rolls back: the app must add it whenever isOwnerAddress(manager) is false.
    function test_without_the_owner_call_an_unowned_account_reverts_the_whole_batch() public {
        address a = _newSoloJawAccount("solo");
        deal(address(USDC), a, WALLET);
        PM.Permission memory p = _saveGrant(a, uint48(vm.getBlockTimestamp()));
        PM.Call[] memory calls = _oneTap(a, p, WALLET - FEE_BUFFER, false, false);

        vm.expectRevert(_failedAt(3, GooseExecutor.ManagerNotOwner.selector)); // the registration, fourth
        _execute(a, calls);
        _assertNothingHappened(a, p);
        assertFalse(IJustanAccount(a).isOwnerAddress(address(MANAGER)));
    }

    // ================================================================== timing

    /// No earlier block needed: the approval is in the manager's storage as soon as its call returns, so the
    /// registration in the same transaction sees it (the tests above). The start is the browser's clock, as in JAW's
    /// grant: a start a little ahead of the chain still registers in the same batch, and Save waits for it.
    function test_a_start_ahead_of_the_chain_registers_and_save_waits_for_it() public {
        address a = _newJawAccount("alice");
        PM.Permission memory p = _saveGrant(a, uint48(vm.getBlockTimestamp() + 90));
        _execute(a, _oneTap(a, p, 0, false, false));
        _assertSaveOn(a, p);

        deal(address(USDC), a, 4e6);
        assertFalse(_includes(_check(), a), "not before its start");
        vm.warp(p.start);
        vm.roll(vm.getBlockNumber() + 45);
        assertTrue(_includes(_check(), a), "from its start");
        _run(_check());
        assertEq(USDC.balanceOf(a), 1e6, "saved down to the keep-back");
    }

    // ================================================================== helpers

    /// JAW's SDK takes the permission hash from the first PermissionApproved the manager logs in the receipt, then
    /// stores the permission in its relay under it. The batch logs exactly one, for this permission, and its data is
    /// the registration's argument.
    function _assertOneApprovedLog(Vm.Log[] memory logs, PM.Permission memory p) internal view {
        uint256 found;
        bytes32 hash = MANAGER.getHash(p);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(MANAGER) || logs[i].topics[0] != PM.PermissionApproved.selector) continue;
            ++found;
            assertEq(logs[i].topics[1], hash, "the hash the SDK stores in the relay");
            assertEq(logs[i].data, abi.encode(p), "the registration's bytes");
        }
        assertEq(found, 1, "one PermissionApproved");
    }

    /// After the batch: Save has nothing to do on the fee buffer; a new top-up arrives and the next run sweeps it into
    /// savings above the $1 keep-back, metered against the grant's daily limit.
    function _assertSaveSweepsATopUp(address a, PM.Permission memory p) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 2);
        assertFalse(_includes(_check(), a), "nothing to save on the fee buffer");

        uint256 cash = USDC.balanceOf(a) + 4e6; // $4 arrives
        deal(address(USDC), a, cash);
        uint256 expected = cash - 1e6;
        if (expected > cap) expected = cap;
        uint256 savingsBefore = AUSDC.balanceOf(a);
        address[] memory work = _check();
        assertTrue(_includes(work, a), "the round picks the top-up up");
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.Saved(a, expected);
        _run(work);

        assertApproxEqAbs(AUSDC.balanceOf(a), savingsBefore + expected, 2, "the top-up is in savings");
        assertEq(USDC.balanceOf(a), cash - expected, "the keep-back stays");
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[0]).spend, expected, "metered against the grant");
        assertEq(USDC.balanceOf(address(x)), 0, "the executor holds nothing");
    }

    function _assertNothingHappened(address a, PM.Permission memory p) internal view {
        assertFalse(MANAGER.isApproved(p), "not approved");
        (uint8 jobs,,,,) = x.jobsOf(a);
        assertEq(jobs, 0, "not registered");
        assertEq(x.memberCount(), 0);
        assertEq(AUSDC.balanceOf(a), 0, "nothing in savings");
        assertEq(USDC.balanceOf(a), WALLET, "the wallet untouched");
    }

    function _check() internal view returns (address[] memory) {
        (bool needed, bytes memory performData) = x.checkUpkeep(abi.encode(uint256(0), uint256(1)));
        if (!needed) return new address[](0);
        return abi.decode(performData, (address[]));
    }

    function _run(address[] memory accounts) internal {
        vm.prank(forwarder);
        x.performUpkeep(abi.encode(accounts));
    }

    function _includes(address[] memory list, address a) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == a) return true;
        }
        return false;
    }
}

/// Gas, cold: setUp builds every account and batch in its own transaction, so each test's one batch starts with cold
/// accounts and slots, as a user operation's execution does (ExecutorPageForkTest's way). Today's flow is three user
/// operations; each is measured on an account setUp brought to the step before it. With forge's `isolate` (on by
/// default in forge 1.8) each number also carries a transaction's 21,000 base and its calldata; FOUNDRY_ISOLATE=false
/// gives the execution alone. None includes a user operation's own costs (the passkey check, the EntryPoint, the
/// paymaster, its share of the bundle), which every user operation pays once: the one tap once, today's flow three
/// times.
contract OneTapGrantGasForkTest is OneTapGrantForkBase {
    struct Case {
        address account;
        bytes batch;
        bytes grant; // abi.encode(permission), as the registration carries it
    }

    Case oneTap; // Start earning + Save grant + registration: 4 calls
    Case withOwner; // the same on an account the manager doesn't own: 5 calls
    Case grantOnly; // grant + registration: 2 calls
    Case todayStart; // today, operation 1: Start earning's batch
    Case todayGrant; // today, operation 2: JAW's grant, after Start earning
    Case todayRegister; // today, operation 3: the registration, after both

    function setUp() public {
        _setUpExecutor();
        _prepare(oneTap, _newJawAccount("one tap"), WALLET - FEE_BUFFER, false);
        _prepare(withOwner, _newSoloJawAccount("with owner"), WALLET - FEE_BUFFER, true);
        _prepare(grantOnly, _newJawAccount("grant only"), 0, false);

        PM.Call[] memory all = _prepare(todayStart, _newJawAccount("today 1"), WALLET - FEE_BUFFER, false);
        todayStart.batch = _encode(_slice(all, 0, 2));
        all = _prepare(todayGrant, _newJawAccount("today 2"), WALLET - FEE_BUFFER, false);
        _execute(todayGrant.account, _slice(all, 0, 2));
        todayGrant.batch = _encode(_slice(all, 2, 1));
        all = _prepare(todayRegister, _newJawAccount("today 3"), WALLET - FEE_BUFFER, false);
        _execute(todayRegister.account, _slice(all, 0, 3));
        todayRegister.batch = _encode(_slice(all, 3, 1));
    }

    /// The measurement is cold with or without forge's `isolate` (on by default in forge 1.8): a balance setUp wrote
    /// still costs a cold USDC proxy, implementation and slot here (2,600 + 2,600 + 2,100), not about 300 warm.
    function test_setUp_leaves_the_batch_cold() public view {
        address account = oneTap.account;
        uint256 before = gasleft();
        USDC.balanceOf(account);
        uint256 gas = before - gasleft();
        console.log("USDC balance read after setUp, gas:", gas);
        assertGt(gas, 7_300);
    }

    function test_gas_one_tap_start_earning() public {
        console.log("one tap: supply + grant + registration (4 calls), cold gas:", _measure(oneTap));
        _assertSaveOn(oneTap.account, _grantOf(oneTap));
    }

    function test_gas_one_tap_adding_the_manager() public {
        console.log(
            "one tap: supply + addOwnerAddress + grant + registration (5 calls), cold gas:", _measure(withOwner)
        );
        _assertSaveOn(withOwner.account, _grantOf(withOwner));
    }

    function test_gas_one_tap_grant_alone() public {
        console.log("one tap: grant + registration (2 calls), cold gas:", _measure(grantOnly));
        _assertSaveOn(grantOnly.account, _grantOf(grantOnly));
    }

    function test_gas_today_1_start_earning() public {
        console.log("today, op 1: Start earning (2 calls), cold gas:", _measure(todayStart));
        assertApproxEqAbs(AUSDC.balanceOf(todayStart.account), WALLET - FEE_BUFFER, 2);
    }

    function test_gas_today_2_jaw_grant() public {
        console.log("today, op 2: JAW's grant (1 call), cold gas:", _measure(todayGrant));
        assertTrue(MANAGER.isApproved(_grantOf(todayGrant)));
    }

    function test_gas_today_3_registration() public {
        console.log("today, op 3: registration (1 call), cold gas:", _measure(todayRegister));
        _assertSaveOn(todayRegister.account, _grantOf(todayRegister));
    }

    /// One case: a JAW account with the wallet's idle USDC, its Save grant, and the one-tap batch (stored encoded).
    function _prepare(Case storage c, address account, uint256 supplyRaw, bool addOwner)
        internal
        returns (PM.Call[] memory calls)
    {
        if (supplyRaw > 0) deal(address(USDC), account, WALLET);
        PM.Permission memory p = _saveGrant(account, uint48(vm.getBlockTimestamp()));
        calls = _oneTap(account, p, supplyRaw, addOwner, false);
        c.account = account;
        c.grant = abi.encode(p);
        c.batch = _encode(calls);
    }

    /// The batch's execution gas: the EntryPoint's call to account.executeBatch, which must succeed.
    function _measure(Case storage c) internal returns (uint256 gas) {
        bytes memory batch = c.batch;
        address account = c.account;
        vm.prank(ENTRY_POINT);
        uint256 before = gasleft();
        (bool ok,) = account.call(batch);
        gas = before - gasleft();
        assertTrue(ok, "the batch runs");
    }

    function _grantOf(Case storage c) internal view returns (PM.Permission memory) {
        return abi.decode(c.grant, (PM.Permission));
    }

    function _encode(PM.Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeCall(IJustanAccount.executeBatch, (calls));
    }

    function _slice(PM.Call[] memory calls, uint256 from, uint256 n) internal pure returns (PM.Call[] memory out) {
        out = new PM.Call[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = calls[from + i];
        }
    }
}
