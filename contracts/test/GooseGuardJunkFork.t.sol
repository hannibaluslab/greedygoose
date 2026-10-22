// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GoosePlanner} from "../src/GoosePlanner.sol";
import {IGooseGuard} from "../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../src/planner/TradePlanner.sol";
import {CashPlanner} from "../src/planner/CashPlanner.sol";
import {GuardForkBase} from "./GuardForkBase.sol";
import {IJustaPermissionManager as PM} from "./IJustaPermissionManager.sol";

/// The adversarial review's high finding, fixed: junk accounts kept at the lowest health took every write's Protect
/// slots (their repays were refused at the manager, or moved 1 unit), so no real account was protected. Now the Guard
/// registers only an approved grant, and the Planner plans only for a grant the manager would run (no checker, the
/// job's calls listed, spend left) and never a dust repay. Keyless RPC only, pinned block (GuardForkBase):
///   BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardJunkForkTest -vv
contract GooseGuardJunkForkTest is GuardForkBase {
    GoosePlanner planner;

    function setUp() public {
        _setUpGuard();
        IGooseGuard ig = IGooseGuard(address(g));
        planner = new GoosePlanner(ig, new ProtectPlanner(ig), new TradePlanner(ig), new CashPlanner(ig));
    }

    /// A real user after a drop: $2,000 of NVDAc backing credit at health 1.02, under the 1.03 line, $300 of wallet
    /// cash for Protect, and Protect on as the app grants it.
    function _victim(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        _backUsd(a, NVDA, 2_000e6);
        _drawTo(a, 1.02e18);
        deal(address(USDC), a, 300e6);
        _protectOn(a);
    }

    /// The attacker's account: $20 of NVDAc at health 1.005, under the line and lower than every victim.
    function _junk(string memory name, uint256 wallet) internal returns (address a) {
        a = _newJawAccount(name);
        _backUsd(a, NVDA, 20e6);
        _drawTo(a, 1.005e18);
        deal(address(USDC), a, wallet);
    }

    function _has(GooseGuard.Move[] memory moves, address a) internal pure returns (bool) {
        for (uint256 i; i < moves.length; ++i) {
            if (moves[i].account == a) return true;
        }
        return false;
    }

    /// A grant nobody approved in the manager doesn't register.
    function test_an_unapproved_grant_does_not_register() public {
        address a = _junk("unsigned", 50e6);
        PM.Permission memory p = _protectP(a);
        vm.expectRevert(GooseGuard.NotApproved.selector);
        vm.prank(a);
        g.register(JOB_PROTECT, abi.encode(p));
    }

    /// Eight junk accounts at the lowest health, two of each kind the manager would refuse or that can't lift health:
    /// a checker on a call, the repay call missing, a 1-unit USDC limit, and a clean grant with $1.000001 in the wallet
    /// (a 1-unit repay). KeeperHub's first write repays all four victims and sends no junk move.
    function test_junk_accounts_at_the_lowest_health_take_no_write_from_protect() public {
        address[] memory victims = new address[](4);
        for (uint256 i; i < 4; ++i) {
            victims[i] = _victim(string.concat("victim", vm.toString(i)));
        }
        address[] memory junk = new address[](8);
        for (uint256 i; i < 8; ++i) {
            uint256 kind = i / 2;
            address a = _junk(string.concat("junk", vm.toString(i)), kind == 3 ? 1e6 + 1 : 50e6);
            PM.Permission memory p = _protectP(a);
            if (kind == 0) p.calls[2].checker = address(USDC); // any contract: the manager asks it, it can't answer
            if (kind == 1) p.calls[2] = _cp(address(SPOKE), V4_WITHDRAW); // no repay
            if (kind == 2) p.spends[0].allowance = 1; // 1 USDC unit a day
            _on(a, JOB_PROTECT, p);
            junk[i] = a;
        }

        (bool need, bytes memory data) = planner.checkUpkeep{gas: 50_000_000}(abi.encode(uint256(0), uint256(1)));
        assertTrue(need, "the victims need Protect");
        GooseGuard.Move[] memory moves = abi.decode(data, (GooseGuard.Move[]));
        for (uint256 i; i < 8; ++i) {
            assertFalse(_has(moves, junk[i]), "a junk account's move is planned");
        }
        (uint256 gas, Vm.Log[] memory logs) = _perform(data);
        console2.log("moves, KeeperHub's gas", moves.length, gas);
        assertEq(_reasons(logs).length, 0, "a move was refused");
        for (uint256 i; i < 4; ++i) {
            assertTrue(_has(moves, victims[i]), "a victim's repay is missing");
            assertGe(_hf(victims[i]), 1.03e18, "a victim is still under the line");
        }
    }

    /// A small account whose whole need is under $1 is still repaid: the $1 minimum is only for a repay that falls
    /// short of the need.
    function test_a_repay_under_a_dollar_that_covers_the_need_is_planned() public {
        address a = _newJawAccount("small");
        _backUsd(a, NVDA, 5e6);
        _drawTo(a, 1.02e18);
        deal(address(USDC), a, 10e6);
        _protectOn(a);
        GoosePlanner.Move[] memory moves = planner.movesOf(a);
        assertEq(moves.length, 1, "no repay planned");
        assertEq(moves[0].kind, REPAY);
        assertLt(moves[0].args[0] + moves[0].args[1], 1e6, "the need is under $1");
        (, Vm.Log[] memory logs) = _perform(abi.encode(moves));
        assertEq(_reasons(logs).length, 0, "refused");
        assertGe(_hf(a), 1.03e18, "back over the line");
    }
}
