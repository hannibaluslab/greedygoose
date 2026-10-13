// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GuardianChecker} from "../src/GuardianChecker.sol";
import {IJustaPermissionManager as PM, IAaveV3Pool, ISpokeLite, IERC20Lite} from "./IJustaPermissionManager.sol";

/// End-to-end on a Base mainnet fork, against the real JustaPermissionManager, Aave V3 Pool,
/// Aave V4 Equities Hub spoke and a real JAW account (which already has the manager as an owner).
/// Run: BASE_RPC_URL=<base rpc> forge test --match-contract Fork
contract GuardianForkTest is Test {
    PM constant MANAGER = PM(0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8);
    IAaveV3Pool constant POOL = IAaveV3Pool(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);
    ISpokeLite constant SPOKE = ISpokeLite(0x17905Db0e4A3514467539956c084180616AE7B8D);
    IERC20Lite constant USDC = IERC20Lite(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20Lite constant AUSDC = IERC20Lite(0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB);
    uint256 constant USDC_RESERVE = 7;

    // A real JAW smart account with ~$1 of NVDAc locked on the Equities Hub.
    address constant USER = 0x14087c532332dE6E971Eb2F60a252cbf511F59eA;
    address keeper = makeAddr("keeper");
    address attacker = makeAddr("attacker");

    GuardianChecker checker;
    uint48 t0;

    // JustaPermissionManager errors (selectors from the verified source).
    bytes4 constant CHECKER_REJECTED = bytes4(keccak256("JustaPermissionManager_CheckerRejectedCall(address,bytes4,address)"));
    bytes4 constant UNAUTHORIZED_CALL = bytes4(keccak256("JustaPermissionManager_UnauthorizedCall(address,bytes4)"));
    bytes4 constant EXCEEDED_SPEND = bytes4(keccak256("JustaPermissionManager_ExceededSpendLimit(uint256,uint256)"));
    bytes4 constant INVALID_SENDER = bytes4(keccak256("JustaPermissionManager_InvalidSender(address,address)"));
    bytes4 constant UNAUTHORIZED_PERMISSION = bytes4(keccak256("JustaPermissionManager_UnauthorizedPermission()"));

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        checker = new GuardianChecker(address(USDC), address(POOL), address(SPOKE), USDC_RESERVE);

        // Give the user a savings buffer and a small loan.
        // Mint test USDC on the fork (moving it out of Aave's hub would break the hub's own accounting).
        deal(address(USDC), USER, 20e6);
        vm.startPrank(USER);
        USDC.approve(address(POOL), 10e6);
        POOL.supply(address(USDC), 10e6, USER, 0);
        SPOKE.borrow(USDC_RESERVE, 0.5e6, USER);
        vm.stopPrank();

        t0 = uint48(block.timestamp);
        vm.prank(USER);
        MANAGER.approve(_p());
        assertTrue(MANAGER.isApproved(_p()));
    }

    function _guardianPermission(uint160 dailyCap) internal view returns (PM.Permission memory p) {
        p.account = USER;
        p.spender = keeper;
        p.start = t0;
        p.end = t0 + 365 days;
        p.salt = uint256(keccak256("greedygoose.guardian.v1"));
        p.calls = new PM.CallPermission[](3);
        p.calls[0] = PM.CallPermission(address(POOL), bytes4(0x69328dec), address(checker));
        p.calls[1] = PM.CallPermission(address(USDC), bytes4(0x095ea7b3), address(checker));
        p.calls[2] = PM.CallPermission(address(SPOKE), bytes4(0xb1e8f8ef), address(checker));
        p.spends = new PM.SpendLimit[](1);
        p.spends[0] = PM.SpendLimit(address(USDC), dailyCap, PM.PeriodUnit.Day, 1);
    }

    /// The approved Guardian permission (5 USDC / day cap). Rebuilt in memory; storage copies of struct arrays need via-IR.
    function _p() internal view returns (PM.Permission memory) {
        return _guardianPermission(5e6);
    }

    function _rescue(address withdrawTo, address repayFor, uint256 amount) internal pure returns (PM.Call[] memory c) {
        c = new PM.Call[](3);
        c[0] = PM.Call(address(POOL), 0, abi.encodeWithSelector(0x69328dec, address(USDC), amount, withdrawTo));
        c[1] = PM.Call(address(USDC), 0, abi.encodeWithSelector(0x095ea7b3, address(SPOKE), amount));
        c[2] = PM.Call(address(SPOKE), 0, abi.encodeWithSelector(0xb1e8f8ef, USDC_RESERVE, amount, repayFor));
    }

    function test_keeper_repays_from_savings() public {
        uint256 debtBefore = SPOKE.getUserTotalDebt(USDC_RESERVE, USER);
        uint256 savingsBefore = AUSDC.balanceOf(USER);
        assertGt(debtBefore, 0);

        uint256 amount = debtBefore + debtBefore / 1000 + 1; // small buffer: interest accrues per second
        vm.prank(keeper);
        MANAGER.executeBatch(_p(), _rescue(USER, USER, amount));

        assertEq(SPOKE.getUserTotalDebt(USDC_RESERVE, USER), 0, "debt repaid");
        assertApproxEqAbs(savingsBefore - AUSDC.balanceOf(USER), amount, 2, "savings used");
        assertEq(_allowance(USER, address(SPOKE)), 0, "approval reset by manager");
    }

    function test_rejects_withdraw_to_attacker() public {
        vm.prank(keeper);
        vm.expectPartialRevert(CHECKER_REJECTED);
        MANAGER.executeBatch(_p(), _rescue(attacker, USER, 0.5e6));
        assertEq(USDC.balanceOf(attacker), 0);
    }

    function test_rejects_repaying_someone_elses_loan() public {
        vm.prank(keeper);
        vm.expectPartialRevert(CHECKER_REJECTED);
        MANAGER.executeBatch(_p(), _rescue(USER, attacker, 0.5e6));
    }

    function test_rejects_plain_transfer() public {
        PM.Call[] memory c = new PM.Call[](1);
        c[0] = PM.Call(address(USDC), 0, abi.encodeWithSelector(0xa9059cbb, attacker, 1e6));
        vm.prank(keeper);
        vm.expectPartialRevert(UNAUTHORIZED_CALL);
        MANAGER.executeBatch(_p(), c);
    }

    function test_daily_cap_enforced() public {
        vm.prank(keeper);
        vm.expectPartialRevert(EXCEEDED_SPEND);
        MANAGER.executeBatch(_p(), _rescue(USER, USER, 6e6)); // cap is 5 USDC / day
    }

    function test_only_the_keeper_can_execute() public {
        vm.prank(attacker);
        vm.expectPartialRevert(INVALID_SENDER);
        MANAGER.executeBatch(_p(), _rescue(USER, USER, 0.5e6));
    }

    function test_revoked_permission_cannot_act() public {
        vm.prank(USER);
        MANAGER.revoke(_p());
        vm.prank(keeper);
        vm.expectRevert(UNAUTHORIZED_PERMISSION);
        MANAGER.executeBatch(_p(), _rescue(USER, USER, 0.5e6));
    }

    function _allowance(address owner, address spender) internal view returns (uint256 a) {
        (bool ok, bytes memory ret) = address(USDC).staticcall(abi.encodeWithSignature("allowance(address,address)", owner, spender));
        require(ok);
        a = abi.decode(ret, (uint256));
    }
}
