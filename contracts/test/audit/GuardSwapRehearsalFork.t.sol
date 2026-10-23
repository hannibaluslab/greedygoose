// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {DeployGuard} from "../../script/DeployGuard.s.sol";
import {GooseGuard} from "../../src/GooseGuard.sol";
import {GoosePlanner} from "../../src/GoosePlanner.sol";
import {GuardForkBase} from "../GuardForkBase.sol";
import {IJustaPermissionManager as PM, IJustanAccount} from "../IJustaPermissionManager.sol";

/// GooseExecutor.Plan, as 0x686c returns it (src/GooseExecutor.sol:131-138; enums are uint8 on the wire).
struct OldPlan {
    uint8 action;
    uint8 job;
    uint256 amount;
    uint256 hf;
    uint8 reason;
    uint8 off;
}

/// The parts of the live GooseExecutor 0x686c this rehearsal reads and drives (src/GooseExecutor.sol).
interface IOldExecutor {
    function accounts(address)
        external
        view
        returns (
            uint8 jobs,
            uint32 index,
            uint8 fails,
            uint48 cooldownUntil,
            uint32 savesDay,
            uint8 savesToday,
            uint48 rescueAt,
            bool keepMix,
            uint32 rebalanceDay,
            uint32 protectIndex
        );
    function mixes(address) external view returns (uint256);
    function topUps(address)
        external
        view
        returns (bool on, uint32 day, uint48 keep, uint56 ready, uint56 today, uint56 mark, uint256 own);
    function permissionOf(address account, uint8 job) external view returns (PM.Permission memory);
    function planOf(address account) external view returns (OldPlan memory);
    function checkUpkeep(bytes calldata checkData) external view returns (bool, bytes memory);
    function performUpkeep(bytes calldata performData) external;
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
    function owner() external view returns (address);
    function isForwarder(address) external view returns (bool);
    function memberCount() external view returns (uint256);
}

/// The app's shapes for GooseGuard.accountOf (lib/agents/abis/GooseGuard.ts), declared here on their own so a decode
/// with them checks the app's ABI, not the contract's own types.
struct AppAccount {
    uint24 index;
    uint8 jobs;
    uint32 rescueAt;
    uint32 sessionAt;
    address runner;
}

struct AppSettings {
    uint112 mix;
    uint16 line;
    uint16 target;
    uint32 mixSetAt;
    bool keepMix;
    bool topUpsOn;
    uint48 keep;
}

struct AppPlan {
    uint8 action;
    uint8 job;
    uint256 amount;
    uint256 hf;
    uint8 reason;
    uint8 off;
}

