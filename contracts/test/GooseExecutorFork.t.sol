// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IAeroFactory, IAeroPool, IAeroRouter} from "../src/IProtocols.sol";
import {ProtectCase, Thresholds} from "../src/CashRules.sol";
import {DeployExecutor} from "../script/DeployExecutor.s.sol";
import {ExecutorHarness} from "./ExecutorHarness.sol";
import {FakeAccount} from "./FakeAccount.sol";
import {ForkBase} from "./ForkBase.sol";
import {Vectors} from "./Vectors.sol";
import {IJustaPermissionManager as PM, ISpoke} from "./IJustaPermissionManager.sol";

/// Fixtures shared by the fork suites: an executor whose forwarder is pranked, and JAW accounts that grant and
/// register the way the app will.
abstract contract ExecutorForkBase is ForkBase {
    ExecutorHarness x;
    address owner = makeAddr("owner");
    address forwarder = makeAddr("forwarder");
    address attacker = makeAddr("attacker");
    uint256 salts;

    function _config() internal returns (GooseExecutor.Config memory c) {
        c = new DeployExecutor().config(8453, owner);
        c.capMax = 1_000e6; // larger than a D13 deploy's $5, to reach every branch
        bytes32[] memory h = new bytes32[](4);
        h[0] = c.codehashes[0];
        h[1] = c.codehashes[1];
        h[2] = address(new FakeAccount(false)).codehash; // test-only: accounts that misbehave
        h[3] = address(new FakeAccount(true)).codehash;
        c.codehashes = h;
    }

    function _deploy(GooseExecutor.Config memory c) internal returns (ExecutorHarness e) {
        e = new ExecutorHarness(c);
        address[] memory f = new address[](1);
        f[0] = forwarder;
        vm.prank(owner);
        e.bootstrap(f);
    }

    /// The permission JAW's screen grants for `job`: start = now, a random salt, a year.
    function _permission(address account, GooseExecutor.Job job, uint160 cap) internal returns (PM.Permission memory) {
        uint48 start = uint48(vm.getBlockTimestamp());
        return x.permissionFor(
            job, account, GooseExecutor.Grant(start, start + 365 days, cap), uint256(keccak256(abi.encode(++salts))), 0
        );
    }

    function _turnOn(address account, GooseExecutor.Job job, uint160 cap) internal returns (PM.Permission memory p) {
        p = _permission(account, job, cap);
        _grantThroughAccount(p);
        _register(job, p, cap);
    }

    function _register(GooseExecutor.Job job, PM.Permission memory p, uint160 cap) internal {
        x.register(job, p.account, p.start, p.end, p.salt, cap, 0);
    }

    /// $100 of savings and credit at health 1.02, under Protect's line, with Protect on.
    function _inAct(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        _withSavings(a, 100e6);
        _openCreditAt(a, 1e8, 1.02e18);
        _turnOn(a, GooseExecutor.Job.Protect, 1_000e6);
    }

    /// The same for a fake account, which approves its own permission (it isn't a JAW account).
    function _fakeInAct(address fake) internal {
        _withSavings(fake, 100e6);
        _openCreditAt(fake, 1e8, 1.02e18);
        PM.Permission memory p = _permission(fake, GooseExecutor.Job.Protect, 1_000e6);
        vm.prank(fake);
        MANAGER.approve(p);
        _register(GooseExecutor.Job.Protect, p, 1_000e6);
    }

    /// Protect · sell on for every stock, with a daily limit of a hundredth of a share each.
    function _turnOnSell(address account) internal {
        uint256 t;
        for (uint256 r; r < 7; ++r) {
            t |= uint256(100) << (32 * r);
        }
        uint48 start = uint48(vm.getBlockTimestamp());
        GooseExecutor.Grant memory g = GooseExecutor.Grant(start, start + 365 days, 5e6);
        uint256 salt = uint256(keccak256(abi.encode(++salts)));
        _grantThroughAccount(x.permissionFor(GooseExecutor.Job.ProtectSell, account, g, salt, t));
        x.register(GooseExecutor.Job.ProtectSell, account, g.start, g.end, salt, g.cap, t);
    }

    function _withSavings(address account, uint256 amount) internal {
        deal(address(USDC), account, amount);
        _save(account, amount);
    }

    /// A JAW account the manager doesn't own: only the user's signer.
    function _newSoloJawAccount(string memory name) internal returns (address) {
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(makeAddr(name));
        return JAW_FACTORY.createAccount(owners, 0);
    }

    function _check() internal view returns (address[] memory) {
        (bool needed, bytes memory performData) = x.checkUpkeep(abi.encode(uint256(0), uint256(1)));
        if (!needed) return new address[](0);
        return abi.decode(performData, (address[]));
    }

    /// What a runner lists on a price update: the Protect list's work.
    function _checkProtect() internal view returns (address[] memory) {
        (bool needed, bytes memory performData) = x.checkProtect(0, 1);
        if (!needed) return new address[](0);
        return abi.decode(performData, (address[]));
    }

    function _run(address[] memory accounts) internal {
        vm.prank(forwarder);
        x.performUpkeep(abi.encode(accounts));
    }

    function _rescueAt(address account) internal view returns (uint48 rescueAt) {
        (,,,,,, rescueAt,,,) = x.accounts(account);
    }

    function _includes(address[] memory list, address a) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == a) return true;
        }
        return false;
    }

    function _assertHoldsNothing() internal view {
        assertEq(USDC.balanceOf(address(x)), 0, "executor holds no USDC");
        assertEq(AUSDC.balanceOf(address(x)), 0, "executor holds no savings");
        assertEq(address(x).balance, 0, "executor holds no ETH");
    }

    /// 00:00 UTC on the next Friday after `ts`.
    function _nextFridayUtc(uint256 ts) internal pure returns (uint256) {
        uint256 d = ts / 1 days + 1;
        return (d + (8 - d % 7) % 7) * 1 days; // day 1 (1970-01-02) was a Friday
    }
}

