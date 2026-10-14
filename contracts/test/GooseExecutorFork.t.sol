// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {Log} from "chainlink/automation/interfaces/ILogAutomation.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
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
            job, account, GooseExecutor.Grant(start, start + 365 days, cap), uint256(keccak256(abi.encode(++salts)))
        );
    }

    function _turnOn(address account, GooseExecutor.Job job, uint160 cap) internal returns (PM.Permission memory p) {
        p = _permission(account, job, cap);
        _grantThroughAccount(p);
        _register(job, p, cap);
    }

    function _register(GooseExecutor.Job job, PM.Permission memory p, uint160 cap) internal {
        x.register(job, p.account, p.start, p.end, p.salt, cap);
    }

    /// $100 of savings and a loan at health 1.30, with Protect on.
    function _inWatch(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        _withSavings(a, 100e6);
        _openCreditAt(a, 1e8, 1.3e18);
        _turnOn(a, GooseExecutor.Job.Protect, 1_000e6);
    }

    /// The same for a fake account, which approves its own permission (it isn't a JAW account).
    function _fakeInWatch(address fake) internal {
        _withSavings(fake, 100e6);
        _openCreditAt(fake, 1e8, 1.3e18);
        PM.Permission memory p = _permission(fake, GooseExecutor.Job.Protect, 1_000e6);
        vm.prank(fake);
        MANAGER.approve(p);
        _register(GooseExecutor.Job.Protect, p, 1_000e6);
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
        (, bytes memory listed) = abi.decode(performData, (GooseExecutor.Mode, bytes));
        return abi.decode(listed, (address[]));
    }

    function _run(address[] memory accounts) internal {
        vm.prank(forwarder);
        x.performUpkeep(abi.encode(GooseExecutor.Mode.Run, abi.encode(accounts)));
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

    function _chainlinkLog(Vm.Log memory l) internal view returns (Log memory) {
        return Log({
            index: 0,
            timestamp: vm.getBlockTimestamp(),
            txHash: bytes32(0),
            blockNumber: vm.getBlockNumber(),
            blockHash: bytes32(0),
            source: l.emitter,
            topics: l.topics,
            data: l.data
        });
    }

    /// 00:00 UTC on the next Friday after `ts`.
    function _nextFridayUtc(uint256 ts) internal pure returns (uint256) {
        uint256 d = ts / 1 days + 1;
        return (d + (8 - d % 7) % 7) * 1 days; // day 1 (1970-01-02) was a Friday
    }
}

