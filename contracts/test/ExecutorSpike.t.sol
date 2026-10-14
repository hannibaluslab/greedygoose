// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {ForkBase} from "./ForkBase.sol";
import {IJustaPermissionManager as PM, ISpokeLite, IERC20Lite} from "./IJustaPermissionManager.sol";

/// Spike for GooseExecutor (contracts/docs/GooseExecutor.md), test code only. The smallest contract that can be the
/// spender of a JAW permission: only the forwarder starts a run, and each account runs in its own sub-call with a gas
/// cap, so a failure rolls back that account alone. A permission granted through JAW's screen has no checker, so the
/// harness builds every call itself and pins it to the account.
contract SpenderHarness {
    bytes4 internal constant WITHDRAW = 0x69328dec; // Pool.withdraw(address,uint256,address)
    bytes4 internal constant APPROVE = 0x095ea7b3; // ERC20.approve(address,uint256)
    bytes4 internal constant REPAY = 0xb1e8f8ef; // Spoke.repay(uint256,uint256,address)

    /// Most gas the manager's batch may use for one account.
    uint256 public constant ACCOUNT_GAS = 1_000_000;

    PM public immutable MANAGER;
    address public immutable FORWARDER;
    address public immutable AAVE_V3_POOL;
    ISpokeLite public immutable SPOKE;
    address public immutable USDC;
    IERC20Lite public immutable AUSDC;
    uint256 public immutable USDC_RESERVE_ID;

    event Repaid(address indexed account, uint256 amount, uint256 debtAfter);
    event RunFailed(address indexed account, bytes4 reason);

    error NotForwarder();
    error OnlySelf();
    error NothingToRepay();
    error DebtNotLower();

    constructor(
        PM manager,
        address forwarder,
        address aaveV3Pool,
        ISpokeLite spoke,
        address usdc,
        IERC20Lite aUsdc,
        uint256 usdcReserveId
    ) {
        MANAGER = manager;
        FORWARDER = forwarder;
        AAVE_V3_POOL = aaveV3Pool;
        SPOKE = spoke;
        USDC = usdc;
        AUSDC = aUsdc;
        USDC_RESERVE_ID = usdcReserveId;
    }

    /// One run over several accounts, as performUpkeep will do. A failing account emits RunFailed; the rest go on.
    function run(PM.Permission[] calldata permissions) external {
        if (msg.sender != FORWARDER) revert NotForwarder();
        for (uint256 i; i < permissions.length; ++i) {
            try this.runOne(permissions[i]) {}
            catch (bytes memory reason) {
                emit RunFailed(permissions[i].account, bytes4(reason));
            }
        }
    }

    /// Re-reads the account, repays its loan from its own savings through the manager, then checks the debt fell.
    /// External only so `run` can roll it back on its own.
    function runOne(PM.Permission calldata permission) external {
        if (msg.sender != address(this)) revert OnlySelf();
        address account = permission.account;
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE_ID, account);
        if (debt == 0) revert NothingToRepay();
        uint256 amount = debt + debt / 1000 + 1; // interest accrues every second
        uint256 savings = AUSDC.balanceOf(account);
        if (amount > savings) amount = savings;
        if (amount == 0) revert NothingToRepay();

        PM.Call[] memory calls = new PM.Call[](3);
        calls[0] = PM.Call(AAVE_V3_POOL, 0, abi.encodeWithSelector(WITHDRAW, USDC, amount, account));
        calls[1] = PM.Call(USDC, 0, abi.encodeWithSelector(APPROVE, address(SPOKE), amount));
        calls[2] = PM.Call(address(SPOKE), 0, abi.encodeWithSelector(REPAY, USDC_RESERVE_ID, amount, account));
        MANAGER.executeBatch{gas: ACCOUNT_GAS}(permission, calls);

        uint256 debtAfter = SPOKE.getUserTotalDebt(USDC_RESERVE_ID, account);
        if (debtAfter >= debt) revert DebtNotLower();
        emit Repaid(account, amount, debtAfter);
    }
}