/// GooseExecutor against the real JAW permission manager, Aave V3 savings and the Aave V4 Equities Hub on a Base fork,
/// with fresh JAW accounts granted the way JAW's screen grants (checker 0, start = now, a random salt). The runners
/// (CRE, KeeperHub) can't run on a fork, so the forwarder is pranked. Needs BASE_RPC_URL. The tests read the time through
/// vm.getBlockTimestamp(): compiled through the IR pipeline with GooseExecutor, a test may reuse an earlier
/// `block.timestamp` after a warp.
contract GooseExecutorForkTest is ExecutorForkBase {
    bytes32 constant NO_REVERT_DATA = bytes32(0);

    function setUp() public {
        _fork();
        x = _deploy(_config());
    }

    // ================================================================== registration (§4)

    /// A runner watching the manager's PermissionApproved hands its data to registerApproved, which anyone may call.
    function test_a_jaw_grant_registers_from_its_event_data() public {
        address alice = _newJawAccount("alice");
        PM.Permission memory p = _permission(alice, GooseExecutor.Job.Protect, 5e6);
        vm.recordLogs();
        _grantThroughAccount(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].emitter, address(MANAGER));
        assertEq(logs[0].topics[0], PM.PermissionApproved.selector);
        PM.Permission memory approved = abi.decode(logs[0].data, (PM.Permission));

        (bool ok, GooseExecutor.Job job, uint160 cap,) = x.registrationOf(approved);
        assertTrue(ok, "our grant");
        assertEq(uint8(job), uint8(GooseExecutor.Job.Protect));
        assertEq(cap, 5e6);
        vm.expectEmit(true, true, false, true, address(x));
        emit GooseExecutor.JobOn(alice, GooseExecutor.Job.Protect, MANAGER.getHash(p), 5e6, p.end);
        vm.prank(attacker); // anyone: it moves no money and checks everything
        x.registerApproved(approved);

        (uint8 jobs,, GooseExecutor.Grant memory protect,,) = x.jobsOf(alice);
        assertEq(jobs, 2);
        assertEq(protect.cap, 5e6);
        assertEq(x.memberCount(), 1);
        assertEq(x.protectMemberCount(), 1, "on the Protect list");
        assertEq(abi.encode(x.permissionOf(alice, GooseExecutor.Job.Protect)), abi.encode(p), "rebuilt exactly");
        vm.recordLogs();
        x.registerApproved(approved);
        assertEq(vm.getRecordedLogs().length, 0, "the same grant again changes nothing");

        // The same grant for another spender is someone else's.
        address bob = _newJawAccount("bob");
        PM.Permission memory other = _permission(bob, GooseExecutor.Job.Save, 5e6);
        other.spender = attacker;
        vm.recordLogs();
        _grantThroughAccount(other);
        (ok,,,) = x.registrationOf(abi.decode(vm.getRecordedLogs()[0].data, (PM.Permission)));
        assertFalse(ok, "another spender");
    }

    /// Only the accounts that ever had Protect or Protect · sell on are on the Protect list, once each; a price update
    /// scans only them.
    function test_the_protect_list_holds_only_protect_accounts() public {
        address alice = _inAct("alice");
        address bob = _newJawAccount("bob");
        _turnOn(bob, GooseExecutor.Job.Save, 5e6);
        deal(address(USDC), bob, 3e6);
        address carol = _newJawAccount("carol");
        _turnOnSell(carol);
        _turnOn(alice, GooseExecutor.Job.Save, 5e6);

        assertEq(x.memberCount(), 3);
        assertEq(x.protectMemberCount(), 2, "alice and carol");
        assertEq(x.protectMembers(0), alice);
        assertEq(x.protectMembers(1), carol);
        address[] memory onPrice = _checkProtect();
        assertEq(onPrice.length, 1);
        assertEq(onPrice[0], alice, "under the line");
        assertTrue(_includes(_check(), bob), "the round still sees every job");
        assertFalse(_includes(onPrice, bob), "Save alone isn't scanned on a price update");
    }

    function test_registration_checks_every_condition_with_its_own_error() public {
        address alice = _newJawAccount("alice");
        PM.Permission memory p = _permission(alice, GooseExecutor.Job.Save, 5e6);

        vm.expectRevert(GooseExecutor.NotApproved.selector);
        _register(GooseExecutor.Job.Save, p, 5e6);
        _grantThroughAccount(p);

        p.account = makeAddr("not a contract");
        vm.expectRevert(GooseExecutor.AccountNotAllowed.selector);
        _register(GooseExecutor.Job.Save, p, 5e6);

        p.account = _newSoloJawAccount("solo");
        vm.expectRevert(GooseExecutor.ManagerNotOwner.selector);
        _register(GooseExecutor.Job.Save, p, 5e6);

        p.account = alice;
        uint160 tooMuch = x.CAP_MAX() + 1;
        vm.expectRevert(GooseExecutor.CapOutOfBounds.selector);
        _register(GooseExecutor.Job.Save, p, 0);
        vm.expectRevert(GooseExecutor.CapOutOfBounds.selector);
        _register(GooseExecutor.Job.Save, p, tooMuch);
        vm.expectRevert(GooseExecutor.NotApproved.selector);
        _register(GooseExecutor.Job.Save, p, 4e6); // not the limit Alice signed
        vm.expectRevert(GooseExecutor.NotApproved.selector);
        _register(GooseExecutor.Job.Protect, p, 5e6); // not the job she signed

        uint48 start = p.start;
        p.start = p.end;
        vm.expectRevert(GooseExecutor.BadWindow.selector);
        _register(GooseExecutor.Job.Save, p, 5e6);
        p.start = start;

        _register(GooseExecutor.Job.Save, p, 5e6);
        vm.recordLogs();
        _register(GooseExecutor.Job.Save, p, 5e6);
        assertEq(vm.getRecordedLogs().length, 0, "the same grant again changes nothing");

        vm.warp(p.end + 1);
        vm.expectRevert(GooseExecutor.BadWindow.selector);
        _register(GooseExecutor.Job.Save, p, 5e6);
    }

    function test_an_older_grant_cannot_replace_a_newer_one() public {
        address alice = _newJawAccount("alice");
        PM.Permission memory older = _permission(alice, GooseExecutor.Job.Save, 5e6);
        _grantThroughAccount(older);
        vm.warp(vm.getBlockTimestamp() + 60);
        PM.Permission memory newer = _permission(alice, GooseExecutor.Job.Save, 2e6);
        _grantThroughAccount(newer);

        _register(GooseExecutor.Job.Save, newer, 2e6);
        vm.expectRevert(GooseExecutor.StaleGrant.selector);
        _register(GooseExecutor.Job.Save, older, 5e6);
        (, GooseExecutor.Grant memory save,,,) = x.jobsOf(alice);
        assertEq(save.cap, 2e6);
    }

    function test_after_a_revoke_the_job_goes_off_and_a_new_grant_brings_it_back() public {
        address alice = _newJawAccount("alice");
        PM.Permission memory p = _turnOn(alice, GooseExecutor.Job.Save, 5e6);

        vm.expectRevert(GooseExecutor.StillOn.selector);
        x.prune(alice, GooseExecutor.Job.Save);
        _revokeThroughAccount(p);
        vm.expectEmit(true, true, false, true, address(x));
        emit GooseExecutor.JobOff(alice, GooseExecutor.Job.Save, GooseExecutor.OffReason.Revoked);
        x.prune(alice, GooseExecutor.Job.Save);
        vm.expectRevert(GooseExecutor.NotApproved.selector);
        _register(GooseExecutor.Job.Save, p, 5e6);

        vm.warp(vm.getBlockTimestamp() + 1);
        _turnOn(alice, GooseExecutor.Job.Save, 3e6);
        (uint8 jobs, GooseExecutor.Grant memory save,,,) = x.jobsOf(alice);
        assertEq(jobs, 1);
        assertEq(save.cap, 3e6);
        assertEq(x.memberCount(), 1, "still one member");
    }

    function test_an_unapproved_registration_reverts_and_registration_works_while_paused() public {
        address alice = _newJawAccount("alice");
        PM.Permission memory p = _permission(alice, GooseExecutor.Job.Protect, 5e6);
        vm.expectRevert(GooseExecutor.NotApproved.selector);
        x.registerApproved(p); // Alice never approved it

        vm.prank(owner);
        x.pause();
        _grantThroughAccount(p);
        x.registerApproved(p);
        (uint8 jobs,,,,) = x.jobsOf(alice);
        assertEq(jobs, 2, "registered while paused");
    }

    /// GooseExecutor.md §3: the app's grant (lib/agents/permissions.ts, hashed in scripts/agent-vectors.ts) and the
    /// executor's template give the same manager hash on 50 random inputs per kind: the Cash Agent's jobs, Protect ·
    /// sell and the Rebalancer with their stock limits, and Entry.
    function test_templates_hash_like_the_apps_builder() public {
        vm.etch(Vectors.HASH_SPENDER, address(x).code);
        ExecutorHarness h = ExecutorHarness(Vectors.HASH_SPENDER);
        string memory json = vm.readFile("test/vectors/permissions.json");
        bytes32[] memory hashes = vm.parseJsonBytes32Array(json, ".hashes");
        assertEq(hashes.length, 50);
        for (uint256 i; i < hashes.length; ++i) {
            Vectors.Hash memory v = Vectors.hashInput(i);
            PM.Permission memory p = h.permissionFor(
                GooseExecutor.Job(v.job), v.account, GooseExecutor.Grant(v.start, v.end, v.cap), v.salt, 0
            );
            assertEq(MANAGER.getHash(p), hashes[i], string.concat("vector ", vm.toString(i)));
        }
        bytes32[] memory sellHashes = vm.parseJsonBytes32Array(json, ".sellHashes");
        assertEq(sellHashes.length, 50);
        for (uint256 i; i < sellHashes.length; ++i) {
            Vectors.SellHash memory v = Vectors.sellHashInput(i);
            uint256 t;
            for (uint256 r; r < 7; ++r) {
                t |= v.limits[r] / 1e4 << (32 * r);
            }
            PM.Permission memory p = h.permissionFor(
                GooseExecutor.Job.ProtectSell, v.account, GooseExecutor.Grant(v.start, v.end, v.cap), v.salt, t
            );
            assertEq(MANAGER.getHash(p), sellHashes[i], string.concat("sell vector ", vm.toString(i)));
        }
        bytes32[] memory rebalanceHashes = vm.parseJsonBytes32Array(json, ".rebalanceHashes");
        assertEq(rebalanceHashes.length, 50);
        for (uint256 i; i < rebalanceHashes.length; ++i) {
            Vectors.RebalanceHash memory v = Vectors.rebalanceHashInput(i);
            uint256 t;
            for (uint256 r; r < 7; ++r) {
                t |= v.limits[r] / 1e4 << (32 * r);
            }
            PM.Permission memory p = h.permissionFor(
                GooseExecutor.Job.Rebalance, v.account, GooseExecutor.Grant(v.start, v.end, v.cap), v.salt, t
            );
            assertEq(MANAGER.getHash(p), rebalanceHashes[i], string.concat("rebalance vector ", vm.toString(i)));
        }
        bytes32[] memory entryHashes = vm.parseJsonBytes32Array(json, ".entryHashes");
        assertEq(entryHashes.length, 50);
        for (uint256 i; i < entryHashes.length; ++i) {
            Vectors.Hash memory v = Vectors.entryHashInput(i);
            PM.Permission memory p = h.permissionFor(
                GooseExecutor.Job.Entry, v.account, GooseExecutor.Grant(v.start, v.end, v.cap), v.salt, 0
            );
            assertEq(MANAGER.getHash(p), entryHashes[i], string.concat("entry vector ", vm.toString(i)));
        }
    }

    // ================================================================== Save (§5.3)

    function test_cash_that_lands_is_saved_on_the_next_run_above_the_keep_back() public {
        address alice = _newJawAccount("alice");
        PM.Permission memory p = _turnOn(alice, GooseExecutor.Job.Save, 5e6);
        assertEq(_check().length, 0, "nothing to save yet");

        deal(address(USDC), alice, 4e6);
        address[] memory work = _check();
        assertEq(work.length, 1);
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.Saved(alice, 3e6);
        _run(work);

        assertEq(USDC.balanceOf(alice), 1e6, "the $1 keep-back stays in the wallet");
        assertApproxEqAbs(AUSDC.balanceOf(alice), 3e6, 2, "in savings");
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[0]).spend, 3e6, "metered against the daily limit");
        assertEq(USDC.allowance(alice, address(POOL)), 0, "approval reset by the manager");
        _assertHoldsNothing();
        assertEq(_check().length, 0, "nothing left above the keep-back");
    }

    function test_save_stays_within_the_daily_limit_and_number() public {
        address alice = _newJawAccount("alice");
        _turnOn(alice, GooseExecutor.Job.Save, 5e6);
        deal(address(USDC), alice, 20e6);
        _run(_check());
        assertEq(USDC.balanceOf(alice), 15e6, "$5 a day");
        assertEq(_check().length, 0, "limit used up");
        vm.warp(vm.getBlockTimestamp() + 1 days + 1); // the manager's 24 hours include their last second
        _run(_check());
        assertEq(USDC.balanceOf(alice), 10e6, "and $5 the next day");

        address bob = _newJawAccount("bob");
        _turnOn(bob, GooseExecutor.Job.Save, 1_000e6);
        for (uint256 i; i < 6; ++i) {
            deal(address(USDC), bob, 2e6);
            _run(_check());
            assertEq(USDC.balanceOf(bob), 1e6);
        }
        deal(address(USDC), bob, 2e6);
        assertEq(_check().length, 0, "six saves a New York day");
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertTrue(_includes(_check(), bob), "and six more the next");
    }

    // ================================================================== Protect from savings (§5.2)

    /// Protect's line (Adrian, 2026-10-19): credit under 1.03 is repaid from savings just enough to be back at 1.12,
    /// and then Protect leaves it there, with no rescue left under way.
    function test_credit_under_the_line_is_repaid_from_savings_back_to_1_12() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 100e6);
        _openCreditAt(alice, 1e8, 1.02e18);
        PM.Permission memory p = _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);
        uint256 debtBefore = SPOKE.getUserTotalDebt(USDC_RESERVE, alice);
        uint256 savingsBefore = AUSDC.balanceOf(alice);

        GooseExecutor.Plan memory plan = x.planOf(alice);
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Repay));
        assertEq(uint8(plan.reason), uint8(ProtectCase.Act));
        // From 1.02 to 1.12 is 1 - 1.02/1.12 = 5/56 of what's owed, about 8.9%. Read from the health the account landed
        // on (a hair over 1.02), since the gap to a close target makes a fixed fraction miss by more than the rounding.
        uint256 hfBefore = SPOKE.getUserAccountData(alice).healthFactor;
        assertApproxEqRel(plan.amount, debtBefore - debtBefore * hfBefore / 1.12e18, 0.002e18, "back to 1.12's share");
        address[] memory work = _check();
        assertEq(work[0], alice);
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.ProtectRepaid(alice, 0, 0, 0, ProtectCase.Act);
        _run(work);

        uint256 hf = SPOKE.getUserAccountData(alice).healthFactor;
        assertApproxEqRel(hf, 1.12e18, 0.001e18, "back to 1.12, the target");
        assertEq(_rescueAt(alice), 0, "the rescue is done");
        assertApproxEqAbs(debtBefore - SPOKE.getUserTotalDebt(USDC_RESERVE, alice), plan.amount, 2, "repaid");
        assertApproxEqAbs(savingsBefore - AUSDC.balanceOf(alice), plan.amount, 2, "from savings");
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[0]).spend, plan.amount, "USDC limit charged");
        assertApproxEqAbs(MANAGER.getCurrentPeriod(p, p.spends[1]).spend, plan.amount, 2, "savings limit charged");
        _assertHoldsNothing();
        assertEq(_check().length, 0, "at the target: nothing more to do");
    }

    /// A rescue savings can't finish goes on: savings that arrive later repay too, above the line, until 1.12.
    function test_a_rescue_goes_on_above_the_line_until_the_target() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 2e6); // too little to get back to 1.12
        _openCreditAt(alice, 1e8, 1.02e18);
        _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);
        _run(_check());
        uint256 hf = SPOKE.getUserAccountData(alice).healthFactor;
        assertGt(hf, 1.02e18, "savings repaid what they could");
        assertLt(hf, 1.12e18, "short of the target");
        assertEq(_rescueAt(alice), vm.getBlockTimestamp(), "the rescue goes on");
        assertEq(_check().length, 0, "no savings left: nothing to do yet");

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _withSavings(alice, 100e6);
        assertEq(uint8(x.planOf(alice).action), uint8(GooseExecutor.Action.Repay), "above the line, still rescuing");
        _run(_check());
        assertApproxEqRel(SPOKE.getUserAccountData(alice).healthFactor, 1.12e18, 0.001e18, "back to 1.12");
        assertEq(_rescueAt(alice), 0, "done");
    }

    /// A rescue the account finished on its own (more backing here) ends without a move, and the run goes on.
    function test_a_rescue_the_account_finished_ends_without_a_move() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 2e6);
        _openCreditAt(alice, 1e8, 1.02e18);
        _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);
        _run(_check());
        assertGt(_rescueAt(alice), 0);
        _backWithNvda(alice, 1e8); // twice the backing: far over the target
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, alice);

        assertEq(uint8(x.planOf(alice).action), uint8(GooseExecutor.Action.EndRescue));
        vm.recordLogs();
        _run(_check());
        assertEq(_rescueAt(alice), 0, "ended");
        assertGe(SPOKE.getUserTotalDebt(USDC_RESERVE, alice), debt, "nothing repaid");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != GooseExecutor.ProtectRepaid.selector, "no repay");
        }
    }

    /// A rescue under way when the user switches Protect off and on again (JAW revokes, nothing prunes) doesn't come
    /// back with the new grant: Protect starts from its line again (money-safety review, B2).
    function test_a_new_protect_grant_ends_an_old_rescue() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 2e6);
        _openCreditAt(alice, 1e8, 1.02e18);
        PM.Permission memory p = _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);
        _run(_check());
        assertGt(_rescueAt(alice), 0, "a rescue under way");
        assertGt(SPOKE.getUserAccountData(alice).healthFactor, 1.03e18, "over the line now");

        _revokeThroughAccount(p); // switched off: nothing prunes it
        vm.warp(vm.getBlockTimestamp() + 1);
        _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6); // and on again
        assertEq(_rescueAt(alice), 0, "the new grant starts from the line");
        _withSavings(alice, 100e6);
        assertEq(uint8(x.planOf(alice).action), uint8(GooseExecutor.Action.None), "over 1.03: nothing to do");
    }

    /// With neither Protect job left on, the rescue ends.
    function test_switching_protect_off_ends_the_rescue() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 2e6);
        _openCreditAt(alice, 1e8, 1.02e18);
        PM.Permission memory p = _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);
        _run(_check());
        assertGt(_rescueAt(alice), 0);
        _revokeThroughAccount(p);
        x.prune(alice, GooseExecutor.Job.Protect);
        assertEq(_rescueAt(alice), 0);
    }

    /// Above Protect's line nothing moves: credit at 1.30 (Watch) or 1.08 (Act, a warning only), with savings, Protect
    /// from savings and Protect · sell all on, on a weekday or just before the weekend freeze.
    function test_above_protects_line_nothing_moves() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 100e6);
        _openCreditAt(alice, 1e8, 1.3e18);
        _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);
        _turnOnSell(alice);
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, alice);
        uint256 savings = AUSDC.balanceOf(alice);
        assertEq(uint8(x.planOf(alice).action), uint8(GooseExecutor.Action.None), "Watch");
        assertEq(_check().length, 0);
        vm.warp(_nextFridayUtc(vm.getBlockTimestamp()) + 19 hours + 30 minutes); // Friday 14:30 or 15:30 in New York
        assertFalse(x.frozen(vm.getBlockTimestamp()));
        assertEq(uint8(x.planOf(alice).action), uint8(GooseExecutor.Action.None), "nor before the weekend");
        assertEq(_check().length, 0);
        address[] memory work = new address[](1);
        work[0] = alice;
        _run(work); // listed anyway: still nothing
        assertGe(SPOKE.getUserTotalDebt(USDC_RESERVE, alice), debt, "nothing repaid (interest only)");
        assertGe(AUSDC.balanceOf(alice), savings, "savings untouched");
        // Act only warns; just under Protect's line it steps in.
        _drawMoreTo(alice, 1.08e18);
        assertEq(uint8(x.planOf(alice).action), uint8(GooseExecutor.Action.None), "Act only warns");
        _drawMoreTo(alice, 1.029e18);
        assertEq(uint8(x.planOf(alice).action), uint8(GooseExecutor.Action.Repay), "under the line");
    }

    /// D13: on a $5 test deploy Protect repays what the limits leave, aUSDC rounding included, and then waits, the
    /// rescue still under way.
    function test_protect_stays_within_both_daily_limits() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 100e6);
        _openCreditAt(alice, 1e8, 1.02e18);
        _turnOn(alice, GooseExecutor.Job.Protect, 5e6);
        uint256 hfBefore = SPOKE.getUserAccountData(alice).healthFactor;
        assertEq(x.planOf(alice).amount, 5e6 - 2);
        _run(_check());
        assertGt(SPOKE.getUserAccountData(alice).healthFactor, hfBefore);
        assertGt(_rescueAt(alice), 0, "short of the target: the rescue goes on");
        assertEq(_check().length, 0, "nothing left of today's limits");
    }

    function test_protect_comes_first_and_a_run_makes_one_move() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 100e6);
        _openCreditAt(alice, 1e8, 1.02e18);
        _turnOn(alice, GooseExecutor.Job.Save, 1_000e6);
        _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);
        deal(address(USDC), alice, USDC.balanceOf(alice) + 10e6);
        uint256 cash = USDC.balanceOf(alice);

        _run(_check());
        assertGt(SPOKE.getUserAccountData(alice).healthFactor, 1.11e18, "Protect first");
        assertEq(USDC.balanceOf(alice), cash, "and nothing else");
        _run(_check());
        assertEq(USDC.balanceOf(alice), 1e6, "Save on the next run");
    }

    /// Weekend Shield no longer repays: with the stress numbers at their widest (a 30% drop that must leave Protect's
    /// line), credit in Watch that the drop would take under it is left as it is on Friday afternoon. The app shows a
    /// card instead (lib/agents/rules/protect.ts `weekendHeadsUp`).
    function test_no_weekend_repay_above_protects_line() public {
        GooseExecutor.Config memory c = _config();
        c.thresholds = Thresholds({triggerHf: 1.03e18, targetHf: 1.12e18, stressDrop: 0.3e18, stressFloorHf: 1.03e18});
        x = _deploy(c);
        address alice = _newJawAccount("alice");
        _withSavings(alice, 100e6);
        _openCreditAt(alice, 1e8, 1.2e18);
        _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, alice);

        vm.warp(_nextFridayUtc(vm.getBlockTimestamp()) + 19 hours + 30 minutes); // 14:30 or 15:30 in New York
        assertFalse(x.frozen(vm.getBlockTimestamp()));
        assertEq(uint8(x.planOf(alice).action), uint8(GooseExecutor.Action.None), "Watch, before the freeze");
        assertEq(_check().length, 0);
        address[] memory work = new address[](1);
        work[0] = alice;
        _run(work); // listed anyway: still nothing
        assertGe(SPOKE.getUserTotalDebt(USDC_RESERVE, alice), debt, "nothing repaid (interest only)");
    }

    // ================================================================== failures (§6)

    function test_one_failing_account_does_not_stop_the_others() public {
        address alice = _inAct("alice");
        FakeAccount fake = new FakeAccount(false); // takes the batch and moves nothing
        _fakeInAct(address(fake));

        address[] memory work = _check();
        assertEq(work.length, 2);
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.RunFailed(address(fake), GooseExecutor.DebtNotLower.selector, 1);
        _run(work);

        assertGt(SPOKE.getUserAccountData(alice).healthFactor, 1.11e18, "alice repaid");
        (,,, uint8 fails, uint48 cooldownUntil) = x.jobsOf(address(fake));
        assertEq(fails, 1);
        assertEq(cooldownUntil, vm.getBlockTimestamp() + 10 minutes);
        assertEq(_check().length, 0, "the fake one cools down");
    }

    function test_a_gas_burner_is_contained() public {
        address alice = _inAct("alice");
        FakeAccount burner = new FakeAccount(true);
        _fakeInAct(address(burner));
        address[] memory work = new address[](2);
        work[0] = address(burner);
        work[1] = alice;
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.RunFailed(address(burner), bytes4(NO_REVERT_DATA), 1);
        vm.prank(forwarder);
        x.performUpkeep{gas: 5_000_000}(abi.encode(work));
        assertGt(SPOKE.getUserAccountData(alice).healthFactor, 1.11e18, "alice repaid after the burner");
    }

    /// More accounts with work than MAX_WORK in one page: each pass starts further on, so all of them get a turn.
    function test_a_busy_page_takes_turns() public {
        address[] memory all = new address[](10);
        for (uint256 i; i < all.length; ++i) {
            all[i] = _newJawAccount(string.concat("saver ", vm.toString(i)));
            _turnOn(all[i], GooseExecutor.Job.Save, 5e6);
            deal(address(USDC), all[i], 3e6);
        }
        address[] memory first = _check();
        assertEq(first.length, 8, "MAX_WORK");
        vm.roll(vm.getBlockNumber() + 5);
        address[] memory later = _check();
        for (uint256 i; i < all.length; ++i) {
            assertTrue(_includes(first, all[i]) || _includes(later, all[i]), "everyone is listed within two passes");
        }
    }

    function test_failures_back_off_then_switch_the_account_off() public {
        FakeAccount fake = new FakeAccount(false);
        _fakeInAct(address(fake));
        for (uint8 n = 1; n <= 8; ++n) {
            vm.warp(_failOnce(address(fake), n));
        }
        (uint8 jobs,,,,,,,,,) = x.accounts(address(fake));
        assertEq(jobs, 0, "Stuck after eight");
    }

    /// The n-th failed run in a row: the cooldown doubles, and a run before it ends skips the account.
    function _failOnce(address fake, uint8 n) internal returns (uint48 cooldownUntil) {
        address[] memory one = new address[](1);
        one[0] = fake;
        _run(one);
        uint8 fails;
        (,, fails, cooldownUntil,,,,,,) = x.accounts(fake);
        assertEq(fails, n);
        assertEq(cooldownUntil, vm.getBlockTimestamp() + (10 minutes << (n - 1)));
        _run(one);
        (,, fails,,,,,,,) = x.accounts(fake);
        assertEq(fails, n, "skipped while cooling down, not a failure");
    }

    /// A stray transfer to the executor can't stop runs: the post-check compares its balances with before the move.
    function test_a_transfer_to_the_executor_does_not_stop_runs() public {
        deal(address(USDC), address(x), 1e6);
        vm.deal(address(x), 1 ether);
        address alice = _inAct("alice");
        _run(_check());
        assertGt(SPOKE.getUserAccountData(alice).healthFactor, 1.11e18);
    }

    function test_runs_prune_revoked_and_expired_permissions() public {
        address alice = _newJawAccount("alice");
        PM.Permission memory pa = _turnOn(alice, GooseExecutor.Job.Save, 5e6);
        _revokeThroughAccount(pa);
        address bob = _newJawAccount("bob");
        PM.Permission memory pb = _permission(bob, GooseExecutor.Job.Save, 5e6);
        pb.end = uint48(vm.getBlockTimestamp() + 1 hours);
        _grantThroughAccount(pb);
        _register(GooseExecutor.Job.Save, pb, 5e6);
        address carol = _newJawAccount("carol");
        _turnOn(carol, GooseExecutor.Job.Save, 5e6);
        deal(address(USDC), alice, 5e6);
        deal(address(USDC), carol, 5e6);
        vm.warp(vm.getBlockTimestamp() + 2 hours);

        assertEq(_check().length, 3, "a dead permission is listed so the run can prune it");
        address[] memory work = new address[](3);
        work[0] = alice;
        work[1] = bob;
        work[2] = carol;
        vm.expectEmit(true, true, false, true, address(x));
        emit GooseExecutor.JobOff(alice, GooseExecutor.Job.Save, GooseExecutor.OffReason.Revoked);
        vm.expectEmit(true, true, false, true, address(x));
        emit GooseExecutor.JobOff(bob, GooseExecutor.Job.Save, GooseExecutor.OffReason.Expired);
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.Saved(carol, 4e6);
        _run(work);
        assertEq(USDC.balanceOf(alice), 5e6, "a revoked agent moves nothing");
        assertEq(_check().length, 0);
    }
}