/// GooseExecutor against the real JAW permission manager, Aave V3 savings and the Aave V4 Equities Hub on a Base fork,
/// with fresh JAW accounts granted the way JAW's screen grants (checker 0, start = now, a random salt). Chainlink
/// can't run on a fork, so the forwarder is pranked. Needs BASE_RPC_URL. The tests read the time through
/// vm.getBlockTimestamp(): compiled through the IR pipeline with GooseExecutor, a test may reuse an earlier
/// `block.timestamp` after a warp.
contract GooseExecutorForkTest is ExecutorForkBase {
    bytes32 constant NO_REVERT_DATA = bytes32(0);

    function setUp() public {
        _fork();
        x = _deploy(_config());
    }

    // ================================================================== registration (§4)

    function test_a_jaw_grant_registers_through_the_log_trigger() public {
        address alice = _newJawAccount("alice");
        PM.Permission memory p = _permission(alice, GooseExecutor.Job.Protect, 5e6);
        vm.recordLogs();
        _grantThroughAccount(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Log memory log = _chainlinkLog(logs[0]);

        (bool needed, bytes memory performData) = x.checkLog(log, "");
        assertTrue(needed, "our grant");
        vm.expectEmit(true, true, false, true, address(x));
        emit GooseExecutor.JobOn(alice, GooseExecutor.Job.Protect, MANAGER.getHash(p), 5e6, p.end);
        vm.prank(forwarder);
        x.performUpkeep(performData);

        (uint8 jobs,, GooseExecutor.Grant memory protect,,) = x.jobsOf(alice);
        assertEq(jobs, 2);
        assertEq(protect.cap, 5e6);
        assertEq(x.memberCount(), 1);
        assertEq(abi.encode(x.permissionOf(alice, GooseExecutor.Job.Protect)), abi.encode(p), "rebuilt exactly");
        (needed,) = x.checkLog(log, "");
        assertFalse(needed, "nothing left to do for the same log");

        // The same grant for another spender is someone else's.
        address bob = _newJawAccount("bob");
        PM.Permission memory other = _permission(bob, GooseExecutor.Job.Save, 5e6);
        other.spender = attacker;
        vm.recordLogs();
        _grantThroughAccount(other);
        (needed,) = x.checkLog(_chainlinkLog(vm.getRecordedLogs()[0]), "");
        assertFalse(needed, "another spender");
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

    function test_a_forged_registration_reverts_and_registration_works_while_paused() public {
        address alice = _newJawAccount("alice");
        PM.Permission memory p = _permission(alice, GooseExecutor.Job.Protect, 5e6);
        bytes memory forged = abi.encode(
            GooseExecutor.Mode.Register, abi.encode(GooseExecutor.Job.Protect, alice, p.start, p.end, p.salt, uint160(5e6))
        );
        vm.prank(forwarder);
        vm.expectRevert(GooseExecutor.NotApproved.selector);
        x.performUpkeep(forged);

        vm.prank(owner);
        x.pause();
        _grantThroughAccount(p);
        vm.prank(forwarder);
        x.performUpkeep(forged); // no longer forged: Alice approved it
        (uint8 jobs,,,,) = x.jobsOf(alice);
        assertEq(jobs, 2, "registered while paused");
    }

    /// GooseExecutor.md §3: the app's grant (lib/agents/permissions.ts, hashed in scripts/agent-vectors.ts) and the
    /// executor's template give the same manager hash on 50 random inputs.
    function test_templates_hash_like_the_apps_builder() public {
        vm.etch(Vectors.HASH_SPENDER, address(x).code);
        ExecutorHarness h = ExecutorHarness(Vectors.HASH_SPENDER);
        bytes32[] memory hashes = vm.parseJsonBytes32Array(vm.readFile("test/vectors/permissions.json"), ".hashes");
        assertEq(hashes.length, 50);
        for (uint256 i; i < hashes.length; ++i) {
            Vectors.Hash memory v = Vectors.hashInput(i);
            PM.Permission memory p =
                h.permissionFor(GooseExecutor.Job(v.job), v.account, GooseExecutor.Grant(v.start, v.end, v.cap), v.salt);
            assertEq(MANAGER.getHash(p), hashes[i], string.concat("vector ", vm.toString(i)));
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

    function test_a_loan_in_watch_is_repaid_from_savings_back_to_the_target() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 100e6);
        _openCreditAt(alice, 1e8, 1.3e18);
        PM.Permission memory p = _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);
        uint256 debtBefore = SPOKE.getUserTotalDebt(USDC_RESERVE, alice);
        uint256 savingsBefore = AUSDC.balanceOf(alice);

        GooseExecutor.Plan memory plan = x.planOf(alice);
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Repay));
        assertEq(uint8(plan.reason), uint8(ProtectCase.Watch));
        address[] memory work = _check();
        assertEq(work[0], alice);
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.ProtectRepaid(alice, 0, 0, 0, ProtectCase.Watch);
        _run(work);

        uint256 hf = SPOKE.getUserAccountData(alice).healthFactor;
        assertApproxEqRel(hf, 1.65e18, 0.001e18, "back to the target");
        assertApproxEqAbs(debtBefore - SPOKE.getUserTotalDebt(USDC_RESERVE, alice), plan.amount, 2, "repaid");
        assertApproxEqAbs(savingsBefore - AUSDC.balanceOf(alice), plan.amount, 2, "from savings");
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[0]).spend, plan.amount, "USDC limit charged");
        assertApproxEqAbs(MANAGER.getCurrentPeriod(p, p.spends[1]).spend, plan.amount, 2, "savings limit charged");
        _assertHoldsNothing();
        assertEq(_check().length, 0, "Safe again");
    }

    /// D13: on a $5 test deploy Protect repays what the limits leave, aUSDC rounding included, and then waits.
    function test_protect_stays_within_both_daily_limits() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 100e6);
        _openCreditAt(alice, 1e8, 1.3e18);
        _turnOn(alice, GooseExecutor.Job.Protect, 5e6);
        uint256 hfBefore = SPOKE.getUserAccountData(alice).healthFactor;
        assertEq(x.planOf(alice).amount, 5e6 - 2);
        _run(_check());
        assertGt(SPOKE.getUserAccountData(alice).healthFactor, hfBefore);
        assertEq(_check().length, 0, "nothing left of today's limits");
    }

    function test_protect_comes_first_and_a_run_makes_one_move() public {
        address alice = _newJawAccount("alice");
        _withSavings(alice, 100e6);
        _openCreditAt(alice, 1e8, 1.3e18);
        _turnOn(alice, GooseExecutor.Job.Save, 1_000e6);
        _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);
        deal(address(USDC), alice, USDC.balanceOf(alice) + 10e6);
        uint256 cash = USDC.balanceOf(alice);

        _run(_check());
        assertGt(SPOKE.getUserAccountData(alice).healthFactor, 1.6e18, "Protect first");
        assertEq(USDC.balanceOf(alice), cash, "and nothing else");
        _run(_check());
        assertEq(USDC.balanceOf(alice), 1e6, "Save on the next run");
    }

    /// Weekend Shield with thresholds where it can act (with the defaults it never does: GooseExecutor.t.sol). A Safe loan that a
    /// 30% drop would push under 1.40 is trimmed on Friday afternoon, not on Tuesday.
    function test_weekend_shield_trims_a_fragile_loan_before_the_freeze() public {
        GooseExecutor.Config memory c = _config();
        c.thresholds = Thresholds({triggerHf: 1.5e18, targetHf: 1.65e18, stressDrop: 0.3e18, stressFloorHf: 1.4e18});
        x = _deploy(c);
        address alice = _newJawAccount("alice");
        _withSavings(alice, 100e6);
        _openCreditAt(alice, 1e8, 1.8e18);
        _turnOn(alice, GooseExecutor.Job.Protect, 1_000e6);

        vm.warp(_nextFridayUtc(vm.getBlockTimestamp()) + 12 hours); // Friday 07:00 or 08:00 in New York
        assertEq(uint8(x.planOf(alice).action), uint8(GooseExecutor.Action.None), "outside the window");
        vm.warp(vm.getBlockTimestamp() + 7 hours + 30 minutes); // 14:30 or 15:30
        GooseExecutor.Plan memory plan = x.planOf(alice);
        assertEq(uint8(plan.reason), uint8(ProtectCase.WeekendShield));
        _run(_check());
        uint256 hf = SPOKE.getUserAccountData(alice).healthFactor;
        assertApproxEqRel(hf * 0.7e18 / 1e18, 1.55e18, 0.002e18, "a 30% drop now leaves the floor plus headroom");
    }

    // ================================================================== failures (§6)

    function test_one_failing_account_does_not_stop_the_others() public {
        address alice = _inWatch("alice");
        FakeAccount fake = new FakeAccount(false); // takes the batch and moves nothing
        _fakeInWatch(address(fake));

        address[] memory work = _check();
        assertEq(work.length, 2);
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.RunFailed(address(fake), GooseExecutor.DebtNotLower.selector, 1);
        _run(work);

        assertGt(SPOKE.getUserAccountData(alice).healthFactor, 1.6e18, "alice repaid");
        (,,, uint8 fails, uint48 cooldownUntil) = x.jobsOf(address(fake));
        assertEq(fails, 1);
        assertEq(cooldownUntil, vm.getBlockTimestamp() + 10 minutes);
        assertEq(_check().length, 0, "the fake one cools down");
    }

    function test_a_gas_burner_is_contained() public {
        address alice = _inWatch("alice");
        FakeAccount burner = new FakeAccount(true);
        _fakeInWatch(address(burner));
        address[] memory work = new address[](2);
        work[0] = address(burner);
        work[1] = alice;
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.RunFailed(address(burner), bytes4(NO_REVERT_DATA), 1);
        vm.prank(forwarder);
        x.performUpkeep{gas: 5_000_000}(abi.encode(GooseExecutor.Mode.Run, abi.encode(work)));
        assertGt(SPOKE.getUserAccountData(alice).healthFactor, 1.6e18, "alice repaid after the burner");
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
        _fakeInWatch(address(fake));
        for (uint8 n = 1; n <= 8; ++n) {
            vm.warp(_failOnce(address(fake), n));
        }
        (uint8 jobs,,,,,) = x.accounts(address(fake));
        assertEq(jobs, 0, "Stuck after eight");
    }

    /// The n-th failed run in a row: the cooldown doubles, and a run before it ends skips the account.
    function _failOnce(address fake, uint8 n) internal returns (uint48 cooldownUntil) {
        address[] memory one = new address[](1);
        one[0] = fake;
        _run(one);
        uint8 fails;
        (, , fails, cooldownUntil,,) = x.accounts(fake);
        assertEq(fails, n);
        assertEq(cooldownUntil, vm.getBlockTimestamp() + (10 minutes << (n - 1)));
        _run(one);
        (, , fails,,,) = x.accounts(fake);
        assertEq(fails, n, "skipped while cooling down, not a failure");
    }

    /// A stray transfer to the executor can't stop runs: the post-check compares its balances with before the move.
    function test_a_transfer_to_the_executor_does_not_stop_runs() public {
        deal(address(USDC), address(x), 1e6);
        vm.deal(address(x), 1 ether);
        address alice = _inWatch("alice");
        _run(_check());
        assertGt(SPOKE.getUserAccountData(alice).healthFactor, 1.6e18);
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
/// Each is in Watch with savings too small to repay from, so Protect pays for every read (debt, account data, savings,
/// both limits) and finds no move; Save is on with nothing above the keep-back. The page is built in setUp, which
/// forge runs as its own transaction, so the check pays cold storage, as a real one does. The next page comes up on the
/// next block, and a second shard owns it alone.
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
            uint256 drawn = _drawTo(a, 1.3e18);
            vm.prank(a);
            USDC.transfer(attacker, drawn); // the credit leaves the wallet
            _turnOn(a, GooseExecutor.Job.Protect, 5e6);
            _turnOn(a, GooseExecutor.Job.Save, 5e6);
        }
        nextPage = _inWatch("next page");
        vm.roll(vm.getBlockNumber() + vm.getBlockNumber() % 2); // even: shard 0 of 1 scans page 0
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

