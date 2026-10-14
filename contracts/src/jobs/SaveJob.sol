// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IAaveV3Pool, IERC20} from "../IProtocols.sol";
import {Amounts, CashRules, SaveCase} from "../CashRules.sol";
import {NyCalendar} from "../NyCalendar.sol";
import {JobBase} from "./JobBase.sol";

/// @title SaveJob
/// @notice Save (GooseExecutor.md §5.3): wallet USDC above the keep-back goes into the account's Aave V3 savings,
///         within today's limit and the daily number of saves.
/// @dev A linked library: its code runs as GooseExecutor, the spender, exactly as if it were inlined there.
library SaveJob {
    /// The template the user approved: approve USDC, supply it to savings.
    function permission(
        GooseExecutor.Env memory e,
        address account,
        GooseExecutor.Grant memory g,
        uint256 salt,
        uint256 // no terms
    ) public view returns (PM.Permission memory p) {
        p.account = account;
        p.spender = address(this); // the executor: this code runs in its context
        p.start = g.start;
        p.end = g.end;
        p.salt = salt;
        p.calls = new PM.CallPermission[](2);
        p.calls[0] = PM.CallPermission(address(e.usdc), IERC20.approve.selector, address(0));
        p.calls[1] = PM.CallPermission(address(e.aaveV3Pool), IAaveV3Pool.supply.selector, address(0));
        p.spends = new PM.SpendLimit[](1);
        p.spends[0] = PM.SpendLimit(address(e.usdc), g.cap, PM.PeriodUnit.Day, 1);
    }

    function checkAmounts(Amounts memory a) public pure {
        if (!CashRules.amountsOk(a)) revert GooseExecutor.OutOfBounds();
    }

    /// What a run would do now: save, prune a dead permission, or nothing.
    function plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(uint256 => GooseExecutor.PoolUse) storage
    ) public view returns (GooseExecutor.Plan memory) {
        return _plan(e, c, permission(e, c.account, c.grant, c.salt, 0), _savesToday(acc));
    }

    /// Plans, and saves when there is something to save. Counts the save against today's number.
    function run(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(uint256 => GooseExecutor.PoolUse) storage
    ) external returns (GooseExecutor.Plan memory p) {
        PM.Permission memory perm = permission(e, c.account, c.grant, c.salt, 0);
        p = _plan(e, c, perm, _savesToday(acc));
        if (p.action != GooseExecutor.Action.Save) return p;
        _save(e, c.account, perm, p.amount);
        uint32 today = uint32(NyCalendar.day(block.timestamp));
        if (acc.savesDay != today) {
            acc.savesDay = today;
            acc.savesToday = 0;
        }
        ++acc.savesToday;
    }

    function _plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        PM.Permission memory perm,
        uint256 savesToday
    ) internal view returns (GooseExecutor.Plan memory p) {
        p.job = GooseExecutor.Job.Save;
        Amounts memory a = c.amounts;
        uint256 cash = e.usdc.balanceOf(c.account);
        if (cash < uint256(a.keepBack) + a.minSave) return p;
        SaveCase kind;
        (kind, p.amount) = CashRules.planSave(cash, JobBase.capLeft(e.manager, perm, 0), savesToday, a);
        if (kind != SaveCase.Save) return p;
        (bool alive, GooseExecutor.OffReason off) = JobBase.alive(e.manager, perm);
        if (!alive) {
            p.action = GooseExecutor.Action.Prune;
            p.off = off;
            p.amount = 0;
            return p;
        }
        p.action = GooseExecutor.Action.Save;
    }

    function _savesToday(GooseExecutor.Account storage acc) internal view returns (uint256) {
        return acc.savesDay == NyCalendar.day(block.timestamp) ? acc.savesToday : 0;
    }

    /// Wallet → savings: approve the pool exactly, supply for the account.
    function _save(GooseExecutor.Env memory e, address account, PM.Permission memory perm, uint256 amount) internal {
        uint256 cashBefore = e.usdc.balanceOf(account);
        uint256 savingsBefore = e.aUsdc.balanceOf(account);

        PM.Call[] memory calls = new PM.Call[](2);
        calls[0] = PM.Call(address(e.usdc), 0, abi.encodeCall(IERC20.approve, (address(e.aaveV3Pool), amount)));
        calls[1] = PM.Call(
            address(e.aaveV3Pool), 0, abi.encodeCall(IAaveV3Pool.supply, (address(e.usdc), amount, account, 0))
        );
        e.manager.executeBatch{gas: JobBase.ACCOUNT_GAS}(perm, calls);

        if (e.usdc.balanceOf(account) + amount != cashBefore) revert GooseExecutor.WrongAmount();
        if (e.aUsdc.balanceOf(account) + JobBase.SAVINGS_ROUNDING < savingsBefore + amount) {
            revert GooseExecutor.SavingsNotUp();
        }
        emit GooseExecutor.Saved(account, amount);
    }
}