/// The deploy's PAGE_SIZE holds: a full page of the costliest accounts that need nothing checks in under 8.5M gas.
/// Each is under Protect's line (Protect reads more only there) with savings too small to repay from, so
/// Protect pays for every read (debt, account data, savings, both limits) and finds no move; Protect · sell is on for
/// all seven stocks and waits, as prices are held (a weekend), on the health Protect read; Save is on with nothing
/// above the keep-back. The page is built in setUp, which forge runs as its own transaction, so the check pays cold
/// storage, as a real one does. The next page comes up on the next block, and a second shard owns it alone.
contract ExecutorPageForkTest is ExecutorForkBase {
    address nextPage;

    function setUp() public {
        _fork();
        x = _deploy(_config());
        for (uint256 r; r < STOCKS.length; ++r) {
            if (STOCKS[r] != NVDAC) _useStockDouble(STOCKS[r]);
        }
        for (uint256 i; i < x.PAGE_SIZE(); ++i) {
            address a = _newJawAccount(string.concat("owes ", vm.toString(i)));
            _withSavings(a, 0.01e6); // a cent: less than the smallest repay
            _backWithAllStocks(a, 1e8);
            uint256 drawn = _drawTo(a, 1.02e18);
            vm.prank(a);
            USDC.transfer(attacker, drawn); // the credit leaves the wallet
            _turnOn(a, GooseExecutor.Job.Protect, 5e6);
            _turnOn(a, GooseExecutor.Job.Save, 5e6);
            _turnOnSell(a);
        }
        nextPage = _inAct("next page");
        vm.roll(vm.getBlockNumber() + vm.getBlockNumber() % 2); // even: shard 0 of 1 scans page 0
        vm.warp(_nextFridayUtc(vm.getBlockTimestamp()) + 1 days + 12 hours); // Saturday: prices are held
    }

    function test_a_worst_case_page_checks_under_8_5M_gas() public {
        uint256 before = gasleft();
        (bool needed,) = x.checkUpkeep(abi.encode(uint256(0), uint256(1)));
        uint256 gas = before - gasleft();
        console.log("worst-case page check, gas:", gas);
        assertLt(gas, 8_500_000);
        assertFalse(needed, "page 0: nothing to do");
        assertEq(x.memberCount(), x.PAGE_SIZE() + 1);

        vm.roll(vm.getBlockNumber() + 1);
        assertEq(_check()[0], nextPage, "page 1 on the next block");
        (bool shard1,) = x.checkUpkeep(abi.encode(uint256(1), uint256(2)));
        assertTrue(shard1, "shard 1 of 2 owns page 1");
        (bool shard0,) = x.checkUpkeep(abi.encode(uint256(0), uint256(2)));
        assertFalse(shard0, "shard 0 of 2 owns page 0 only");
    }
}