/// The swap rehearsal: production moves from GooseExecutor 0x686c to GooseGuard + GoosePlanner, on a Base fork at the
/// latest block, with the team's two real accounts and their real positions.
///   1. DeployGuard's own run() with GUARD_OWNER = the deployer and the default runner, read back.
///   2. Each account's real position and live jobs on 0x686c, then the same agents granted to the Guard the way the
///      app on jl/guard builds them (lib/agents/permissions.ts, oneTapGrant.ts), approved through the account, and
///      registered, with its mix and top-ups carried over.
///   3. KeeperHub's workflow as configured: read Planner.checkUpkeep(abi.encode(0, 1)), write Guard.performUpkeep at
///      KeeperHub's gas, read, write, every 10 minutes.
///   4. Protect on the real positions: stock prices fall until each account is under its line.
///   5. Both executors in the same window, a split workflow, and the owner pausing 0x686c.
///   6. The views the app reads, decoded with the app's shapes.
/// Run: BASE_RPC_URL=https://base-rpc.publicnode.com forge test --match-path test/GuardSwapRehearsalFork.t.sol -vv
/// REHEARSAL_BLOCK pins the fork to one block (Foundry's RPC cache then serves reruns); unset, it forks at the latest.
contract GuardSwapRehearsalForkTest is GuardForkBase {
    address constant OWNER = 0xF3bBaa5f6BEAF49732c28D2bdd2b772AA01031aD;
    IOldExecutor constant OLD = IOldExecutor(0x686cd88F248DE3F9FC0835566DB798D93881F02D);
    address constant A1 = 0xFf13Dc32AcA90b3D61058ea26Df1D895F842eE1F;
    address constant A2 = 0x33fd640a60542430C256E125c8Da037695e1bD30;
    bytes32 constant JAW_CLONE = 0xc79e2c8f7a03b38abd65a7e073fc3410849544bba74f53360c127775bc891848;
    /// An eth_call cap well above the Planner's own 8M budget.
    uint256 constant READ_CAP = 50_000_000;
    /// KeeperHub's write gas limit (workflow step 2_4afTvEv5AZkdoX1m4w9); KH_GAS (5.4M) is what reaches the Guard.
    uint256 constant KH_TX_GAS = 5_500_000;
    uint256 constant LINE = 1.03e18;
    uint256 constant TARGET = 1.12e18;
    uint256 constant OVER = 0.01e18;
    uint256 constant DONE_GAP = 0.001e18;
    /// Where each fall puts an account: just under its line.
    uint256 constant DROP_TO = 1.02e18;

    bytes32 constant T_REPAID = keccak256("ProtectRepaid(address,uint256,uint256,uint256,uint256)");
    bytes32 constant T_SOLD = keccak256("ProtectSold(address,uint256[7],uint256,uint256,uint256)");
    bytes32 constant T_SAVED = keccak256("Saved(address,uint256)");
    bytes32 constant T_REBALANCED = keccak256("Rebalanced(address,uint256[7],uint256[7])");
    bytes32 constant T_TOPUP = keccak256("TopUpInvested(address,uint256,uint256[7])");
    bytes32 constant T_ENDED = keccak256("RescueEnded(address)");
    bytes32 constant T_REFRESHED = keccak256("ConfigRefreshed(address,uint256,uint256)");
    bytes32 constant T_CONVERTED = keccak256("EntryConverted(address,address,uint256,uint256)");
    // 0x686c's own events (src/GooseExecutor.sol:281, 300).
    bytes32 constant T_OLD_REPAID = keccak256("ProtectRepaid(address,uint256,uint256,uint256,uint8)");
    bytes32 constant T_OLD_FAILED = keccak256("RunFailed(address,bytes4,uint8)");
    bytes4 constant RUNS_PAUSED = bytes4(keccak256("RunsPaused()"));

    GoosePlanner planner;
    address deployer;

    function setUp() public {
        uint256 pin = vm.envOr("REHEARSAL_BLOCK", uint256(0));
        if (pin == 0) vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        else vm.createSelectFork(vm.envString("BASE_RPC_URL"), pin);
        console2.log("fork block, timestamp", block.number, block.timestamp);

        // Step 1: the release's own code path (script/DeployGuard.s.sol:41-53), on the real chain state.
        vm.setEnv("GUARD_OWNER", vm.toString(OWNER));
        DeployGuard d = new DeployGuard();
        (g, planner) = d.run();
        vm.label(address(g), "GooseGuard");
        vm.label(address(planner), "GoosePlanner");
        vm.label(address(OLD), "GooseExecutor-0x686c");
        vm.label(KEEPERHUB, "KeeperHub");
        vm.label(A1, "A1");
        vm.label(A2, "A2");

        // B20 stocks can't run in Foundry's EVM (test/StockDouble.sol): the doubles get the real balances of the hub,
        // each pool and both accounts' wallets, read from the node at this block.
        uint256[7] memory w1;
        uint256[7] memory w2;
        for (uint256 r; r < 7; ++r) {
            w1[r] = _realBalance(STOCKS[r], A1);
            w2[r] = _realBalance(STOCKS[r], A2);
        }
        for (uint256 r; r < 7; ++r) {
            _useStockDouble(STOCKS[r]);
            address pool = _poolOf(r);
            deal(STOCKS[r], pool, _realBalance(STOCKS[r], pool));
            deal(STOCKS[r], A1, w1[r]);
            deal(STOCKS[r], A2, w2[r]);
        }
    }

    // ================================================================== 1. the deploy, read back

    function test_1_the_release_deploy_reads_back_the_decided_settings() public {
        // Owner and runner (decision 8: one deployer key; KeeperHub the only runner).
        assertEq(g.owner(), OWNER, "owner is not the deployer key");
        assertTrue(g.isRunner(KEEPERHUB), "KeeperHub is not the runner");
        assertFalse(g.isRunner(OWNER), "the owner is a runner");
        assertFalse(g.isRunner(address(this)), "the test is a runner");
        assertFalse(g.isRunner(0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38), "forge's default sender is a runner");
        assertFalse(g.paused(), "deployed paused");
        assertEq(g.membersLength(), 0);
        assertTrue(g.codehashOk(JAW_CLONE), "JAW's clone may not register");
        assertEq(A1.codehash, JAW_CLONE, "A1 is not JAW's clone");
        assertEq(A2.codehash, JAW_CLONE, "A2 is not JAW's clone");
        // The floors (DeployGuard.s.sol:35-38, step0-facts.md).
        assertEq(g.SALE_FLOOR_BPS(), 300, "sale floor");
        assertEq(g.SWAP_FLOOR_BPS(), 50, "swap floor");
        assertEq(g.BAND_BPS(), 100, "pool band, two-sided 1%");
        assertEq(g.TIGHT_BPS(), 40, "tight band");
        assertEq(g.KEEP_BACK(), 1e6, "keep-back");
        assertEq(g.DUST(), 1e6, "dust");
        // Protect 1.03 back to 1.12 by default (decision 3).
        {
            (uint256 line, uint256 target) = g.linesOf(makeAddr("anyone"));
            assertEq(line, LINE, "default line");
            assertEq(target, TARGET, "default target");
        }
        // The Planner and its parts plan for this Guard; no minimum anywhere (decision 9); no calendar (decision 7).
        assertEq(address(planner.GUARD()), address(g));
        assertEq(address(planner.PROTECT().GUARD()), address(g));
        assertEq(address(planner.TRADER().GUARD()), address(g));
        assertEq(address(planner.CASH().GUARD()), address(g));
        assertFalse(planner.SKIP_WEEKENDS(), "the Planner skips weekends");
        assertEq(planner.PACK_GAS(), 5_300_000, "pack gas");
        _plannerNumbers();
        // Sizes under the 24 KB limit.
        _size("GooseGuard", address(g));
        _size("GoosePlanner", address(planner));
        _size("ProtectPlanner", address(planner.PROTECT()));
        _size("TradePlanner", address(planner.TRADER()));
        _size("CashPlanner", address(planner.CASH()));

        // Owner changes wait 48 hours, and only after the wait does a new runner count.
        address helper = makeAddr("second runner");
        bytes32 arg = bytes32(uint256(uint160(helper)));
        vm.prank(OWNER);
        bytes32 id = g.queueChange(0, arg);
        uint256 eta = g.queued(id);
        assertEq(eta, block.timestamp + 48 hours, "the wait is not 48 hours");
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(GooseGuard.TooEarly.selector, eta));
        g.applyChange(0, arg);
        vm.warp(eta);
        g.applyChange(0, arg);
        assertTrue(g.isRunner(helper));
        // A stranger can't pause, and the owner's pause is instant.
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(GooseGuard.NotOwner.selector);
        g.pause();

        // The live executor today.
        console2.log("0x686c owner, paused, KeeperHub forwarder", OLD.owner(), OLD.paused(), OLD.isForwarder(KEEPERHUB));
        console2.log("0x686c members", OLD.memberCount());
        assertEq(OLD.owner(), OWNER, "0x686c's owner is not the deployer key");
    }

    function _plannerNumbers() internal view {
        (uint64 trig, uint64 tgt,,) = planner.thresholds();
        assertEq(trig, LINE);
        assertEq(tgt, TARGET);
        (uint64 minRepay, uint64 minSave, uint64 keepBack,,) = planner.amounts();
        assertEq(minRepay, 0, "a minimum repay");
        assertEq(minSave, 0, "a minimum save");
        assertEq(keepBack, 1e6);
        (,,,, uint64 minTrade,) = planner.rebalanceLimits();
        assertEq(minTrade, 0, "a minimum trade");
    }

    function _size(string memory name, address at) internal view {
        console2.log(name, "runtime bytes", at.code.length);
        assertLe(at.code.length, 24_576, string.concat(name, " over the code limit"));
    }

    // ================================================================== 2. the two accounts move over

    function test_2_both_accounts_move_over_with_their_agents_and_settings() public {
        _logOld(A1, "A1");
        _logOld(A2, "A2");
        _logPos(A1, "A1 real position");
        _logPos(A2, "A2 real position");
        PM.Permission[5] memory p1 = _migrate(A1);
        PM.Permission[5] memory p2 = _migrate(A2);
        _checkMoved(A1, p1);
        _checkMoved(A2, p2);
        assertEq(g.membersLength(), 2, "not two members");
        assertEq(g.members(0), A1);
        assertEq(g.members(1), A2);
        // The registration moved no money.
        _logPos(A1, "A1 after moving over");
        _logPos(A2, "A2 after moving over");
        // The old grants stay live in JAW's manager: the app only revokes grants whose spender is the Guard
        // (hooks/useAgents.ts:236, 447-456).
        uint8 jobs1 = _oldJobs(A1);
        for (uint8 j; j < 5; ++j) {
            if (jobs1 & (1 << j) == 0) continue;
            PM.Permission memory old = OLD.permissionOf(A1, j);
            console2.log("A1's 0x686c grant still approved, not revoked: job", j, MANAGER.isApproved(old), !MANAGER.isRevoked(old));
        }
    }

    // ================================================================== 3. KeeperHub's rounds as configured

    function test_3_keeperhub_rounds_as_configured_never_revert() public {
        _migrate(A1);
        _migrate(A2);
        console2.log("isolated top-level calls (cold gas)", _isolated());
        OldPlan memory o1 = OLD.planOf(A1);
        OldPlan memory o2 = OLD.planOf(A2);
        console2.log("0x686c's plan now, A1: action, amount", o1.action, o1.amount);
        console2.log("0x686c's plan now, A2: action, amount", o2.action, o2.amount);
        _logPlan(A1, "A1");
        _logPlan(A2, "A2");

        // A stranger sending the Planner's own write moves nothing and logs nothing (only KeeperHub, the account, or
        // its helper may).
        (bool need, bytes memory data) = _khRead(_newTally());
        if (need) {
            Holdings memory h1 = _holdings(A1);
            Holdings memory h2 = _holdings(A2);
            vm.recordLogs();
            vm.prank(makeAddr("stranger"));
            g.performUpkeep(data);
            assertEq(vm.getRecordedLogs().length, 0, "a stranger's write logged something");
            _assertUnchanged(A1, h1);
            _assertUnchanged(A2, h2);
        }

        Tally memory t = _newTally();
        for (uint256 k; k < 6; ++k) {
            console2.log("--- round", k);
            _khRound(t, false);
            console2.log("  health A1, A2", _hf(A1), _hf(A2));
        }
        _logTally(t);
        assertEq(t.noGas, 0, "a move was refused for gas");
        _assertStillOn(A1);
        _assertStillOn(A2);
        _logPos(A1, "A1 after six rounds");
        _logPos(A2, "A2 after six rounds");
    }

    // ================================================================== 4. Protect on the real positions

    /// Both accounts just under their line at once; Protect brings each back to its target, within the overshoot.
    function test_4a_protect_brings_both_real_positions_back_to_target() public {
        _migrate(A1);
        _migrate(A2);
        _ensureCredit(A1, "A1");
        _ensureCredit(A2, "A2");
        _dropUnderLine();
        uint256 d1 = _debt(A1);
        uint256 d2 = _debt(A2);

        // Pause never stops Protect: the same round with the Guard paused still repays both.
        uint256 snap = vm.snapshotState();
        vm.prank(OWNER);
        g.pause();
        Tally memory tp = _newTally();
        _khRound(tp, true);
        console2.log("with the Guard paused: health A1, A2", _hf(A1), _hf(A2));
        assertGe(_hf(A1), LINE, "the owner's pause stopped Protect for A1");
        assertGe(_hf(A2), LINE, "the owner's pause stopped Protect for A2");
        vm.revertToState(snap);

        Tally memory t = _newTally();
        for (uint256 k; k < 6; ++k) {
            console2.log("--- round", k);
            _khRound(t, true);
            console2.log("  health A1, A2", _hf(A1), _hf(A2));
            if (_backAtTarget(A1) && _backAtTarget(A2) && _rescueAt(A1) == 0 && _rescueAt(A2) == 0) break;
        }
        _logTally(t);
        console2.log("A1 debt before, after", d1, _debt(A1));
        console2.log("A2 debt before, after", d2, _debt(A2));
        _assertAtTarget(A1, "A1");
        _assertAtTarget(A2, "A2");
        assertEq(t.noGas, 0, "a move was refused for gas");
        assertLe(t.maxWriteGas, KH_GAS, "a write took more than reaches the Guard");
        _assertStillOn(A1);
        _assertStillOn(A2);
    }

    /// A crash: every stock falls 2% a round for 12 rounds (about −21.5%), each pool following Aave's price (an
    /// arbitrageur before each read), then 3 calm rounds. The savings run out, so Protect has to sell real backing.
    function test_4b_a_crash_spends_the_savings_then_sells_real_backing() public {
        _migrate(A1);
        _migrate(A2);
        _ensureCredit(A1, "A1");
        _ensureCredit(A2, "A2");
        Tally memory t = _newTally();
        uint256 low1 = type(uint256).max;
        uint256 low2 = type(uint256).max;
        uint256 rescues;
        for (uint256 k; k < 15; ++k) {
            if (k < 12) _dropAll(200);
            uint256 h1 = _hf(A1);
            uint256 h2 = _hf(A2);
            console2.log("--- round, health A1, A2 after the fall", k, h1, h2);
            if (h1 < low1) low1 = h1;
            if (h2 < low2) low2 = h2;
            _khRound(t, true);
            console2.log("    health A1, A2 after the round", _hf(A1), _hf(A2));
            console2.log("    savings A1, A2", _bal(address(AUSDC), A1), _bal(address(AUSDC), A2));
            // Protect's rule: an account the fall put under its line is back at its target by the end of the round
            // (KeeperHub's two writes), never past it by more than 0.01. Between its line and its target it is left
            // alone, unless a rescue is on.
            if (h1 < LINE) {
                _assertAtTarget(A1, "A1, the round after it fell under its line");
                ++rescues;
            }
            if (h2 < LINE) {
                _assertAtTarget(A2, "A2, the round after it fell under its line");
                ++rescues;
            }
            assertEq(_rescueAt(A1), 0, "A1 left in a rescue");
            assertEq(_rescueAt(A2), 0, "A2 left in a rescue");
        }
        console2.log("rounds where an account fell under its line and was brought back", rescues);
        _logTally(t);
        console2.log("lowest health A1, A2 (after a fall, before Protect)", low1, low2);
        _logPos(A1, "A1 after the crash");
        _logPos(A2, "A2 after the crash");
        assertGe(low1, 1e18, "A1 fell under 1, where Aave itself liquidates");
        assertGe(low2, 1e18, "A2 fell under 1, where Aave itself liquidates");
        assertGt(rescues, 0, "the crash never put an account under its line");
        assertGt(t.sales, 0, "the crash never needed a sale of real backing");
        assertGe(_hf(A1), LINE, "A1 ends under its line");
        assertGe(_hf(A2), LINE, "A2 ends under its line");
        assertEq(t.noGas, 0, "a move was refused for gas");
        _assertStillOn(A1);
        _assertStillOn(A2);
    }

    // ================================================================== 5. both executors in the same window

    struct Window {
        bool oldNeed;
        bytes oldData;
        bool newNeed;
        bytes newData;
        uint256 snap;
        uint256[2] oldLive;
    }

    function test_5_both_executors_in_the_same_window_then_the_owner_pauses_0x686c() public {
        _migrate(A1);
        _migrate(A2);
        _ensureCredit(A1, "A1");
        _ensureCredit(A2, "A2");
        _dropUnderLine();

        // What each would do now: 0x686c (KeeperHub is still its forwarder) and the Guard.
        Window memory w;
        {
            OldPlan memory o1 = OLD.planOf(A1);
            OldPlan memory o2 = OLD.planOf(A2);
            console2.log("0x686c plans A1: action (2 = Repay, 4 = Sell), amount", o1.action, o1.amount);
            console2.log("0x686c plans A2: action, amount", o2.action, o2.amount);
        }
        (w.oldNeed, w.oldData) = OLD.checkUpkeep(abi.encode(uint256(0), uint256(1)));
        (w.newNeed, w.newData) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        console2.log("both reads want to act: 0x686c, Guard", w.oldNeed, w.newNeed);
        assertTrue(OLD.isForwarder(KEEPERHUB), "KeeperHub is no longer 0x686c's forwarder");
        w.oldLive[0] = _oldLiveBits(A1);
        w.oldLive[1] = _oldLiveBits(A2);
        console2.log("0x686c grants live before the swap (bits by job), A1, A2", w.oldLive[0], w.oldLive[1]);
        w.snap = vm.snapshotState();

        _oldThenGuard(w);
        vm.revertToState(w.snap);
        _guardThenOld(w);
        vm.revertToState(w.snap);
        _splitWorkflow(w);
        vm.revertToState(w.snap);
        _pauseOld(w);
    }

    /// (a) 0x686c writes first, then the Guard's write from the same (now stale) read.
    function _oldThenGuard(Window memory w) internal {
        console2.log("(a) 0x686c first, then the Guard");
        if (w.oldNeed) _oldWrite(w.oldData);
        console2.log("    after 0x686c: health A1, A2", _hf(A1), _hf(A2));
        Tally memory t = _newTally();
        if (w.newNeed) _khWrite(t, w.newData);
        console2.log("    after the Guard: health A1, A2", _hf(A1), _hf(A2));
        console2.log("    Guard moves that ran, refused", t.repays + t.sales + t.trades + t.saves, t.refused);
        _assertNotPast(A1, "(a) A1");
        _assertNotPast(A2, "(a) A2");
    }

    /// (b) The Guard first, then 0x686c's write from its own earlier read.
    function _guardThenOld(Window memory w) internal {
        console2.log("(b) the Guard first, then 0x686c");
        Tally memory t = _newTally();
        if (w.newNeed) _khWrite(t, w.newData);
        console2.log("    after the Guard: health A1, A2", _hf(A1), _hf(A2));
        uint256 g1 = _debt(A1);
        uint256 g2 = _debt(A2);
        if (w.oldNeed) _oldWrite(w.oldData);
        console2.log("    after 0x686c: health A1, A2", _hf(A1), _hf(A2));
        console2.log("    0x686c repaid on top of the Guard, A1, A2", g1 - _debt(A1), g2 - _debt(A2));
        _assertNotPast(A1, "(b) A1");
        _assertNotPast(A2, "(b) A2");
    }

    /// (c) A split workflow: the Planner's read sent to 0x686c's write, and 0x686c's read sent to the Guard's.
    function _splitWorkflow(Window memory w) internal {
        console2.log("(c) a split workflow");
        Holdings memory h1 = _holdings(A1);
        Holdings memory h2 = _holdings(A2);
        if (w.newNeed) {
            vm.prank(KEEPERHUB);
            (bool ok, bytes memory ret) =
                address(OLD).call{gas: KH_GAS}(abi.encodeCall(IOldExecutor.performUpkeep, (w.newData)));
            console2.log("    Planner data into 0x686c.performUpkeep: ok", ok);
            if (!ok) console2.logBytes(ret);
            _assertUnchanged(A1, h1);
            _assertUnchanged(A2, h2);
        }
        if (w.oldNeed) {
            vm.prank(KEEPERHUB);
            (bool ok, bytes memory ret) =
                address(g).call{gas: KH_GAS}(abi.encodeCall(GooseGuard.performUpkeep, (w.oldData)));
            console2.log("    0x686c data into Guard.performUpkeep: ok (false = the write reverts)", ok);
            if (!ok) console2.logBytes(ret);
            _assertUnchanged(A1, h1);
            _assertUnchanged(A2, h2);
        }
    }

    /// (d) The owner pauses 0x686c: its read finds nothing, its write refuses, the Guard keeps running.
    function _pauseOld(Window memory w) internal {
        console2.log("(d) the owner pauses 0x686c");
        vm.prank(OWNER);
        OLD.pause();
        assertTrue(OLD.paused());
        (bool pausedNeed,) = OLD.checkUpkeep(abi.encode(uint256(0), uint256(1)));
        assertFalse(pausedNeed, "a paused 0x686c still asks for a write");
        if (w.oldNeed) {
            vm.prank(KEEPERHUB);
            vm.expectRevert(RUNS_PAUSED);
            OLD.performUpkeep(w.oldData);
        }
        Tally memory t = _newTally();
        for (uint256 k; k < 4; ++k) {
            _khRound(t, true);
            console2.log("    Guard round after the pause: health A1, A2", _hf(A1), _hf(A2));
            if (_backAtTarget(A1) && _backAtTarget(A2) && _rescueAt(A1) == 0 && _rescueAt(A2) == 0) break;
        }
        _logTally(t);
        _assertAtTarget(A1, "(d) A1");
        _assertAtTarget(A2, "(d) A2");
        // The pause revokes nothing: each 0x686c grant that was live before it is still live after it, so only the
        // pause holds 0x686c back (the owner's unpause would bring it back).
        for (uint256 i; i < 2; ++i) {
            address a = i == 0 ? A1 : A2;
            uint8 jobs = _oldJobs(a);
            for (uint8 j; j < 5; ++j) {
                if (jobs & (1 << j) == 0) continue;
                PM.Permission memory old = OLD.permissionOf(a, j);
                bool live = MANAGER.isApproved(old) && !MANAGER.isRevoked(old);
                console2.log("    after the pause, 0x686c grant live: account, job, live", a, j, live);
                assertEq(live, w.oldLive[i] >> j & 1 == 1, "the pause changed an old grant");
            }
        }
    }

    /// A bit per job whose 0x686c grant is approved and not revoked in JAW's manager.
    function _oldLiveBits(address a) internal view returns (uint256 bits) {
        uint8 jobs = _oldJobs(a);
        for (uint8 j; j < 5; ++j) {
            if (jobs & (1 << j) == 0) continue;
            PM.Permission memory old = OLD.permissionOf(a, j);
            if (MANAGER.isApproved(old) && !MANAGER.isRevoked(old)) bits |= 1 << j;
        }
    }

    // ================================================================== 6. the app's view

    function test_6_the_views_the_app_reads_decode() public {
        _migrate(A1);
        _migrate(A2);
        _accountViews(A1);
        _accountViews(A2);
        _plannerViews();
    }

    function _accountViews(address a) internal view {
        (bool ok, bytes memory ret) = address(g).staticcall(abi.encodeCall(GooseGuard.accountOf, (a)));
        assertTrue(ok, "accountOf reverted");
        (AppAccount memory acc, AppSettings memory s) = abi.decode(ret, (AppAccount, AppSettings));
        console2.log("accountOf: index, jobs, mix", acc.index, acc.jobs, uint256(s.mix));
        console2.log("  topUpsOn, keep, keepMix", s.topUpsOn, uint256(s.keep), s.keepMix);
        assertEq(acc.jobs, _oldJobs(a), "the Guard's jobs differ from 0x686c's");
        (ok, ret) = address(g).staticcall(abi.encodeCall(GooseGuard.linesOf, (a)));
        assertTrue(ok, "linesOf reverted");
        (uint256 line, uint256 target) = abi.decode(ret, (uint256, uint256));
        assertEq(line, LINE);
        assertEq(target, TARGET);
        for (uint8 j; j < 5; ++j) {
            (ok, ret) = address(g).staticcall(abi.encodeCall(GooseGuard.permissionOf, (a, j)));
            assertTrue(ok, "permissionOf reverted");
            bytes memory held = abi.decode(ret, (bytes));
            if (acc.jobs & (1 << j) == 0) {
                assertEq(held.length, 0, "a job that's off holds a permission");
                continue;
            }
            PM.Permission memory p = abi.decode(held, (PM.Permission));
            assertEq(p.account, a);
            assertEq(p.spender, address(g));
            assertTrue(MANAGER.isApproved(p), "the held permission isn't approved");
        }
        (ok, ret) = address(planner).staticcall(abi.encodeCall(GoosePlanner.planOf, (a)));
        assertTrue(ok, "planOf reverted");
        AppPlan memory plan = abi.decode(ret, (AppPlan));
        console2.log("planOf: action, amount, hf", plan.action, plan.amount, plan.hf);
        (ok, ret) = address(planner).staticcall(abi.encodeCall(GoosePlanner.topUpsReady, (a)));
        assertTrue(ok, "topUpsReady reverted");
        console2.log("topUpsReady", abi.decode(ret, (uint256)));
        (ok, ret) = address(planner).staticcall(abi.encodeCall(GoosePlanner.rescuingOf, (a)));
        assertTrue(ok, "rescuingOf reverted");
        (ok, ret) = address(planner).staticcall(abi.encodeCall(GoosePlanner.nextTradeAt, (a)));
        assertTrue(ok, "nextTradeAt reverted");
        console2.log("nextTradeAt", abi.decode(ret, (uint256)));
        (ok, ret) = address(planner).staticcall(abi.encodeCall(GoosePlanner.movesOf, (a)));
        assertTrue(ok, "movesOf reverted");
        console2.log("movesOf: moves", abi.decode(ret, (GooseGuard.Move[])).length);
    }

    function _plannerViews() internal view {
        (bool ok, bytes memory ret) = address(planner).staticcall(abi.encodeCall(GoosePlanner.rebalanceLimits, ()));
        assertTrue(ok, "rebalanceLimits reverted");
        (uint16 band, uint16 bandMax, uint16 gap, uint16 floor_, uint64 minTrade, uint64 maxSlice) =
            abi.decode(ret, (uint16, uint16, uint16, uint16, uint64, uint64));
        console2.log("rebalanceLimits band, bandMax, gap", band, bandMax, gap);
        console2.log("  floor, minTrade, maxSlice", floor_, minTrade, maxSlice);
        (ok, ret) = address(planner).staticcall(abi.encodeCall(GoosePlanner.amounts, ()));
        assertTrue(ok, "amounts reverted");
        abi.decode(ret, (uint64, uint64, uint64, uint32, uint8));
        (ok, ret) = address(planner).staticcall(abi.encodeCall(GoosePlanner.thresholds, ()));
        assertTrue(ok, "thresholds reverted");
        abi.decode(ret, (uint64, uint64, uint64, uint64));
        (ok, ret) = address(planner).staticcall(abi.encodeCall(GoosePlanner.nextFreeze, (block.timestamp)));
        assertTrue(ok, "nextFreeze reverted");
        console2.log("nextFreeze", abi.decode(ret, (uint256)));
    }

    // ================================================================== moving over, as the app does

    /// The jobs `a` runs on 0x686c.
    function _oldJobs(address a) internal view returns (uint8 jobs) {
        (jobs,,,,,,,,,) = OLD.accounts(a);
    }

    /// One batch through the account, as the app's one-tap grant builds it (lib/agents/oneTapGrant.ts:161-180): each
    /// grant's manager.approve, then the Guard's settings, then one register(job, abi.encode(permission)) per grant.
    /// The same agents 0x686c runs for it; its mix and top-ups set again as the user would on the Rebalancer screen.
    function _migrate(address a) internal returns (PM.Permission[5] memory ps) {
        OldState memory o = _oldState(a);
        uint256 mixMask;
        for (uint256 r; r < 7; ++r) {
            if (o.mix >> (16 * r) & 0xffff > 0) mixMask |= 1 << r;
        }
        bool doMix = o.jobs & (1 << JOB_REBALANCE) != 0 && o.mix != 0;
        uint256 n = 2 * _bits(o.jobs) + (doMix ? 1 : 0) + (o.keepMix ? 1 : 0) + (o.topOn ? 1 : 0);
        PM.Call[] memory calls = new PM.Call[](n);
        uint256 k;
        for (uint8 j; j < 5; ++j) {
            if (o.jobs & (1 << j) == 0) continue;
            ps[j] = _appGrant(a, j, mixMask);
            calls[k++] = PM.Call(address(MANAGER), 0, abi.encodeCall(PM.approve, (ps[j])));
        }
        if (doMix) calls[k++] = PM.Call(address(g), 0, abi.encodeCall(GooseGuard.setMix, (uint112(o.mix))));
        if (o.keepMix) calls[k++] = PM.Call(address(g), 0, abi.encodeCall(GooseGuard.setKeepMix, (true)));
        if (o.topOn) calls[k++] = PM.Call(address(g), 0, abi.encodeCall(GooseGuard.setTopUps, (true, o.keep)));
        for (uint8 j; j < 5; ++j) {
            if (o.jobs & (1 << j) == 0) continue;
            calls[k++] = PM.Call(address(g), 0, abi.encodeCall(GooseGuard.register, (j, abi.encode(ps[j]))));
        }
        uint256 before = gasleft();
        vm.prank(ENTRY_POINT);
        IJustanAccount(a).executeBatch(calls);
        console2.log("moved over: account, calls in the batch, gas", a, calls.length, before - gasleft());
    }

    function _checkMoved(address a, PM.Permission[5] memory ps) internal view {
        OldState memory o = _oldState(a);
        (GooseGuard.Account memory acc, GooseGuard.Settings memory s) = g.accountOf(a);
        assertEq(acc.jobs, o.jobs, "the Guard runs other jobs than 0x686c");
        assertGt(acc.index, 0, "not a member");
        assertEq(acc.runner, address(0), "a helper runner was set");
        for (uint8 j; j < 5; ++j) {
            if (o.jobs & (1 << j) == 0) continue;
            assertEq(keccak256(g.permissionOf(a, j)), keccak256(abi.encode(ps[j])), "permissionOf isn't the grant");
            assertTrue(MANAGER.isApproved(ps[j]), "not approved in the manager");
        }
        if (o.jobs & (1 << JOB_REBALANCE) != 0) assertEq(uint256(s.mix), o.mix, "the mix didn't carry over");
        assertEq(s.keepMix, o.keepMix, "Keep my mix didn't carry over");
        assertEq(s.topUpsOn, o.topOn, "top-ups didn't carry over");
        if (o.topOn) assertEq(s.keep, o.keep, "Keep as cash didn't carry over");
        (uint256 line, uint256 target) = g.linesOf(a);
        assertEq(line, LINE);
        assertEq(target, TARGET);
    }
    /// The permission JAW's grant puts on-chain for the app's template of `job` (lib/agents/permissions.ts): checker 0,
    /// no limit (maxUint160), a year from a start 300 s behind the chain (lib/agents/picks.ts:15-46).
    function _appGrant(address a, uint8 job, uint256 mixMask) internal view returns (PM.Permission memory p) {
        uint48 start = uint48(vm.getBlockTimestamp()) - 300;
        p.account = a;
        p.spender = address(g);
        p.start = start;
        p.end = start + 365 days;
        p.salt = uint256(keccak256(abi.encode("rehearsal", a, job, vm.getBlockTimestamp())));
        if (job == JOB_SAVE) (p.calls, p.spends) = _appSave();
        else if (job == JOB_PROTECT) (p.calls, p.spends) = _appProtect();
        else if (job == JOB_SELL) (p.calls, p.spends) = _appSell(ALL_STOCKS);
        else if (job == JOB_REBALANCE) (p.calls, p.spends) = _appRebalance(mixMask);
        else (p.calls, p.spends) = _appEntry();
    }

    function _sl(address token, PM.PeriodUnit unit) internal pure returns (PM.SpendLimit memory) {
        return PM.SpendLimit(token, type(uint160).max, unit, 1);
    }

    function _appSave() internal pure returns (PM.CallPermission[] memory c, PM.SpendLimit[] memory s) {
        c = new PM.CallPermission[](2);
        c[0] = _cp(address(USDC), APPROVE);
        c[1] = _cp(address(POOL), V3_SUPPLY);
        s = new PM.SpendLimit[](1);
        s[0] = _sl(address(USDC), PM.PeriodUnit.Day);
    }

    function _appProtect() internal pure returns (PM.CallPermission[] memory c, PM.SpendLimit[] memory s) {
        c = new PM.CallPermission[](3);
        c[0] = _cp(address(POOL), V3_WITHDRAW);
        c[1] = _cp(address(USDC), APPROVE);
        c[2] = _cp(address(SPOKE), V4_REPAY);
        s = new PM.SpendLimit[](2);
        s[0] = _sl(address(USDC), PM.PeriodUnit.Day);
        s[1] = _sl(address(AUSDC), PM.PeriodUnit.Day);
    }

    /// permissions.ts sellCalls/sellSpends: withdraw, each stock's approve, swap, USDC approve, repay, refresh; spends
    /// USDC, aUSDC, each stock, a day each. The app grants all seven for a new account (app/agents/page.tsx:175).
    function _appSell(uint256 mask) internal view returns (PM.CallPermission[] memory c, PM.SpendLimit[] memory s) {
        uint256 k = _bits(mask);
        c = new PM.CallPermission[](5 + k);
        s = new PM.SpendLimit[](2 + k);
        c[0] = _cp(address(SPOKE), V4_WITHDRAW);
        s[0] = _sl(address(USDC), PM.PeriodUnit.Day);
        s[1] = _sl(address(AUSDC), PM.PeriodUnit.Day);
        uint256 n;
        for (uint256 r; r < 7; ++r) {
            if (mask >> r & 1 == 0) continue;
            c[1 + n] = _cp(STOCKS[r], APPROVE);
            s[2 + n] = _sl(STOCKS[r], PM.PeriodUnit.Day);
            ++n;
        }
        c[1 + k] = _cp(ROUTER, AERO_SWAP);
        c[2 + k] = _cp(address(USDC), APPROVE);
        c[3 + k] = _cp(address(SPOKE), V4_REPAY);
        c[4 + k] = _cp(address(SPOKE), V4_REFRESH);
    }

    /// permissions.ts rebalanceCalls/rebalanceSpends: each mix stock's approve, USDC approve, swap; spends USDC and each
    /// mix stock, a week each (lib/agents/mix.ts:167, components/gg/agents/RebalanceSettings.tsx:73).
    function _appRebalance(uint256 mask) internal view returns (PM.CallPermission[] memory c, PM.SpendLimit[] memory s) {
        uint256 k = _bits(mask);
        c = new PM.CallPermission[](2 + k);
        s = new PM.SpendLimit[](1 + k);
        s[0] = _sl(address(USDC), PM.PeriodUnit.Week);
        uint256 n;
        for (uint256 r; r < 7; ++r) {
            if (mask >> r & 1 == 0) continue;
            c[n] = _cp(STOCKS[r], APPROVE);
            s[1 + n] = _sl(STOCKS[r], PM.PeriodUnit.Week);
            ++n;
        }
        c[k] = _cp(address(USDC), APPROVE);
        c[k + 1] = _cp(ROUTER, AERO_SWAP);
    }

    function _appEntry() internal pure returns (PM.CallPermission[] memory c, PM.SpendLimit[] memory s) {
        address[5] memory coins = [USDT, USDE, USDS, DAI, EURC];
        c = new PM.CallPermission[](8);
        s = new PM.SpendLimit[](5);
        for (uint256 i; i < 5; ++i) {
            c[i] = _cp(coins[i], APPROVE);
            s[i] = _sl(coins[i], PM.PeriodUnit.Day);
        }
        c[5] = _cp(AERODROME_V1_ROUTER, AERO_SWAP);
        c[6] = _cp(UNISWAP_ROUTER, UNI_SWAP);
        c[7] = _cp(PSM3, PSM_SWAP);
    }

    // ================================================================== KeeperHub's round

    struct Tally {
        uint256 reads;
        uint256 writes;
        uint256 moves;
        uint256 refused;
        uint256 noGas;
        uint256 maxReadGas;
        uint256 maxWriteGas;
        uint256 maxBytes;
        uint256 repays;
        uint256 sales;
        uint256 trades;
        uint256 saves;
        uint256 ends;
    }

    function _newTally() internal pure returns (Tally memory t) {}

    /// KeeperHub's read step: checkUpkeep(abi.encode(0, 1)) on the Planner, as an eth_call. Must never revert.
    function _khRead(Tally memory t) internal view returns (bool need, bytes memory data) {
        bytes memory cd = abi.encodeCall(GoosePlanner.checkUpkeep, (abi.encode(uint256(0), uint256(1))));
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = address(planner).staticcall{gas: READ_CAP}(cd);
        uint256 used = before - gasleft();
        if (!ok) {
            console2.log("  THE READ REVERTED:");
            console2.logBytes(ret);
        }
        assertTrue(ok, "a KeeperHub read of GoosePlanner.checkUpkeep reverted");
        ++t.reads;
        if (used > t.maxReadGas) t.maxReadGas = used;
        (need, data) = abi.decode(ret, (bool, bytes));
        if (data.length > t.maxBytes) t.maxBytes = data.length;
        console2.log("  read: upkeepNeeded, gas, performData bytes", need, used, data.length);
    }

    /// KeeperHub's write step: performUpkeep(performData) on the Guard, from its wallet, with the gas that reaches the
    /// Guard out of its 5.5M limit (GuardForkBase.KH_GAS). Must never revert.
    function _khWrite(Tally memory t, bytes memory data) internal {
        GooseGuard.Move[] memory moves = abi.decode(data, (GooseGuard.Move[]));
        for (uint256 i; i < moves.length; ++i) {
            console2.log("  move: account, kind, args", moves[i].account, moves[i].kind, moves[i].args.length);
        }
        bytes memory cd = abi.encodeCall(GooseGuard.performUpkeep, (data));
        vm.recordLogs();
        vm.prank(KEEPERHUB);
        (bool ok, bytes memory ret) = address(g).call{gas: KH_GAS}(cd);
        uint256 used = _execGas(cd);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) {
            console2.log("  THE WRITE REVERTED:");
            console2.logBytes(ret);
        }
        assertTrue(ok, "a KeeperHub write of GooseGuard.performUpkeep reverted");
        assertLe(used + _intrinsic(cd), KH_TX_GAS, "the write needs more than KeeperHub's 5.5M");
        ++t.writes;
        t.moves += moves.length;
        if (used > t.maxWriteGas) t.maxWriteGas = used;
        console2.log("  write: moves, execution gas, intrinsic gas", moves.length, used, _intrinsic(cd));
        _tallyLogs(t, logs);
    }

    function _intrinsic(bytes memory cd) internal pure returns (uint256 gas) {
        gas = 21_000;
        for (uint256 i; i < cd.length; ++i) {
            gas += cd[i] == 0 ? 4 : 16;
        }
    }

    function _tallyLogs(Tally memory t, Vm.Log[] memory logs) internal view {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(g)) continue;
            bytes32 topic = logs[i].topics[0];
            address a = logs[i].topics.length > 1 ? address(uint160(uint256(logs[i].topics[1]))) : address(0);
            if (topic == REFUSED) {
                ++t.refused;
                bytes4 reason = abi.decode(logs[i].data, (bytes4));
                if (reason == GooseGuard.NoGas.selector || reason == bytes4(0)) ++t.noGas;
                console2.log("  REFUSED: account, kind", a, uint256(logs[i].topics[2]));
                console2.logBytes4(reason);
            } else if (topic == T_REPAID) {
                ++t.repays;
                (uint256 w, uint256 s, uint256 hb, uint256 ha) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                console2.log("  ProtectRepaid: account, from wallet, from savings", a, w, s);
                console2.log("    health before, after", hb, ha);
                (, uint256 target) = g.linesOf(a);
                assertLe(ha, target + OVER, "a repay overshot the target");
            } else if (topic == T_SOLD) {
                ++t.sales;
                (uint256[7] memory sh, uint256 repaid, uint256 hb, uint256 ha) =
                    abi.decode(logs[i].data, (uint256[7], uint256, uint256, uint256));
                console2.log("  ProtectSold: account, repaid", a, repaid);
                for (uint256 r; r < 7; ++r) {
                    if (sh[r] > 0) console2.log("    stock, shares", r, sh[r]);
                }
                console2.log("    health before, after", hb, ha);
                (, uint256 target) = g.linesOf(a);
                assertLe(ha, target + OVER, "a sale overshot the target");
            } else if (topic == T_REBALANCED || topic == T_TOPUP) {
                ++t.trades;
                if (topic == T_REBALANCED) console2.log("  Rebalanced: account", a);
                else console2.log("  TopUpInvested: account", a);
            } else if (topic == T_SAVED) {
                ++t.saves;
                console2.log("  Saved: account, amount", a, abi.decode(logs[i].data, (uint256)));
            } else if (topic == T_ENDED) {
                ++t.ends;
                console2.log("  RescueEnded: account", a);
            } else if (topic == T_REFRESHED) {
                console2.log("  ConfigRefreshed: account", a);
            } else if (topic == T_CONVERTED) {
                console2.log("  EntryConverted: account", a);
            }
        }
    }

    /// KeeperHub's 10-minute round: read, write if needed, read, write if needed. With `arb`, every pool is brought
    /// back to Aave's price before each read (as an arbitrageur would after a price move or Protect's own sales).
    function _khRound(Tally memory t, bool arb) internal {
        for (uint256 i; i < 2; ++i) {
            if (arb) _alignAll();
            (bool need, bytes memory data) = _khRead(t);
            if (need) _khWrite(t, data);
        }
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        vm.roll(block.number + 300);
    }

    function _logTally(Tally memory t) internal pure {
        console2.log("reads, writes, moves", t.reads, t.writes, t.moves);
        console2.log("refused, of them for gas", t.refused, t.noGas);
        console2.log("repays, sales, trades", t.repays, t.sales, t.trades);
        console2.log("saves, rescues ended", t.saves, t.ends);
        console2.log("most read gas, most write gas, most bytes", t.maxReadGas, t.maxWriteGas, t.maxBytes);
    }

    /// 0x686c's write as KeeperHub sends it (it is still a forwarder), logging what it did.
    function _oldWrite(bytes memory data) internal {
        vm.recordLogs();
        vm.prank(KEEPERHUB);
        (bool ok, bytes memory ret) = address(OLD).call{gas: KH_GAS}(abi.encodeCall(IOldExecutor.performUpkeep, (data)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        console2.log("    0x686c write ok", ok);
        if (!ok) console2.logBytes(ret);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(OLD)) continue;
            address a = address(uint160(uint256(logs[i].topics[1])));
            if (logs[i].topics[0] == T_OLD_REPAID) {
                (uint256 amount, uint256 hb, uint256 ha,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint8));
                console2.log("    0x686c ProtectRepaid: account, amount", a, amount);
                console2.log("      health before, after", hb, ha);
            } else if (logs[i].topics[0] == T_OLD_FAILED) {
                (bytes4 reason,) = abi.decode(logs[i].data, (bytes4, uint8));
                console2.log("    0x686c RunFailed: account", a);
                console2.logBytes4(reason);
            } else if (logs[i].topics[0] == T_SOLD) {
                console2.log("    0x686c ProtectSold: account", a);
            }
        }
    }

    // ================================================================== prices

    /// Aave's price for stock r becomes `price` (8 decimals): the oracle is mocked, so the Spoke, the Planner, the Guard
    /// and 0x686c all read it (as GooseKeeperHubRoundFork does).
    function _setPrice(uint256 r, uint256 price) internal {
        vm.mockCall(address(ORACLE), abi.encodeWithSignature("getReservePrice(uint256)", r), abi.encode(price));
        assertEq(_price(r), price, "the oracle didn't take the price");
    }

    /// Every stock falls `bps`, and its pool follows.
    function _dropAll(uint256 bps) internal {
        for (uint256 r; r < 7; ++r) {
            _setPrice(r, _price(r) * (1e4 - bps) / 1e4);
        }
        _alignAll();
    }

    /// Each pool back to Aave's price with a real swap, when it is more than 2 BPS away.
    function _alignAll() internal {
        for (uint256 r; r < 7; ++r) {
            int256 off = _offBps(r);
            if (off > -3 && off < 3) continue;
            _nudge(r, 0);
        }
    }

    /// Both accounts just under their line (DROP_TO): A1's stocks fall until A1 is there, then the stocks only A2 holds
    /// fall until A2 is there too (A2 holds every stock A1 holds). Each pool follows its price.
    function _dropUnderLine() internal {
        console2.log("health before the fall A1, A2", _hf(A1), _hf(A2));
        uint256 mask1 = _backingMask(A1);
        uint256 f1 = DROP_TO * 1e4 / _hf(A1); // BPS of today's price, health being linear in a uniform fall
        uint256[7] memory p0;
        for (uint256 r; r < 7; ++r) {
            p0[r] = _price(r);
            if (mask1 >> r & 1 == 1) _setPrice(r, p0[r] * f1 / 1e4);
        }
        uint256 h2 = _hf(A2);
        if (h2 > DROP_TO) {
            // The others' share of A2's health is linear in their price: two points give the fall that lands it.
            uint256 others = ALL_STOCKS & ~mask1 & _backingMask(A2);
            for (uint256 r; r < 7; ++r) {
                if (others >> r & 1 == 1) _setPrice(r, p0[r] * 9000 / 1e4);
            }
            uint256 h2b = _hf(A2);
            uint256 f2 = h2 > h2b ? 1e4 - (h2 - DROP_TO) * 1000 / (h2 - h2b) : 1e4;
            for (uint256 r; r < 7; ++r) {
                if (others >> r & 1 == 1) _setPrice(r, p0[r] * f2 / 1e4);
            }
            console2.log("fall of A1's stocks, of the others (BPS of today's price)", f1, f2);
        } else {
            console2.log("fall of A1's stocks (BPS of today's price)", f1);
        }
        _alignAll();
        console2.log("health after the fall A1, A2", _hf(A1), _hf(A2));
        assertLt(_hf(A1), LINE, "A1 isn't under its line");
        assertLt(_hf(A2), LINE, "A2 isn't under its line");
    }

    function _backingMask(address a) internal view returns (uint256 mask) {
        for (uint256 r; r < 7; ++r) {
            if (_supplied(r, a) > 0) mask |= 1 << r;
        }
    }

    /// An account with no credit gets a small one the fixtures' way (back with NVDAc, draw to 1.10), and says so.
    function _ensureCredit(address a, string memory name) internal {
        if (_debt(a) > 0) return;
        console2.log(name, "has no credit on the fork: given a small position (2 NVDAc, health 1.10)");
        _backWith(a, NVDA, 2e8);
        _drawTo(a, 1.1e18);
    }

    // ================================================================== checks and logs

    function _rescueAt(address a) internal view returns (uint32) {
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        return acc.rescueAt;
    }

    function _backAtTarget(address a) internal view returns (bool) {
        (, uint256 target) = g.linesOf(a);
        uint256 hf = _hf(a);
        return hf + DONE_GAP >= target && hf <= target + OVER;
    }

    /// Back at the target: no lower than the Guard's DONE_GAP under it, no higher than its OVERSHOOT past it.
    function _assertAtTarget(address a, string memory name) internal view {
        (uint256 line, uint256 target) = g.linesOf(a);
        uint256 hf = _hf(a);
        console2.log(name, "final health, rescueAt", hf, _rescueAt(a));
        assertGe(hf, line, string.concat(name, ": still under its line"));
        assertGe(hf + DONE_GAP, target, string.concat(name, ": not back at its target"));
        assertLe(hf, target + OVER, string.concat(name, ": past its target plus 0.01"));
    }

    function _assertNotPast(address a, string memory name) internal view {
        (, uint256 target) = g.linesOf(a);
        assertLe(_hf(a), target + OVER, string.concat(name, ": the two executors together overshot the target"));
    }

    /// Nothing switches itself off.
    function _assertStillOn(address a) internal view {
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        assertEq(acc.jobs, _oldJobs(a), "a job switched itself off");
    }

    function _isolated() internal returns (bool) {
        vm.prank(address(0xdead));
        g.endRescue();
        return vm.lastCallGas().gasTotalUsed >= 21_000;
    }

    struct OldState {
        uint8 jobs;
        uint8 fails;
        uint48 rescueAt;
        bool keepMix;
        bool topOn;
        uint48 keep;
        uint256 mix;
    }

    function _oldState(address a) internal view returns (OldState memory o) {
        (o.jobs,, o.fails,,,, o.rescueAt, o.keepMix,,) = OLD.accounts(a);
        (o.topOn,, o.keep,,,,) = OLD.topUps(a);
        o.mix = OLD.mixes(a);
    }

    function _logOld(address a, string memory name) internal view {
        OldState memory o = _oldState(a);
        console2.log(name, "on 0x686c");
        console2.log("  jobs (bits Save, Protect, Sell, Rebalance, Entry), fails, rescueAt", o.jobs, o.fails, o.rescueAt);
        console2.log("  keepMix, topUps on, keep", o.keepMix, o.topOn, o.keep);
        for (uint256 r; r < 7; ++r) {
            uint256 w = o.mix >> (16 * r) & 0xffff;
            if (w > 0) console2.log("  mix: stock, BPS", r, w);
        }
        for (uint8 j; j < 5; ++j) {
            if (o.jobs & (1 << j) == 0) continue;
            PM.Permission memory p = OLD.permissionOf(a, j);
            console2.log("  0x686c grant: job, start, end", j, p.start, p.end);
            console2.log("    calls, spends, approved", p.calls.length, p.spends.length, MANAGER.isApproved(p));
            console2.log("    revoked", MANAGER.isRevoked(p));
        }
        OldPlan memory plan = OLD.planOf(a);
        console2.log("  0x686c plan now: action, job, amount", plan.action, plan.job, plan.amount);
    }

    function _logPos(address a, string memory name) internal view {
        ISpokeData memory d = _data(a);
        console2.log(name);
        console2.log("  V4 debt (USDC units), health", _debt(a), d.healthFactor);
        console2.log("  V3 savings, wallet USDC", _bal(address(AUSDC), a), _bal(address(USDC), a));
        for (uint256 r; r < 7; ++r) {
            uint256 backing = _supplied(r, a);
            uint256 free_ = _bal(STOCKS[r], a);
            if (backing > 0 || free_ > 0) console2.log("  stock, backing, free", r, backing, free_);
        }
    }

    function _logPlan(address a, string memory name) internal view {
        GooseGuard.Move[] memory m = abi.decode(abi.encode(planner.movesOf(a)), (GooseGuard.Move[]));
        console2.log(name, "Guard plan now: moves", m.length);
        for (uint256 i; i < m.length; ++i) {
            console2.log("  kind, args", m[i].kind, m[i].args.length);
        }
    }

    function _data(address a) internal view returns (ISpokeData memory d) {
        (bool ok, bytes memory ret) = address(SPOKE).staticcall(abi.encodeWithSignature("getUserAccountData(address)", a));
        require(ok, "getUserAccountData");
        d = abi.decode(ret, (ISpokeData));
    }
}

/// ISpoke.UserAccountData (src/IProtocols.sol:23-31).
struct ISpokeData {
    uint256 riskPremium;
    uint256 avgCollateralFactor;
    uint256 healthFactor;
    uint256 totalCollateralValue;
    uint256 totalDebtValueRay;
    uint256 activeCollateralCount;
    uint256 borrowCount;
}