/// Not a JAW account. It answers the manager's executeBatch without running the calls, or, with `burn`, spends
/// all the gas it is given.
contract FakeAccount {
    bool internal immutable BURN;

    constructor(bool burn) {
        BURN = burn;
    }

    function executeBatch(PM.Call[] calldata) external view {
        while (BURN) {}
    }
}

/// Base fork: the harness is the spender of a real permission on the real manager, granted the way JAW's screen
/// grants it. Run: BASE_RPC_URL=<base rpc> forge test --match-contract ExecutorSpike -vv
contract ExecutorSpikeTest is ForkBase {
    SpenderHarness harness;
    address forwarder = makeAddr("forwarder");
    address attacker = makeAddr("attacker");
    address alice;
    uint48 t0;

    bytes4 constant INVALID_SENDER = bytes4(keccak256("JustaPermissionManager_InvalidSender(address,address)"));
    bytes4 constant UNAUTHORIZED_PERMISSION = bytes4(keccak256("JustaPermissionManager_UnauthorizedPermission()"));
    bytes4 constant EXCEEDED_SPEND = bytes4(keccak256("JustaPermissionManager_ExceededSpendLimit(uint256,uint256)"));

    function setUp() public {
        _fork();
        harness = new SpenderHarness(MANAGER, forwarder, address(POOL), SPOKE, address(USDC), AUSDC, USDC_RESERVE);
        t0 = uint48(block.timestamp);
        alice = _newJawAccount("alice");
        _withCredit(alice);
        _grantThroughAccount(_permission(alice, true));
    }

    function test_repays_from_savings_through_the_manager() public {
        PM.Permission memory p = _permission(alice, true);
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, alice);
        uint256 amount = debt + debt / 1000 + 1;
        uint256 savingsBefore = AUSDC.balanceOf(alice);
        uint256 cashBefore = USDC.balanceOf(alice);

        vm.expectEmit(true, false, false, true, address(harness));
        emit SpenderHarness.Repaid(alice, amount, 0);
        vm.prank(forwarder);
        uint256 gasBefore = gasleft();
        harness.run(_list(p));
        console.log("gas for one rescue run:", gasBefore - gasleft());

        assertEq(SPOKE.getUserTotalDebt(USDC_RESERVE, alice), 0, "debt repaid");
        assertApproxEqAbs(savingsBefore - AUSDC.balanceOf(alice), amount, 2, "savings used");
        assertGe(USDC.balanceOf(alice), cashBefore, "cash not lower");
        assertEq(USDC.allowance(alice, address(SPOKE)), 0, "approval reset by manager");
        assertEq(USDC.balanceOf(address(harness)), 0, "harness holds no USDC");
        assertEq(AUSDC.balanceOf(address(harness)), 0, "harness holds no savings");
        // The manager meters USDC by the approve amount and savings by the balance drop.
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[0]).spend, amount, "USDC metered");
        assertApproxEqAbs(MANAGER.getCurrentPeriod(p, p.spends[1]).spend, amount, 2, "savings metered");
    }

    /// The grant event carries the whole permission, but only its hash is a topic: a log trigger can't filter on
    /// the spender, so registration has to decode and check it.
    function test_grant_event_indexes_only_the_hash() public {
        address bob = _newJawAccount("bob");
        PM.Permission memory p = _permission(bob, true);
        vm.recordLogs();
        _grantThroughAccount(p);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(MANAGER));
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].topics[0], PM.PermissionApproved.selector);
        assertEq(logs[0].topics[1], MANAGER.getHash(p));
        PM.Permission memory logged = abi.decode(logs[0].data, (PM.Permission));
        assertEq(logged.spender, address(harness));
        assertEq(logged.salt, p.salt);
        assertEq(logged.calls[0].checker, address(0));
    }

    function test_only_the_forwarder_can_run() public {
        PM.Permission memory p = _permission(alice, true);

        vm.prank(attacker);
        vm.expectRevert(SpenderHarness.NotForwarder.selector);
        harness.run(_list(p));

        vm.prank(attacker);
        vm.expectRevert(SpenderHarness.OnlySelf.selector);
        harness.runOne(p);

        vm.prank(attacker);
        vm.expectPartialRevert(INVALID_SENDER);
        MANAGER.executeBatch(p, _withdrawTo(attacker, 1e6));

        assertGt(SPOKE.getUserTotalDebt(USDC_RESERVE, alice), 0, "nothing ran");
    }

    function test_one_failure_rolls_back_only_that_account() public {
        address bob = _newJawAccount("bob");
        _withCredit(bob);
        PM.Permission memory pBob = _permission(bob, true);
        _grantThroughAccount(pBob);
        vm.prank(bob);
        MANAGER.revoke(pBob); // Bob switches the agent off between the check and the run
        uint256 bobDebt = SPOKE.getUserTotalDebt(USDC_RESERVE, bob);
        uint256 bobSavings = AUSDC.balanceOf(bob);

        PM.Permission[] memory ps = new PM.Permission[](2);
        ps[0] = pBob;
        ps[1] = _permission(alice, true);
        vm.expectEmit(true, false, false, true, address(harness));
        emit SpenderHarness.RunFailed(bob, UNAUTHORIZED_PERMISSION);
        vm.expectEmit(true, false, false, false, address(harness));
        emit SpenderHarness.Repaid(alice, 0, 0);
        vm.prank(forwarder);
        harness.run(ps);

        assertEq(SPOKE.getUserTotalDebt(USDC_RESERVE, alice), 0, "alice repaid");
        assertEq(SPOKE.getUserTotalDebt(USDC_RESERVE, bob), bobDebt, "bob untouched");
        assertEq(AUSDC.balanceOf(bob), bobSavings, "bob's savings untouched");
    }

    /// The manager's batch succeeds for an account that ignores its calls; the post-check catches it and the whole
    /// account run, the manager's spend bookkeeping included, rolls back.
    function test_post_check_failure_rolls_back_the_managers_batch() public {
        FakeAccount fake = new FakeAccount(false);
        _withCredit(address(fake));
        PM.Permission memory pFake = _permission(address(fake), true);
        vm.prank(address(fake));
        MANAGER.approve(pFake);

        PM.Permission[] memory ps = new PM.Permission[](2);
        ps[0] = pFake;
        ps[1] = _permission(alice, true);
        vm.expectEmit(true, false, false, true, address(harness));
        emit SpenderHarness.RunFailed(address(fake), SpenderHarness.DebtNotLower.selector);
        vm.prank(forwarder);
        harness.run(ps);

        assertEq(SPOKE.getUserTotalDebt(USDC_RESERVE, alice), 0, "alice repaid");
        assertEq(MANAGER.getCurrentPeriod(pFake, pFake.spends[0]).spend, 0, "fake's spend rolled back");

        // Without the post-check the same batch goes through and uses up the fake account's daily limit.
        vm.prank(address(harness));
        MANAGER.executeBatch(pFake, _rescue(address(fake), 1e6));
        assertEq(MANAGER.getCurrentPeriod(pFake, pFake.spends[0]).spend, 1e6);
    }

    function test_gas_cap_contains_an_account_that_burns_gas() public {
        FakeAccount burner = new FakeAccount(true);
        _withCredit(address(burner));
        PM.Permission memory pBurner = _permission(address(burner), true);
        vm.prank(address(burner));
        MANAGER.approve(pBurner);

        PM.Permission[] memory ps = new PM.Permission[](2);
        ps[0] = pBurner;
        ps[1] = _permission(alice, true);
        vm.expectEmit(true, false, false, true, address(harness));
        emit SpenderHarness.RunFailed(address(burner), bytes4(0)); // out of gas: no revert data
        vm.prank(forwarder);
        harness.run{gas: 3_000_000}(ps);

        assertEq(SPOKE.getUserTotalDebt(USDC_RESERVE, alice), 0, "alice repaid after the burner");
    }

    /// JAW's screen always sets checker = 0 (rpc/permissions.js), so the manager pins no argument: the spender's own
    /// code is the only thing keeping savings with the account. A daily limit on the savings token still bounds a
    /// withdrawal to someone else; a USDC limit alone does not, because the account's USDC never moves.
    function test_only_a_savings_limit_bounds_a_withdrawal_to_someone_else() public {
        vm.prank(address(harness));
        MANAGER.executeBatch(_permission(alice, true), _withdrawTo(attacker, 1e6));
        assertEq(USDC.balanceOf(attacker), 1e6, "no argument pins");

        vm.prank(address(harness));
        vm.expectPartialRevert(EXCEEDED_SPEND);
        MANAGER.executeBatch(_permission(alice, true), _withdrawTo(attacker, 6e6));

        address bob = _newJawAccount("bob");
        _withCredit(bob);
        PM.Permission memory usdcOnly = _permission(bob, false);
        _grantThroughAccount(usdcOnly);
        vm.prank(address(harness));
        MANAGER.executeBatch(usdcOnly, _withdrawTo(attacker, 6e6));
        assertEq(USDC.balanceOf(attacker), 7e6, "a USDC limit alone lets savings out");
        assertEq(MANAGER.getCurrentPeriod(usdcOnly, usdcOnly.spends[0]).spend, 0, "and meters nothing");
    }

    /// $10 in savings and a $0.50 loan backed by 1 NVDAc.
    function _withCredit(address account) internal {
        deal(address(USDC), account, 10e6);
        _save(account, 10e6);
        _openCredit(account, 1e8, 0.5e6);
    }

    /// Protect · savings as JAW's screen grants it (core rpc/permissions.js apiPermissionsToPermission): every
    /// checker 0, start = now, a random salt. Daily limits: $5 of USDC and, with `savingsLimit`, $5 of savings.
    function _permission(address account, bool savingsLimit) internal view returns (PM.Permission memory p) {
        p.account = account;
        p.spender = address(harness);
        p.start = t0;
        p.end = t0 + 365 days;
        p.salt = uint256(keccak256(abi.encode("random salt from JAW's SDK", account)));
        p.calls = new PM.CallPermission[](3);
        p.calls[0] = PM.CallPermission(address(POOL), bytes4(0x69328dec), address(0));
        p.calls[1] = PM.CallPermission(address(USDC), bytes4(0x095ea7b3), address(0));
        p.calls[2] = PM.CallPermission(address(SPOKE), bytes4(0xb1e8f8ef), address(0));
        p.spends = new PM.SpendLimit[](savingsLimit ? 2 : 1);
        p.spends[0] = PM.SpendLimit(address(USDC), 5e6, PM.PeriodUnit.Day, 1);
        if (savingsLimit) p.spends[1] = PM.SpendLimit(address(AUSDC), 5e6, PM.PeriodUnit.Day, 1);
    }

    function _list(PM.Permission memory p) internal pure returns (PM.Permission[] memory ps) {
        ps = new PM.Permission[](1);
        ps[0] = p;
    }

    function _withdrawTo(address to, uint256 amount) internal pure returns (PM.Call[] memory c) {
        c = new PM.Call[](1);
        c[0] = PM.Call(address(POOL), 0, abi.encodeWithSelector(0x69328dec, address(USDC), amount, to));
    }

    function _rescue(address account, uint256 amount) internal pure returns (PM.Call[] memory c) {
        c = new PM.Call[](3);
        c[0] = PM.Call(address(POOL), 0, abi.encodeWithSelector(0x69328dec, address(USDC), amount, account));
        c[1] = PM.Call(address(USDC), 0, abi.encodeWithSelector(0x095ea7b3, address(SPOKE), amount));
        c[2] = PM.Call(address(SPOKE), 0, abi.encodeWithSelector(0xb1e8f8ef, USDC_RESERVE, amount, account));
    }
}
