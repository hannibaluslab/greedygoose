// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IAaveV3Pool, IERC20, ISpoke} from "../IProtocols.sol";
import {CashRules, ProtectCase, Thresholds} from "../CashRules.sol";
import {JobBase} from "./JobBase.sol";

/// @title ProtectJob
/// @notice Protect from savings (GooseExecutor.md §5.2): credit that slips below the trigger, the Act line, is repaid
///         from the account's Aave V3 savings back to the target, in Watch. Nothing in Safe or Watch, and no weekend
///         move (Act is the line, 2026-10-15).
/// @dev A linked library: its code runs as GooseExecutor, the spender, exactly as if it were inlined there.
library ProtectJob {
    /// The template the user approved: withdraw savings, approve USDC, repay. Both daily limits use the one cap:
    /// without the aUSDC one, a withdrawal of savings to someone else would be charged nothing (MANAGER-NOTES §1).
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
        p.calls = new PM.CallPermission[](3);
        p.calls[0] = PM.CallPermission(address(e.aaveV3Pool), IAaveV3Pool.withdraw.selector, address(0));
        p.calls[1] = PM.CallPermission(address(e.usdc), IERC20.approve.selector, address(0));
        p.calls[2] = PM.CallPermission(address(e.spoke), ISpoke.repay.selector, address(0));
        p.spends = new PM.SpendLimit[](2);
        p.spends[0] = PM.SpendLimit(address(e.usdc), g.cap, PM.PeriodUnit.Day, 1);
        p.spends[1] = PM.SpendLimit(address(e.aUsdc), g.cap, PM.PeriodUnit.Day, 1);
    }

    function checkThresholds(Thresholds memory t) public pure {
        if (!CashRules.thresholdsOk(t)) revert GooseExecutor.OutOfBounds();
    }

    /// What a run would do now: repay, prune a dead permission, or nothing.
    function plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage,
        mapping(uint256 => GooseExecutor.PoolUse) storage
    ) public view returns (GooseExecutor.Plan memory) {
        return _plan(e, c, permission(e, c.account, c.grant, c.salt, 0));
    }

    /// Plans, and repays when there is something to repay.
    function run(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage,
        mapping(uint256 => GooseExecutor.PoolUse) storage
    ) external returns (GooseExecutor.Plan memory p) {
        PM.Permission memory perm = permission(e, c.account, c.grant, c.salt, 0);
        p = _plan(e, c, perm);
        if (p.action == GooseExecutor.Action.Repay) _repay(e, c.account, perm, p);
    }

    /// A port of planGuardian (lib/guardian/plan.ts). Cheap reads first: most accounts owe nothing or are
    /// healthy, and the permission's status is only paid for when there is a move to make.
    function _plan(GooseExecutor.Env memory e, GooseExecutor.Ctx memory c, PM.Permission memory perm)
        internal
        view
        returns (GooseExecutor.Plan memory p)
    {
        p.job = GooseExecutor.Job.Protect;
        p.hf = type(uint256).max; // the health is passed on to the next job, so it needn't read it again
        if (e.spoke.getUserTotalDebt(e.usdcReserveId, c.account) == 0) return p;
        ISpoke.UserAccountData memory d = e.spoke.getUserAccountData(c.account);
        p.hf = d.healthFactor;
        (ProtectCase why, uint256 need, uint256 debt) =
            CashRules.protectNeed(d.totalCollateralValue, d.avgCollateralFactor, d.totalDebtValueRay, c.thresholds);
        if (why < ProtectCase.Act) return p;
        uint256 savings = e.aUsdc.balanceOf(c.account);
        if (savings == 0) return p; // NoSavings, before paying for the two limit reads
        (why, p.amount) =
            CashRules.protectAmount(why, need, debt, savings, _capLeft(e.manager, perm), c.amounts.minRepay);
        if (why < ProtectCase.Act) return p;
        (bool alive, GooseExecutor.OffReason off) = JobBase.alive(e.manager, perm);
        if (!alive) {
            p.action = GooseExecutor.Action.Prune;
            p.off = off;
            p.amount = 0;
            return p;
        }
        p.action = GooseExecutor.Action.Repay;
        p.reason = uint8(why);
    }

    /// Protect is charged on both limits: the approve amount in USDC, and the savings' drop in aUSDC, which Aave's
    /// rounding can make a unit or two larger.
    function _capLeft(PM manager, PM.Permission memory perm) internal view returns (uint256) {
        uint256 usdcLeft = JobBase.capLeft(manager, perm, 0);
        uint256 savingsLeft = JobBase.capLeft(manager, perm, 1);
        savingsLeft = savingsLeft > JobBase.SAVINGS_ROUNDING ? savingsLeft - JobBase.SAVINGS_ROUNDING : 0;
        return usdcLeft < savingsLeft ? usdcLeft : savingsLeft;
    }

    /// Savings → loan: withdraw to the account, approve the spoke, repay the account's own loan.
    function _repay(GooseExecutor.Env memory e, address account, PM.Permission memory perm, GooseExecutor.Plan memory p)
        internal
    {
        uint256 debtBefore = e.spoke.getUserTotalDebt(e.usdcReserveId, account);
        uint256 savingsBefore = e.aUsdc.balanceOf(account);
        uint256 cashBefore = e.usdc.balanceOf(account);

        PM.Call[] memory calls = new PM.Call[](3);
        calls[0] = PM.Call(
            address(e.aaveV3Pool), 0, abi.encodeCall(IAaveV3Pool.withdraw, (address(e.usdc), p.amount, account))
        );
        calls[1] = PM.Call(address(e.usdc), 0, abi.encodeCall(IERC20.approve, (address(e.spoke), p.amount)));
        calls[2] = PM.Call(address(e.spoke), 0, abi.encodeCall(ISpoke.repay, (e.usdcReserveId, p.amount, account)));
        e.manager.executeBatch{gas: JobBase.ACCOUNT_GAS}(perm, calls);

        if (e.spoke.getUserTotalDebt(e.usdcReserveId, account) >= debtBefore) revert GooseExecutor.DebtNotLower();
        uint256 hfAfter = e.spoke.getUserAccountData(account).healthFactor;
        if (hfAfter < p.hf) revert GooseExecutor.HealthLower();
        if (e.aUsdc.balanceOf(account) + p.amount + JobBase.SAVINGS_ROUNDING < savingsBefore) {
            revert GooseExecutor.SavingsMoved();
        }
        // If the debt was smaller than the amount, the spoke took less; the rest stays in the wallet for Save.
        if (e.usdc.balanceOf(account) < cashBefore) revert GooseExecutor.CashLower();
        emit GooseExecutor.ProtectRepaid(account, p.amount, p.hf, hfAfter, ProtectCase(p.reason));
    }
}
