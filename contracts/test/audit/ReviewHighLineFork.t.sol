// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {PlanBase} from "../../src/planner/PlanBase.sol";
import {PlannerForkBase} from "../PlannerForkBase.sol";
import {ISpoke} from "../IJustaPermissionManager.sol";

/// Adversarial review of the rankOf liveness fix (throwaway, proves findings; flip when fixed).
///   BASE_RPC_URL=http://127.0.0.1:8645 forge test -j 1 --match-path test/audit/ReviewHighLineFork.t.sol -vv
interface IV3BorrowR {
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256);
}

contract ReviewHighLineForkTest is PlannerForkBase {
    function _reborrowTo(address a, uint256 hf) internal {
        ISpoke.UserAccountData memory d = SPOKE.getUserAccountData(a);
        uint256 owed = d.totalCollateralValue * d.avgCollateralFactor / 1e18 * 1e18 / hf / 1e20;
        if (owed > SPOKE.getUserTotalDebt(7, a)) _drawMoreTo(a, hf);
    }

    /// R1: a high personal line (1.35 / 1.40) at health 1.30 (no liquidation risk) carries AT_RISK like a real user at
    /// 1.02, and its larger need outranks him. Eight such accounts, re-borrowing each round with their own repaid
    /// cash, take every Protect slot of both writes: the real users at 1.02 get nothing for three rounds.
    function test_R1_high_line_accounts_starve_real_users() public {
        address vCash = _newJawAccount("victim cash");
        _openCreditAt(vCash, 10e8, 1.02e18);
        deal(address(USDC), vCash, 400e6); // enough to repay to its target
        _protectOn(vCash);
        _sellOn(vCash);
        address vNoCash = _newJawAccount("victim no cash");
        _openCreditAt(vNoCash, 10e8, 1.02e18);
        deal(address(USDC), vNoCash, 1e6);
        _protectOn(vNoCash);
        _sellOn(vNoCash);

        address[] memory atk = new address[](8);
        for (uint256 i; i < 8; ++i) {
            atk[i] = _newJawAccount(string.concat("high line ", vm.toString(i)));
            _openCreditAt(atk[i], 100e8, 1.30e18); // the borrowed USDC stays in its wallet: its "cash"
            vm.prank(atk[i]);
            g.setProtect(13_500, 14_000);
            _protectOn(atk[i]);
        }
        (uint256 kA,) = protect.rankOf(atk[0], _hf(atk[0]));
        (uint256 kV,) = protect.rankOf(vCash, _hf(vCash));
        (uint256 kN,) = protect.rankOf(vNoCash, _hf(vNoCash));
        console2.log("rank attacker, victim cash, victim no cash");
        console2.log(kA - protect.AT_RISK(), kV - protect.AT_RISK(), kN - protect.AT_RISK());
        // Flipped (R1 high-line starvation): users under 1.03 carry the CRITICAL tier, so a high line at 1.30 can't outrank them.
        assertGt(kA, protect.AT_RISK(), "attacker at 1.30 carries AT_RISK");
        assertLt(kA, kV, "the real user at 1.02 outranks the attacker");
        assertLt(kA, kN, "the cashless real user at 1.02 outranks the attacker");

        RoundLog memory log;
        for (uint256 k; k < 3; ++k) {
            _round(log);
            for (uint256 i; i < 8; ++i) {
                _reborrowTo(atk[i], 1.30e18);
            }
        }
        console2.log("writes, moves, refused", log.writes, log.moves, log.refused);
        console2.log("victim healths after 3 rounds", _hf(vCash), _hf(vNoCash));
        // Flipped (R1): both real users are lifted to their line within 3 rounds (6 writes) despite the 8 high lines.
        assertGe(_hf(vCash), 1.03e18, "R1: victim with cash was not helped");
        assertGe(_hf(vNoCash), 1.03e18, "R1: cashless victim was not helped");
    }

    /// Control: the same victims with no high-line accounts are helped in the first round.
    function test_R1_control_victims_alone_are_helped() public {
        address vCash = _newJawAccount("victim cash");
        _openCreditAt(vCash, 10e8, 1.02e18);
        deal(address(USDC), vCash, 400e6);
        _protectOn(vCash);
        _sellOn(vCash);
        address vNoCash = _newJawAccount("victim no cash");
        _openCreditAt(vNoCash, 10e8, 1.02e18);
        deal(address(USDC), vNoCash, 1e6);
        _protectOn(vNoCash);
        _sellOn(vNoCash);
        RoundLog memory log;
        _round(log);
        assertGe(_hf(vCash), 1.03e18);
        assertGe(_hf(vNoCash), 1.03e18);
    }

    function _at107(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        _openCreditAt(a, 10e8, 1.07e18);
        deal(address(USDC), a, 1e6); // the keep-back only, no savings
        _protectOn(a);
        _sellOn(a);
    }

    /// R2 (GG-19): a stranger's 1-unit aUSDC transfer (aTokens are transferable) or 1-unit USDC gift turns the raised
    /// sale line off for a cashless account: the Guard's test is "any savings / any cash above the keep-back", so the
    /// account is sold only from 1.03 again, though Protect still can't repay it (a dust repay is under MIN_REPAY).
    function test_R2_dust_turns_gg19_off() public {
        address a = _at107("cashless");
        address b = _at107("cashless 2");
        assertEq(g.sellLineOf(a), 1.08e18);
        assertEq(protect.planProtect(a).length, 1, "a sale is planned at 1.07");

        address griefer = makeAddr("griefer");
        deal(address(USDC), griefer, 10e6);
        vm.startPrank(griefer);
        USDC.approve(address(POOL), 10e6);
        POOL.supply(address(USDC), 5e6, griefer, 0);
        AUSDC.transfer(a, 2); // two units of aUSDC
        USDC.transfer(b, 1); // one unit of USDC
        vm.stopPrank();
        console2.log("aUSDC of a, USDC of b", AUSDC.balanceOf(a), USDC.balanceOf(b));

        // Flipped (R2 dust): cash counts only from $1, so dust leaves the 1.08 sale line and the sale on.
        assertEq(g.sellLineOf(a), 1.08e18, "aUSDC dust: sale line stays 1.08");
        assertEq(g.sellLineOf(b), 1.08e18, "USDC dust: sale line stays 1.08");
        assertEq(protect.planProtect(a).length, 1, "a sale is still planned for a at 1.07");
        assertEq(protect.planProtect(b).length, 1, "a sale is still planned for b at 1.07");
        (uint8 need,) = planner.protectCheck(a, 0);
        assertGt(need, 0);
    }

    /// R4 (GG-19): savings that back an Aave V3 borrow are cash to the Guard's sellLineOf (raw aUSDC balance) but not
    /// to Protect (savingsOut, the V3 room), so a real user with no usable cash at 1.07 gets no move at all: no sale
    /// (sale line 1.03), no repay (above its line). GG-19 says such an account is sold from 1.08.
    function test_R4_v3_pledged_savings_turn_gg19_off() public {
        address a = _newJawAccount("pledged");
        _openCreditAt(a, 10e8, 1.07e18);
        deal(address(USDC), a, 30e6);
        _save(a, 30e6);
        (,, uint256 avail,,,) = IV3BorrowR(address(POOL)).getUserAccountData(a);
        vm.prank(a);
        IV3BorrowR(address(POOL)).borrow(address(USDC), avail / 100 * 999 / 1000, 2, 0, a);
        uint256 bal = USDC.balanceOf(a);
        vm.prank(a);
        USDC.transfer(address(0xdead), bal - 1e6); // the keep-back stays
        _protectOn(a);
        _sellOn(a);
        console2.log("aUSDC, savingsOut", AUSDC.balanceOf(a), protect.savingsOut(a));
        assertLt(protect.savingsOut(a), protect.MIN_REPAY(), "Protect can't repay from these savings");
        assertEq(g.sellLineOf(a), 1.03e18, "the Guard still counts them as cash");
        assertEq(protect.planProtect(a).length, 0, "no move at 1.07");
    }
}
