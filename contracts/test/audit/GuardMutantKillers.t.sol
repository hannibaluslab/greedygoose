// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseGuard} from "../../src/GooseGuard.sol";
import {IJustaPermissionManager as PM} from "../../src/IJustaPermissionManager.sol";
import {IAaveV3Pool, IERC20, ISpoke} from "../../src/IProtocols.sol";
import {GooseGuardTest, ManagerDouble} from "../GooseGuard.t.sol";

/// Offline tests that kill the GooseGuard mutants the existing offline suite lets through. Each test names the
/// mutant ids (r2 guard mutation run) it kills. They reuse GooseGuardTest's mocks and helpers.
contract GuardMutantKillers is GooseGuardTest {
    function _readingWith(uint256 hf, uint256 tcv) internal pure returns (ISpoke.UserAccountData memory d) {
        d.healthFactor = hf;
        d.avgCollateralFactor = 0.7e18;
        d.totalCollateralValue = tcv;
    }

    function _repayOutcome(uint256 w, uint256 s) internal returns (bytes4) {
        return _perform(KEEPERHUB, _repay(account, w, s))[0];
    }

    // ---------------------------------------------------------------- Protect's post-checks (M02, M03, M04, M05)

    function test_k_a_repay_that_lowers_health_is_refused() public {
        _register(account, JOB_PROTECT, _now() - 60);
        _mockCash(account, 11e6, 0);
        _mockAave(account, [uint256(100e6), 90e6], [uint256(1e18), 0.99e18]);
        assertEq(_repayOutcome(10e6, 0), GooseGuard.HealthLower.selector, "M02");
    }

    function test_k_a_repay_past_target_plus_0_01_is_refused_and_at_it_runs() public {
        _register(account, JOB_PROTECT, _now() - 60);
        _mockCash(account, 11e6, 0);
        _mockAave(account, [uint256(100e6), 90e6], [uint256(1e18), 1.130001e18]);
        assertEq(_repayOutcome(10e6, 0), GooseGuard.Overshoot.selector, "M03");
        _mockAave(account, [uint256(100e6), 90e6], [uint256(1e18), 1.13e18]);
        assertEq(_repayOutcome(10e6, 0), REPAID, "the edge itself");
    }

    function test_k_a_full_payoff_is_refused_unless_whats_left_is_dust() public {
        _register(account, JOB_PROTECT, _now() - 60);
        _mockCash(account, 11e6, 0);
        // $1,000 at a 0.70 factor: paying everything off is refused.
        _mockAave(account, [uint256(10e6), 0], [uint256(1e18), 1e18]);
        assertEq(_repayOutcome(10e6, 0), GooseGuard.PaidOff.selector, "M04 M05");
        // $1 at a 0.70 factor: what's left at the target is dust, so the payoff runs.
        vm.mockCall(SPOKE, abi.encodeCall(ISpoke.getUserAccountData, (account)), abi.encode(_readingWith(1e18, 1e26)));
        vm.mockCalls(SPOKE, abi.encodeCall(ISpoke.getUserTotalDebt, (7, account)), _two(10e6, 0));
        assertEq(_repayOutcome(10e6, 0), REPAID, "dust payoff");
    }

    // ---------------------------------------------------------------- Protect's gate and rescue (M06, M08..M11)

    function test_k_protect_does_nothing_above_the_line_without_a_rescue() public {
        _register(account, JOB_PROTECT, _now() - 60);
        _mockCash(account, 11e6, 0);
        _mockAave(account, [uint256(100e6), 90e6], [uint256(1.05e18), 1.08e18]);
        assertEq(_repayOutcome(10e6, 0), GooseGuard.NotNeeded.selector, "M08 M09");
        assertEq(ManagerDouble(MANAGER).lastHash(), bytes32(0));
    }

    function test_k_a_rescue_older_than_7_days_no_longer_lifts_the_gate() public {
        _register(account, JOB_PROTECT, _now() - 60);
        _mockCash(account, 11e6, 0);
        _startRescue(account, _now());
        vm.warp(_now() + 7 days + 1);
        _mockAave(account, [uint256(100e6), 90e6], [uint256(1.05e18), 1.08e18]);
        assertEq(_repayOutcome(10e6, 0), GooseGuard.NotNeeded.selector, "M10");
    }

    function test_k_a_rescue_keeps_its_start_while_it_goes_on() public {
        _register(account, JOB_PROTECT, _now() - 60);
        _mockCash(account, 11e6, 0);
        uint256 t0 = _now();
        _startRescue(account, t0);
        vm.warp(t0 + 1 days);
        _mockAave(account, [uint256(100e6), 90e6], [uint256(1.05e18), 1.08e18]);
        assertEq(_repayOutcome(10e6, 0), REPAID);
        uint32 rescueAt = _acct(account).rescueAt;
        assertEq(rescueAt, t0, "M06: a rescue that goes on keeps its 7-day clock");
    }

    function test_k_nothing_owed_is_refused_before_anything_else() public {
        _register(account, JOB_PROTECT, _now() - 60);
        _mockCash(account, 11e6, 0);
        _mockAave(account, 0, 1e18);
        assertEq(_repayOutcome(10e6, 0), GooseGuard.NothingOwed.selector, "M11");
    }

    // ---------------------------------------------------------------- REPAY's amounts (M21, M22, M23, M114)

    function test_k_savings_are_capped_by_the_balance() public {
        PM.Permission memory p = _register(account, JOB_PROTECT, _now() - 60);
        _mockCash(account, 1e6, 5e6); // the wallet is at the keep-back
        _mockAave(account, [uint256(100e6), 95e6], [uint256(1e18), 1.02e18]);
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.ProtectRepaid(account, 0, 5e6, 1e18, 1.02e18);
        vm.prank(KEEPERHUB);
        g.performUpkeep(abi.encode(_repay(account, 0, 50e6)));
        PM.Call[] memory c = new PM.Call[](3);
        c[0] = PM.Call(V3_POOL, 0, abi.encodeCall(IAaveV3Pool.withdraw, (USDC, 5e6, account)));
        c[1] = PM.Call(USDC, 0, abi.encodeCall(IERC20.approve, (SPOKE, 5e6)));
        c[2] = PM.Call(SPOKE, 0, abi.encodeCall(ISpoke.repay, (7, 5e6, account)));
        assertEq(ManagerDouble(MANAGER).lastHash(), keccak256(abi.encodeCall(PM.executeBatch, (p, c))), "M118");
    }

    function test_k_past_the_debt_the_wallet_pays_and_savings_are_cut() public {
        _register(account, JOB_PROTECT, _now() - 60);
        _mockCash(account, 21e6, 30e6);
        _mockAave(account, [uint256(10e6), 1e6], [uint256(1e18), 1.1e18]);
        vm.expectEmit(true, false, false, true, address(g));
        emit GooseGuard.ProtectRepaid(account, 10e6, 0, 1e18, 1.1e18);
        vm.prank(KEEPERHUB);
        g.performUpkeep(abi.encode(_repay(account, 50e6, 30e6)));
    }

    // ---------------------------------------------------------------- SELL's batch and post-check (M12, M13, M19)

    function _sellSetup() internal returns (PM.Permission memory p) {
        p = _register(account, JOB_SELL, _now() - 60);
        _mockAave(account, [uint256(100e6), 3e6], [uint256(1e18), 1.05e18]);
        _mockStock(account, 5, 0);
        vm.mockCall(SPOKE, abi.encodeCall(ISpoke.getUserReserveStatus, (5, account)), abi.encode(true, true));
    }

    function test_k_a_sale_hands_the_manager_exactly_its_floor_and_legs() public {
        PM.Permission memory p = _sellSetup();
        assertEq(_sellOutcome(_one(_sale(5, 1e8))), bytes4(keccak256("ProtectSold(address,uint256[7],uint256,uint256,uint256)")));
        uint256 minOut = 97e6; // 1 share at $100, less the 3% sale floor
        PM.Call[] memory c = new PM.Call[](5);
        c[0] = PM.Call(USDC, 0, abi.encodeCall(IERC20.approve, (SPOKE, minOut)));
        c[1] = PM.Call(_stock(5), 0, abi.encodeCall(IERC20.approve, (ROUTER, 1e8)));
        c[2] = PM.Call(SPOKE, 0, abi.encodeCall(ISpoke.withdraw, (5, 1e8, account)));
        c[3] = _aeroSwap(ROUTER, 10, _stock(5), USDC, 1e8, minOut);
        c[4] = PM.Call(SPOKE, 0, abi.encodeCall(ISpoke.repay, (7, minOut, account)));
        assertEq(ManagerDouble(MANAGER).lastHash(), keccak256(abi.encodeCall(PM.executeBatch, (p, c))), "M13");
    }

    function test_k_a_sale_that_takes_free_stock_from_the_wallet_is_refused() public {
        _sellSetup();
        vm.mockCalls(_stock(5), abi.encodeCall(IERC20.balanceOf, (account)), _two(0, 1));
        assertEq(_sellOutcome(_one(_sale(5, 1e8))), GooseGuard.StockMoved.selector, "M12");
    }

    function test_k_seventeen_clean_legs_are_refused() public {
        _mockAave(account, 100e6, 1e18);
        _mockStock(account, 5, 0);
        vm.mockCall(SPOKE, abi.encodeCall(ISpoke.getUserReserveStatus, (5, account)), abi.encode(true, true));
        uint256[] memory legs = new uint256[](17);
        for (uint256 i; i < 17; ++i) {
            legs[i] = _sale(5, 1e8);
        }
        assertEq(_perform(KEEPERHUB, _args(account, SELL, legs), 20_000_000)[0], GooseGuard.BadArgs.selector, "M19");
    }

    // ---------------------------------------------------------------- the gas gate's margin (M80, M81)

    /// Exactly the cap and the loop's share, with no 64/63, is short: the gate must still refuse it.
    function test_k_the_gas_gate_keeps_its_64_63_and_the_loops_share() public {
        uint256 need = g.capOf(REPAY, new uint256[](0)) * 64 / 63 + 60_000;
        assertEq(_perform(KEEPERHUB, _moves(account, REPAY, 0), need)[0], GooseGuard.NoGas.selector, "M80 M81");
    }

    // ---------------------------------------------------------------- the manager's answer (M74)

    /// An answer that isn't exactly one word is no answer: registration is refused.
    function test_k_a_manager_answer_longer_than_one_word_is_not_approval() public {
        PM.Permission memory p = _permission(address(g), account, _now() - 60, 3, 2, 7);
        vm.mockCall(MANAGER, abi.encodePacked(PM.isApproved.selector), abi.encode(true, true));
        vm.expectRevert(GooseGuard.NotApproved.selector);
        vm.prank(account);
        g.register(JOB_PROTECT, abi.encode(p));
    }

    function _two(uint256 x, uint256 y) internal pure returns (bytes[] memory b) {
        b = new bytes[](2);
        b[0] = abi.encode(x);
        b[1] = abi.encode(y);
    }
}
