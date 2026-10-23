// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../../src/GooseGuard.sol";
import {GoosePlanner} from "../../src/GoosePlanner.sol";
import {IGooseGuard} from "../../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../../src/planner/TradePlanner.sol";
import {CashPlanner} from "../../src/planner/CashPlanner.sol";
import {GuardForkBase} from "../GuardForkBase.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";

/// Audit PoCs: Protect starvation by accounts kept at the lowest health. Flipped: they now guard GG-01's fix (Protect
/// ranks candidates by what it can do for them, and plans only grants that are the app's NO_LIMIT template).
///   BASE_RPC_URL=https://mainnet.base.org forge test --match-contract PlannerStarvationForkTest -vv
contract PlannerStarvationForkTest is GuardForkBase {
    GoosePlanner planner;
    ProtectPlanner protect;

    function setUp() public {
        _setUpGuard();
        IGooseGuard ig = IGooseGuard(address(g));
        protect = new ProtectPlanner(ig);
        planner = new GoosePlanner(ig, protect, new TradePlanner(ig), new CashPlanner(ig));
    }

    function _victim(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        _backUsd(a, NVDA, 2_000e6);
        _drawTo(a, 1.02e18);
        deal(address(USDC), a, 300e6);
        _protectOn(a);
    }

    /// The paying attacker: $5,000 of NVDAc at health 1.005, $50 in the wallet, and a clean Protect grant (approved,
    /// no checker, every call listed) whose USDC limit is $1 per 10 minutes. Each round Protect repays exactly $1 of
    /// the attacker's own debt: never under MIN_REPAY, health barely moves.
    function _payer(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        _backUsd(a, NVDA, 5_000e6);
        _drawTo(a, 1.005e18);
        deal(address(USDC), a, 50e6);
        PM.Permission memory p = _protectP(a);
        p.spends[0] = PM.SpendLimit(address(USDC), 1e6, PM.PeriodUnit.Minute, 10);
        _on(a, JOB_PROTECT, p);
    }

    /// The free attacker: $10 of each of the seven stocks backing credit at health 1.005, no cash, Protect · sell on
    /// with a 1-unit limit on each stock. Its plan walks seven pools and finds nothing to sell: no move, no cost.
    function _burner(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        _backMask(a, ALL_STOCKS, 10e6);
        _drawTo(a, 1.005e18);
        deal(address(USDC), a, 0);
        PM.Permission memory p = _sellP(a, ALL_STOCKS);
        for (uint256 i = 1; i < p.spends.length; ++i) {
            p.spends[i].allowance = 1;
        }
        _on(a, JOB_SELL, p);
    }

    function _count(GooseGuard.Move[] memory moves, address[] memory who) internal pure returns (uint256 n) {
        for (uint256 i; i < moves.length; ++i) {
            for (uint256 j; j < who.length; ++j) {
                if (moves[i].account == who[j]) ++n;
            }
        }
    }

    function _read() internal view returns (GooseGuard.Move[] memory moves, bytes memory data) {
        bool need;
        (need, data) = planner.checkUpkeep{gas: 8_600_000}(abi.encode(uint256(0), uint256(1)));
        if (need) moves = abi.decode(data, (GooseGuard.Move[]));
    }

    /// Eight paying attackers took every Protect slot of both writes, three rounds running, and no victim was repaid.
    /// Guards GG-01 (paying attacker): their capped grants are never planned, and every victim is repaid.
    function test_paying_attacker_starves_protect() public {
        address[] memory victims = new address[](4);
        for (uint256 i; i < 4; ++i) {
            victims[i] = _victim(string.concat("victim", vm.toString(i)));
        }
        address[] memory atk = new address[](8);
        uint256 debtBefore;
        for (uint256 i; i < 8; ++i) {
            atk[i] = _payer(string.concat("payer", vm.toString(i)));
            debtBefore += _debt(atk[i]);
        }
        uint256 victimMoves;
        uint256 attackerMoves;
        for (uint256 round; round < 3; ++round) {
            for (uint256 w; w < 2; ++w) {
                (GooseGuard.Move[] memory moves, bytes memory data) = _read();
                console2.log("round, write, moves", round, w, moves.length);
                console2.log("  attacker moves, victim moves", _count(moves, atk), _count(moves, victims));
                victimMoves += _count(moves, victims);
                attackerMoves += _count(moves, atk);
                if (moves.length > 0) {
                    vm.recordLogs();
                    vm.prank(KEEPERHUB);
                    (bool ok, bytes memory ret) = address(g).call{gas: KH_GAS}(abi.encodeCall(GooseGuard.performUpkeep, (data)));
                    console2.log("  perform ok", ok);
                    if (!ok) console2.logBytes(ret);
                    Vm.Log[] memory lg = vm.getRecordedLogs();
                    console2.log("  logs", lg.length);
                    for (uint256 q; q < moves.length; ++q) console2.log("  kind, arg0", moves[q].kind, moves[q].args.length > 0 ? moves[q].args[0] : 0);
                }
            }
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
            vm.roll(block.number + 300);
        }
        uint256 debtAfter;
        for (uint256 i; i < 8; ++i) {
            debtAfter += _debt(atk[i]);
        }
        console2.log("attacker debt before, after 3 rounds (USDC units)", debtBefore, debtAfter);
        console2.log("attacker lowest/highest health after", _hf(atk[0]), _hf(atk[7]));
        for (uint256 i; i < 4; ++i) {
            console2.log("victim health", _hf(victims[i]));
        }
        assertGe(victimMoves, 4, "a victim wasn't repaid");
        assertEq(attackerMoves, 0, "an attacker's capped grant was planned");
        assertGe(debtAfter, debtBefore, "an attacker was repaid");
        for (uint256 i; i < 4; ++i) {
            assertGe(_hf(victims[i]), 1.03e18, "a victim still under its line");
        }
    }

    /// Cost of one burner's Protect plan, and how many burners kept every victim out of the read entirely. Guards GG-01
    /// (free attacker): a capped Sell grant ranks 0 and takes no candidate place, so with eleven burners every victim
    /// is still planned in every read, and no burner is.
    function test_free_attacker_burns_the_protect_planning_budget() public {
        address[] memory victims = new address[](4);
        for (uint256 i; i < 4; ++i) {
            victims[i] = _victim(string.concat("victim", vm.toString(i)));
        }
        (GooseGuard.Move[] memory base,) = _read();
        console2.log("no attacker: victim moves", _count(base, victims));
        address b0 = _burner("burner0");
        uint256 before = gasleft();
        ProtectPlanner.Move[] memory own = protect.planProtect(b0);
        console2.log("one burner's planProtect gas, its moves", before - gasleft(), own.length);
        for (uint256 q; q < own.length; ++q) {
            console2.log("  burner move kind, nargs", own[q].kind, own[q].args.length);
            for (uint256 z; z < own[q].args.length; ++z) console2.log("    leg reserve, shares", own[q].args[z] >> 248, uint128(own[q].args[z]));
            console2.log("  guard capOf", g.capOf(own[q].kind, own[q].args), "PACK_GAS", planner.PACK_GAS());
        }
        address[] memory burners = new address[](12);
        burners[0] = b0;
        uint256 k = 1;
        for (; k < 12; ++k) {
            (GooseGuard.Move[] memory moves,) = _read();
            uint256 v = _count(moves, victims);
            console2.log("burners, victim moves in the read", k, v);
            assertEq(v, 4, "a victim was left out of the read");
            assertEq(_count(moves, burners), 0, "a burner got a move");
            burners[k] = _burner(string.concat("burner", vm.toString(k)));
        }
        (GooseGuard.Move[] memory last,) = _read();
        assertEq(_count(last, victims), 4, "a victim is no longer planned");
        assertEq(_count(last, burners), 0, "a burner got a move");
    }
}