/// The same full page on a weekday, where Protect · sell plans too: every account under the line with a cent of savings and
/// selling on, and every stock's pool too far under Aave's price to fill, so each check reads Protect's savings and
/// limits, then SellJob's grant, limits and all seven stocks and pools, and finds nothing to do. The weekend page above
/// skips that planning (prices are held). Measured 2026-10-15: about 21.2M gas for the whole page, so this page does
/// not fit one check; under Base's 10M check limit the scan stops at CHECK_RESERVE without reverting, and each pass
/// starts one account further on, so the page is still looked at in full over a few passes.
contract ExecutorWeekdayPageForkTest is ExecutorForkBase {
    function setUp() public {
        _fork();
        x = _deploy(_config());
        for (uint256 r; r < STOCKS.length; ++r) {
            if (STOCKS[r] != NVDAC) _useStockDouble(STOCKS[r]);
        }
        for (uint256 i; i < x.PAGE_SIZE(); ++i) {
            address a = _newJawAccount(string.concat("owes ", vm.toString(i)));
            _withSavings(a, 0.01e6);
            _backWithAllStocks(a, 1e8);
            uint256 drawn = _drawTo(a, 1.02e18);
            vm.prank(a);
            USDC.transfer(attacker, drawn);
            _turnOn(a, GooseExecutor.Job.Protect, 5e6);
            _turnOn(a, GooseExecutor.Job.Save, 5e6);
            _turnOnSell(a);
        }
        // Every pool's price near zero, whichever side USDC is on: none can fill a sale, so there is nothing to warn
        // about either.
        IAeroFactory factory = IAeroFactory(IAeroRouter(x.ROUTER()).factory());
        for (uint256 r; r < STOCKS.length; ++r) {
            address pool = factory.getPool(STOCKS[r], address(USDC), 10);
            assertTrue(pool != address(0), "every stock has its pool");
            uint160 sqrtPrice = address(USDC) < STOCKS[r] ? uint160(1 << 150) : uint160(1 << 40);
            vm.mockCall(
                pool,
                abi.encodeWithSelector(IAeroPool.slot0.selector),
                abi.encode(sqrtPrice, int24(0), uint16(0), uint16(0), uint16(0), true)
            );
        }
        vm.roll(vm.getBlockNumber() + vm.getBlockNumber() % 2); // even: shard 0 of 1 scans page 0
        vm.warp(_nextFridayUtc(vm.getBlockTimestamp()) + 5 days + 16 hours); // a Wednesday, noon in New York
    }

    function test_a_worst_case_weekday_page_is_checked_over_passes_within_the_10M_limit() public {
        assertFalse(x.frozen(vm.getBlockTimestamp()), "a weekday, prices live");
        bytes memory checkData = abi.encode(uint256(0), uint256(1));
        uint256 before = gasleft();
        (bool needed,) = x.checkUpkeep(checkData);
        console.log("worst-case weekday page, whole page in one check, gas:", before - gasleft());
        assertFalse(needed, "page 0: nothing to do, nothing to sell");

        (bool ok, bytes memory ret) =
            address(x).staticcall{gas: 10_000_000}(abi.encodeCall(GooseExecutor.checkUpkeep, (checkData)));
        assertTrue(ok, "the check returns within Base's 10M limit");
        (needed,) = abi.decode(ret, (bool, bytes));
        assertFalse(needed);
    }
}

