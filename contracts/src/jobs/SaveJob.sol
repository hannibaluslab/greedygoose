// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IAaveV3Pool, IERC20} from "../IProtocols.sol";
import {Amounts, CashRules, SaveCase, TopUps} from "../CashRules.sol";
import {NyCalendar} from "../NyCalendar.sol";
import {JobBase} from "./JobBase.sol";

/// @title SaveJob
/// @notice Save (docs/archive/goose-executor-plan.md §5.3): wallet USDC above the keep-back goes into the account's
///         Aave V3 savings, within today's limit and the daily number of saves. Only Save counts top-ups: with top-ups
///         on and Rebalance on, what it puts in savings, less the agents' own change, is a top-up waiting to go into
///         the mix (CashRules.topUpCounted).
/// @dev A linked library: its code runs as GooseExecutor, the spender, exactly as if it were inlined there.
library SaveJob {
    /// Aave V3's ReserveConfiguration bits: active, frozen, paused, and the supply cap in whole tokens (36 bits).
    uint256 internal constant V3_ACTIVE = 56;
    uint256 internal constant V3_FROZEN = 57;
    uint256 internal constant V3_PAUSED = 60;
    uint256 internal constant V3_SUPPLY_CAP = 116;
    uint256 internal constant V3_CAP_MASK = (1 << 36) - 1;
    /// Kept under the cap: the treasury's accrual since Aave's last update, and rounding ($1,000).
    uint256 internal constant SUPPLY_SLACK = 1_000e6;

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
        mapping(address => TopUps) storage
    ) public view returns (GooseExecutor.Plan memory) {
        return _plan(e, c, permission(e, c.account, c.grant, c.salt, 0), _savesToday(acc));
    }

    /// Plans, and saves when there is something to save. Counts the save against today's number, and what it put away
    /// as a top-up when the account has them on with Rebalance on.
    function run(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(address => TopUps) storage topUps
    ) external returns (GooseExecutor.Plan memory p) {
        PM.Permission memory perm = permission(e, c.account, c.grant, c.salt, 0);
        p = _plan(e, c, perm, _savesToday(acc));
        if (p.action != GooseExecutor.Action.Save) return p;
        (bool done, uint256 before, uint256 savings) = _save(e, c.account, perm, p.amount);
        uint32 today = uint32(NyCalendar.day(block.timestamp));
        if (acc.savesDay != today) {
            acc.savesDay = today;
            acc.savesToday = 0;
        }
        ++acc.savesToday; // a refused save counts too, so Aave refusing all day costs at most maxSavesPerDay tries
        if (done && acc.jobs & 1 << uint8(GooseExecutor.Job.Rebalance) != 0) {
            _count(topUps, c.account, today, before, p.amount, savings);
        }
    }

    /// The top-up in what Save put away (CashRules.topUpCounted), with top-ups on.
    function _count(
        mapping(address => TopUps) storage topUps,
        address account,
        uint256 day,
        uint256 before,
        uint256 saved,
        uint256 savings
    ) internal {
        TopUps memory t = topUps[account];
        if (!t.on) return;
        uint256 counted = CashRules.topUpCounted(t, day, before, saved, savings);
        topUps[account] = t;
        if (counted > 0) emit GooseExecutor.TopUpCounted(account, counted, uint256(t.ready) + t.today);
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
        uint256 left = JobBase.capLeft(e.manager, perm, 0);
        uint256 room = _room(e);
        (kind, p.amount) = CashRules.planSave(cash, left < room ? left : room, savesToday, a);
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

    /// What Aave V3 still takes as USDC savings now: 0 when the reserve is inactive, frozen or paused, else the room
    /// under its supply cap, counted the way its supply check counts it (aUSDC plus the treasury's accrual) less a
    /// slack for interest since its last update. Unlimited when it has no cap.
    function _room(GooseExecutor.Env memory e) internal view returns (uint256) {
        IAaveV3Pool.ReserveData memory d = e.aaveV3Pool.getReserveData(address(e.usdc));
        uint256 cfg = d.configuration;
        if (cfg >> V3_ACTIVE & 1 == 0 || cfg >> V3_FROZEN & 1 != 0 || cfg >> V3_PAUSED & 1 != 0) return 0;
        uint256 cap = (cfg >> V3_SUPPLY_CAP & V3_CAP_MASK) * 1e6;
        if (cap == 0) return type(uint256).max;
        uint256 used = e.aUsdc.totalSupply() + uint256(d.accruedToTreasury) * d.liquidityIndex / 1e27 + SUPPLY_SLACK;
        return cap > used ? cap - used : 0;
    }

    function _savesToday(GooseExecutor.Account storage acc) internal view returns (uint256) {
        return acc.savesDay == NyCalendar.day(block.timestamp) ? acc.savesToday : 0;
    }

    /// Wallet → savings: approve the pool exactly, supply for the account. Returns the savings before and after.
    function _save(GooseExecutor.Env memory e, address account, PM.Permission memory perm, uint256 amount)
        internal
        returns (bool, uint256 savingsBefore, uint256 savings)
    {
        uint256 cashBefore = e.usdc.balanceOf(account);
        savingsBefore = e.aUsdc.balanceOf(account);

        PM.Call[] memory calls = new PM.Call[](2);
        calls[0] = PM.Call(address(e.usdc), 0, abi.encodeCall(IERC20.approve, (address(e.aaveV3Pool), amount)));
        calls[1] = PM.Call(
            address(e.aaveV3Pool), 0, abi.encodeCall(IAaveV3Pool.supply, (address(e.usdc), amount, account, 0))
        );
        try e.manager.executeBatch{gas: JobBase.ACCOUNT_GAS}(perm, calls) {}
        catch {
            emit GooseExecutor.SaveSkipped(account, amount);
            return (false, savingsBefore, savingsBefore);
        }

        if (e.usdc.balanceOf(account) + amount != cashBefore) revert GooseExecutor.WrongAmount();
        savings = e.aUsdc.balanceOf(account);
        if (savings + JobBase.SAVINGS_ROUNDING < savingsBefore + amount) revert GooseExecutor.SavingsNotUp();
        emit GooseExecutor.Saved(account, amount);
        return (true, savingsBefore, savings);
    }
}