/// MAX_WORK accounts that all need Protect, built in setUp so the measured calls pay cold storage.
contract ExecutorRunForkTest is ExecutorForkBase {
    address[] watch;

    function setUp() public {
        _fork();
        x = _deploy(_config());
        for (uint256 i; i < x.MAX_WORK(); ++i) {
            watch.push(_inWatch(string.concat("watch ", vm.toString(i))));
        }
    }

    function test_a_full_run_repays_all_within_5M_gas() public {
        address[] memory list = watch;
        bytes memory performData = abi.encode(GooseExecutor.Mode.Run, abi.encode(list));
        vm.prank(forwarder);
        uint256 before = gasleft();
        x.performUpkeep(performData);
        uint256 gas = before - gasleft();
        console.log("run of MAX_WORK Protect repays, gas:", gas);
        assertLt(gas, 5_000_000);
        for (uint256 i; i < list.length; ++i) {
            assertGt(SPOKE.getUserAccountData(list[i]).healthFactor, 1.6e18);
        }
    }

    function test_the_check_lists_a_full_run_in_under_2000_bytes() public view {
        (bool needed, bytes memory performData) = x.checkUpkeep(abi.encode(uint256(0), uint256(1)));
        assertTrue(needed);
        assertLe(performData.length, 2000);
        address[] memory listed = _check();
        address[] memory all = watch;
        assertEq(listed.length, all.length);
        for (uint256 i; i < all.length; ++i) {
            assertTrue(_includes(listed, all[i]));
        }
    }
}