/// MAX_WORK accounts that all need Protect (under its line), built in setUp so the measured calls pay cold storage.
contract ExecutorRunForkTest is ExecutorForkBase {
    address[] act;

    function setUp() public {
        _fork();
        x = _deploy(_config());
        for (uint256 i; i < x.MAX_WORK(); ++i) {
            act.push(_inAct(string.concat("act ", vm.toString(i))));
        }
    }

    function test_a_full_run_repays_all_within_5M_gas() public {
        address[] memory list = act;
        bytes memory performData = abi.encode(list);
        vm.prank(forwarder);
        uint256 before = gasleft();
        x.performUpkeep(performData);
        uint256 gas = before - gasleft();
        console.log("run of MAX_WORK Protect repays, gas:", gas);
        assertLt(gas, 5_000_000);
        for (uint256 i; i < list.length; ++i) {
            assertGt(SPOKE.getUserAccountData(list[i]).healthFactor, 1.11e18);
        }
    }

    function test_the_check_lists_a_full_run_in_under_2000_bytes() public view {
        (bool needed, bytes memory performData) = x.checkUpkeep(abi.encode(uint256(0), uint256(1)));
        assertTrue(needed);
        assertLe(performData.length, 2000);
        address[] memory listed = _check();
        address[] memory all = act;
        assertEq(listed.length, all.length);
        for (uint256 i; i < all.length; ++i) {
            assertTrue(_includes(listed, all[i]));
        }
    }
}
