// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IAaveV3Pool, IERC20, ISpoke} from "../IProtocols.sol";
import {CashRules, ProtectCase, Thresholds, TopUps} from "../CashRules.sol";
import {JobBase} from "./JobBase.sol";

/// @title ProtectJob
/// @notice Protect from savings (docs/archive/goose-executor-plan.md §5.2): credit that slips below Protect's line
///         (1.03) is repaid from the account's Aave V3 savings back to the target (1.12, in Watch). When savings can't
///         get it there, the rescue goes on (`Account.rescueAt`): Protect · sell takes over, and savings that arrive
///         meanwhile repay first, until the credit is back at the target (Adrian, 2026-10-19).
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

    /// What a run would do now: repay, end a finished rescue, prune a dead permission, or nothing.
    function plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(address => TopUps) storage
    ) public view returns (GooseExecutor.Plan memory p) {
        (p,) = _plan(e, c, acc.rescueAt != 0, permission(e, c.account, c.grant, c.salt, 0));
    }

    /// Plans, and repays when there is something to repay: wallet cash above the keep-back first, then savings. A
    /// batch that can't run moves nothing and is skipped (RepaySkipped), so Protect · sell gets its turn in the same
    /// run (H1). A repay that leaves the credit short of the target keeps the rescue on and hands over to Protect · sell
    /// in the same run (RepayThenSell, with the health after), so no amount of cash can hold back the sale (H3).
    function run(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(address => TopUps) storage topUps
    ) external returns (GooseExecutor.Plan memory p) {
        PM.Permission memory perm = permission(e, c.account, c.grant, c.salt, 0);
        uint256 fromSavings;
        (p, fromSavings) = _plan(e, c, acc.rescueAt != 0, perm);
        if (p.action != GooseExecutor.Action.Repay) return p;
        (bool done, uint256 hfAfter, bool owes, uint256 spent, uint256 change) =
            _repay(e, c.account, perm, p, fromSavings, c.thresholds.targetHf);
        if (!done) {
            p.action = GooseExecutor.Action.RepayThenSell; // nothing moved: the sale goes next, and the run ends there
            return p;
        }
        uint48 rescueAt = JobBase.rescueAfter(acc.rescueAt, owes, hfAfter, c.thresholds.targetHf);
        acc.rescueAt = rescueAt;
        TopUps storage t = topUps[c.account];
        if (spent > 0 && t.own > 0) t.own = t.own > spent ? t.own - spent : 0; // the agents' change goes first
        JobBase.addOwn(t, change);
        // Short of the target with selling on: Protect · sell runs next, in a sub-call of its own (H3).
        if (rescueAt != 0 && acc.jobs & 1 << uint8(GooseExecutor.Job.ProtectSell) != 0) {
            p.action = GooseExecutor.Action.RepayThenSell;
        }
    }

    /// A port of planProtect (lib/agents/rules/protect.ts). Cheap reads first: most accounts owe nothing or are
    /// healthy, and the permission's status is only paid for when there is a move to make.
    function _plan(GooseExecutor.Env memory e, GooseExecutor.Ctx memory c, bool rescuing, PM.Permission memory perm)
        internal
        view
        returns (GooseExecutor.Plan memory p, uint256 fromSavings)
    {
        p.job = GooseExecutor.Job.Protect;
        p.hf = type(uint256).max; // the health is passed on to the next job, so it needn't read it again
        if (e.spoke.getUserTotalDebt(e.usdcReserveId, c.account) == 0) {
            if (rescuing) p.action = GooseExecutor.Action.EndRescue;
            return (p, 0);
        }
        ISpoke.UserAccountData memory d = e.spoke.getUserAccountData(c.account);
        p.hf = d.healthFactor;
        if (rescuing && JobBase.rescueDone(p.hf, c.thresholds.targetHf)) {
            p.action = GooseExecutor.Action.EndRescue;
            return (p, 0);
        }
        (ProtectCase why, uint256 need, uint256 debt) = CashRules.protectNeed(
            d.totalCollateralValue, d.avgCollateralFactor, d.totalDebtValueRay, c.thresholds, rescuing
        );
        if (why < ProtectCase.Act) return (p, 0);
        // The spoke refuses a repay while USDC's reserve is paused (Protect · sell checks the same flag).
        if (e.spoke.getReserve(e.usdcReserveId).flags & JobBase.PAUSED != 0) return (p, 0);
        uint256 wallet = e.usdc.balanceOf(c.account);
        wallet = wallet > c.amounts.keepBack ? wallet - c.amounts.keepBack : 0;
        uint256 savings = _savingsOut(e, c.account);
        if (wallet + savings == 0) return (p, 0); // NoSavings, before paying for the two limit reads
        uint256 amount;
        (why, amount, fromSavings) = CashRules.protectAmount(
            why, need, debt, wallet, savings, _capLeft(e.manager, perm), c.amounts.minRepay
        );
        if (why < ProtectCase.Act) return (p, 0);
        (bool alive, GooseExecutor.OffReason off) = JobBase.alive(e.manager, perm);
        if (!alive) {
            p.action = GooseExecutor.Action.Prune;
            p.off = off;
            return (p, 0);
        }
        p.action = GooseExecutor.Action.Repay;
        p.amount = amount;
        p.reason = uint8(why);
    }

    /// Savings Aave V3 can pay out now: the balance, within the reserve's virtual balance; none while the reserve is
    /// inactive or paused (a frozen reserve still pays out). USDC.balanceOf(aUSDC) would count donations it can't pay.
    function _savingsOut(GooseExecutor.Env memory e, address account) internal view returns (uint256 s) {
        s = e.aUsdc.balanceOf(account);
        if (s == 0) return 0;
        uint256 cfg = e.aaveV3Pool.getConfiguration(address(e.usdc));
        if (cfg >> 56 & 1 == 0 || cfg >> 60 & 1 != 0) return 0;
        uint256 free = e.aaveV3Pool.getVirtualUnderlyingBalance(address(e.usdc));
        return s < free ? s : free;
    }

    /// Protect is charged on both limits: the approve amount in USDC, and the savings' drop in aUSDC, which Aave's
    /// rounding can make a unit or two larger.
    function _capLeft(PM manager, PM.Permission memory perm) internal view returns (uint256) {
        uint256 usdcLeft = JobBase.capLeft(manager, perm, 0);
        uint256 savingsLeft = JobBase.capLeft(manager, perm, 1);
        savingsLeft = savingsLeft > JobBase.SAVINGS_ROUNDING ? savingsLeft - JobBase.SAVINGS_ROUNDING : 0;
        return usdcLeft < savingsLeft ? usdcLeft : savingsLeft;
    }

    /// Cash → loan: withdraw `fromSavings` to the account (if any), approve the spoke, repay the account's own loan.
    /// Returns whether the batch ran, the health after, whether anything is still owed, what it took from the wallet,
    /// and what the repay left in the wallet over what was there.
    function _repay(
        GooseExecutor.Env memory e,
        address account,
        PM.Permission memory perm,
        GooseExecutor.Plan memory p,
        uint256 fromSavings,
        uint256 targetHf
    ) internal returns (bool, uint256 hfAfter, bool owes, uint256 spent, uint256 change) {
        uint256 debtBefore = e.spoke.getUserTotalDebt(e.usdcReserveId, account);
        uint256 savingsBefore = e.aUsdc.balanceOf(account);
        uint256 cashBefore = e.usdc.balanceOf(account);

        uint256 n = fromSavings > 0 ? 1 : 0;
        PM.Call[] memory calls = new PM.Call[](2 + n);
        if (n == 1) {
            calls[0] = PM.Call(
                address(e.aaveV3Pool), 0, abi.encodeCall(IAaveV3Pool.withdraw, (address(e.usdc), fromSavings, account))
            );
        }
        calls[n] = PM.Call(address(e.usdc), 0, abi.encodeCall(IERC20.approve, (address(e.spoke), p.amount)));
        calls[n + 1] =
            PM.Call(address(e.spoke), 0, abi.encodeCall(ISpoke.repay, (e.usdcReserveId, p.amount, account)));
        try e.manager.executeBatch{gas: JobBase.ACCOUNT_GAS}(perm, calls) {}
        catch {
            emit GooseExecutor.RepaySkipped(account);
            return (false, p.hf, true, 0, 0);
        }

        uint256 debtAfter = e.spoke.getUserTotalDebt(e.usdcReserveId, account);
        if (debtAfter >= debtBefore) revert GooseExecutor.DebtNotLower();
        owes = debtAfter != 0;
        hfAfter = e.spoke.getUserAccountData(account).healthFactor;
        if (hfAfter < p.hf) revert GooseExecutor.HealthLower();
        // Never more than the rescue needs: back to the target, give or take rounding.
        if (owes && hfAfter > targetHf + CashRules.OVERSHOOT_HF) revert GooseExecutor.Overshoot();
        if (e.aUsdc.balanceOf(account) + fromSavings + JobBase.SAVINGS_ROUNDING < savingsBefore) {
            revert GooseExecutor.SavingsMoved();
        }
        // The wallet gives at most its planned part (never below the keep-back); if the debt was smaller than the
        // amount, the spoke took less, and what came from savings stays in the wallet for Save.
        uint256 cash = e.usdc.balanceOf(account);
        if (cash + (p.amount - fromSavings) < cashBefore) revert GooseExecutor.CashLower();
        if (cash < cashBefore) spent = cashBefore - cash;
        else change = cash - cashBefore;
        emit GooseExecutor.ProtectRepaid(account, p.amount, p.hf, hfAfter, ProtectCase(p.reason));
        return (true, hfAfter, owes, spent, change);
    }
}
