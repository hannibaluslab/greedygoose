// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IAeroRouter, IERC20, ISpoke} from "../IProtocols.sol";
import {NyCalendar} from "../NyCalendar.sol";
import {Book, Holding, SellLimits, SellRules, SellTiming, Slice} from "../SellRules.sol";
import {JobBase} from "./JobBase.sol";

/// @title SellJob
/// @notice Protect · sell (plan item 1, steps 10–12): when savings can't keep the credit Safe, sell some of the stock
///         that backs it on Aerodrome and repay with the proceeds, in slices that keep Aave's health check happy after
///         every withdrawal. The rule is SellRules; this library reads the account, builds the batch, sends it through
///         the manager and checks the result.
///
///         The permission lists only the stocks the user lets Protect sell, each with its own daily limit. A never-sell
///         stock has no `approve` in `calls`, so the manager refuses any batch that would sell it.
/// @dev A linked library: its code runs as GooseExecutor, the spender, exactly as if it were inlined there.
library SellJob {
    /// Most gas the manager's batch may use for a sale: about 660k plus 234k a slice, measured on a Base fork.
    uint256 internal constant SELL_GAS = 2_600_000;
    /// Kept for the reads and post-checks around the batch.
    uint256 internal constant CHECKS_GAS = 400_000;
    /// The pool cap counts every account's sales into one stock's pool over this window.
    uint48 internal constant POOL_WINDOW = 10 minutes;
    /// A stock is for sale only while its pool sits no more than the floor less this under Aave's price: the room for
    /// the pools' 0.05% fee and a slice's price impact (a $5,000 slice moves each pool under 0.01%, 2026-10-14).
    uint256 internal constant POOL_ROOM_BPS = 25;

    /// What a planned sale carries to its batch.
    struct Sale {
        PM.Permission perm;
        Slice[] slices;
        uint256[7] prices;
        bool atOnce;
    }

    // ================================================================== permission

    /// The template the user approved: take the stock out of Aave, approve each sellable stock to the router, swap,
    /// approve USDC, repay. Daily limits on USDC (the repay leg) and on aUSDC, both at the one cap, and on each sellable
    /// stock. Nothing here touches savings; the aUSDC limit means the manager also bounds any savings move a batch
    /// could make through an allowance the account gave elsewhere, and the post-checks revert one.
    function permission(
        GooseExecutor.Env memory e,
        address account,
        GooseExecutor.Grant memory g,
        uint256 salt,
        uint256 terms
    ) public view returns (PM.Permission memory p) {
        p.account = account;
        p.spender = address(this); // the executor: this code runs in its context
        p.start = g.start;
        p.end = g.end;
        p.salt = salt;
        uint256 k;
        for (uint256 r; r < 7; ++r) {
            if (JobBase.stockLimit(terms, r) > 0) ++k;
        }
        p.calls = new PM.CallPermission[](4 + k);
        p.spends = new PM.SpendLimit[](2 + k);
        p.calls[0] = PM.CallPermission(address(e.spoke), ISpoke.withdraw.selector, address(0));
        p.spends[0] = PM.SpendLimit(address(e.usdc), g.cap, PM.PeriodUnit.Day, 1);
        p.spends[1] = PM.SpendLimit(address(e.aUsdc), g.cap, PM.PeriodUnit.Day, 1);
        uint256 j;
        for (uint256 r; r < 7; ++r) {
            uint256 limit = JobBase.stockLimit(terms, r);
            if (limit == 0) continue;
            ++j;
            p.calls[j] = PM.CallPermission(e.stocks[r], IERC20.approve.selector, address(0));
            p.spends[1 + j] = PM.SpendLimit(e.stocks[r], uint160(limit), PM.PeriodUnit.Day, 1);
        }
        p.calls[k + 1] = PM.CallPermission(e.router, IAeroRouter.exactInputSingle.selector, address(0));
        p.calls[k + 2] = PM.CallPermission(address(e.usdc), IERC20.approve.selector, address(0));
        p.calls[k + 3] = PM.CallPermission(address(e.spoke), ISpoke.repay.selector, address(0));
    }

    /// The terms a granted permission carries, read from its stock limits after USDC's and aUSDC's (JobBase).
    function termsFrom(GooseExecutor.Env memory e, PM.Permission memory p) public pure returns (uint256) {
        return JobBase.stockTerms(e, p, 2);
    }

    /// At least one stock is for sale, each within its registration bound (JobBase).
    function termsOk(GooseExecutor.Env memory e, uint256 terms) public view returns (bool) {
        return JobBase.stockTermsOk(e, terms);
    }

    function checkLimits(SellLimits memory l) public pure {
        if (!SellRules.limitsOk(l)) revert GooseExecutor.OutOfBounds();
    }

    // ================================================================== plan and run

    /// What a run would do now: sell, send or clear a heads-up, prune a dead permission, or nothing.
    function plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(uint256 => GooseExecutor.PoolUse) storage pools
    ) public view returns (GooseExecutor.Plan memory p) {
        (p,) = _plan(e, c, acc, pools);
    }

    /// Plans, then makes the move: a sale, a heads-up, or clearing one. A sale that wouldn't fit in the gas left is
    /// deferred to the next run. `holiday` is the executor's calendar, for the time a heads-up gives.
    function run(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(uint256 => GooseExecutor.PoolUse) storage pools,
        mapping(uint32 => bool) storage holiday
    ) external returns (GooseExecutor.Plan memory p) {
        Sale memory sale;
        (p, sale) = _plan(e, c, acc, pools);
        if (p.action == GooseExecutor.Action.ClearHeadsUp) {
            acc.headsUpAt = 0;
            emit GooseExecutor.SellHeadsUpCleared(c.account, p.hf);
        } else if (p.action == GooseExecutor.Action.HeadsUp) {
            acc.headsUpAt = uint48(block.timestamp);
            // Sent on time, even just before a price freeze; a sale whose wait ends while prices are held goes when
            // they reopen, if the health is still below the line (decision, 2026-10-14). The heads-up says when.
            uint256 sellAfter = NyCalendar.nextOpen(holiday, block.timestamp + c.sellLimits.headsUpDelay);
            emit GooseExecutor.SellHeadsUp(c.account, p.hf, _value(sale), uint48(sellAfter));
        } else if (p.action == GooseExecutor.Action.Sell) {
            if (gasleft() < SELL_GAS + CHECKS_GAS) {
                p.action = GooseExecutor.Action.Defer;
                return p;
            }
            uint256 hfAfter = _sell(e, c.account, sale, p.hf);
            for (uint256 i; i < sale.slices.length; ++i) {
                Slice memory s = sale.slices[i];
                _usePool(pools[s.reserveId], JobBase.ceilDiv(s.shares * sale.prices[s.reserveId], 1e10));
            }
            // Done once back above the heads-up line. A sale cut short (by the slices a run makes, a limit or the pool
            // cap) goes on in the next runs without a new wait: the user was warned, or it was urgent.
            acc.headsUpAt = hfAfter >= c.sellLimits.headsUpHf
                ? 0
                : uint48(block.timestamp) - c.sellLimits.headsUpDelay;
        }
    }

    function _plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(uint256 => GooseExecutor.PoolUse) storage pools
    ) internal view returns (GooseExecutor.Plan memory p, Sale memory sale) {
        p.job = GooseExecutor.Job.ProtectSell;
        p.hf = c.hf != 0 ? c.hf : JobBase.health(e, c.account);
        SellTiming t;
        (t, sale.atOnce) = SellRules.timing(p.hf, acc.headsUpAt, block.timestamp, c.frozen, c.sellLimits);
        if (t == SellTiming.Wait) return (p, sale);
        if (t == SellTiming.Clear) {
            p.action = GooseExecutor.Action.ClearHeadsUp;
            return (p, sale);
        }

        // A heads-up or a sale: only worth it if there is something Protect may sell now.
        sale.perm = permission(e, c.account, c.grant, c.salt, c.terms);
        uint256 usdcLeft = JobBase.capLeft(e.manager, sale.perm, 0);
        if (usdcLeft == 0 || e.spoke.getReserve(e.usdcReserveId).flags & JobBase.PAUSED != 0) return (p, sale);
        uint256 floor = sale.atOnce ? c.sellLimits.actFloorBps : c.sellLimits.floorBps;
        Book memory b = _book(e, c, sale, pools, usdcLeft, floor);
        b.debt = JobBase.ceilDiv(e.spoke.getUserAccountData(c.account).totalDebtValueRay, 1e27);
        uint256[7] memory take = SellRules.amounts(b, c.sellLimits.targetHf, floor, acc.keepMix);
        sale.slices = SellRules.slices(b, take, floor, c.sellLimits.maxSlice);
        for (uint256 i; i < sale.slices.length; ++i) {
            p.amount += sale.slices[i].minOut;
        }
        if (p.amount < c.amounts.minRepay) {
            p.amount = 0;
            return (p, sale);
        }
        (bool alive, GooseExecutor.OffReason off) = JobBase.alive(e.manager, sale.perm);
        if (!alive) {
            p.action = GooseExecutor.Action.Prune;
            p.off = off;
            p.amount = 0;
            return (p, sale);
        }
        p.action = t == SellTiming.HeadsUp ? GooseExecutor.Action.HeadsUp : GooseExecutor.Action.Sell;
        p.reason = sale.atOnce ? 1 : 0;
    }

    /// The account's backing, read the way Aave counts it after a withdrawal: each collateral reserve at its current
    /// config's factor. A stock is for sale when the grant lists it, its reserve isn't paused, its pool can fill at
    /// `floor`, and its limit, the pool's window and the USDC limit leave room.
    function _book(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        Sale memory sale,
        mapping(uint256 => GooseExecutor.PoolUse) storage pools,
        uint256 usdcLeft,
        uint256 floor
    ) internal view returns (Book memory b) {
        b.usdcPrice = e.oracle.getReservePrice(e.usdcReserveId);
        b.usdcLeft = usdcLeft;
        uint256 spend = 2; // the stock limits follow USDC's and aUSDC's, in reserve order
        for (uint256 r; r < 7; ++r) {
            bool paused;
            (b.stocks[r], paused) = _holding(e, c.account, r);
            sale.prices[r] = b.stocks[r].price;
            if (JobBase.stockLimit(c.terms, r) == 0) continue;
            if (b.stocks[r].shares > 0 && !paused && _fills(e, r, b.stocks[r].price, floor)) {
                b.stocks[r].limit = JobBase.capLeft(e.manager, sale.perm, spend);
                b.stocks[r].poolLeft = _poolLeft(pools[r], c.sellLimits.poolCap);
            }
            ++spend;
        }
    }

    /// Reserve r's backing for the account, if it counts: used as collateral, with a factor above 0.
    function _holding(GooseExecutor.Env memory e, address account, uint256 r)
        internal
        view
        returns (Holding memory h, bool paused)
    {
        (bool collateral,) = e.spoke.getUserReserveStatus(r, account);
        if (!collateral) return (h, false);
        uint256 shares = e.spoke.getUserSuppliedAssets(r, account);
        if (shares == 0) return (h, false);
        ISpoke.Reserve memory res = e.spoke.getReserve(r);
        h.cf = e.spoke.getDynamicReserveConfig(r, res.dynamicConfigKey).collateralFactor;
        if (h.cf == 0) return (h, false);
        h.shares = shares;
        h.price = e.oracle.getReservePrice(r);
        paused = res.flags & JobBase.PAUSED != 0;
    }

    /// Whether stock r's pool can fill a sale at `floorBps` under Aave's `price`: it sits no more than the floor, less
    /// POOL_ROOM_BPS, under it. A stock whose pool can't is left out, so the sale moves on to the next one instead of
    /// failing the run; a pool above Aave's price only pays more. Read before every sale and heads-up.
    function _fills(GooseExecutor.Env memory e, uint256 r, uint256 price, uint256 floorBps)
        internal
        view
        returns (bool)
    {
        return JobBase.poolPrice(e, r) * SellRules.BPS >= price * (SellRules.BPS + POOL_ROOM_BPS - floorBps);
    }

    /// Takes each slice's stock out of Aave, swaps exactly that on Aerodrome to the account with Aave's price minus the
    /// floor as the minimum, and repays exactly that minimum. Approvals first, each for the whole run; the manager
    /// resets them after the batch.
    function _sell(GooseExecutor.Env memory e, address account, Sale memory sale, uint256 hfBefore)
        internal
        returns (uint256 hfAfter)
    {
        uint256[7] memory sold;
        uint256 repay;
        for (uint256 i; i < sale.slices.length; ++i) {
            sold[sale.slices[i].reserveId] += sale.slices[i].shares;
            repay += sale.slices[i].minOut;
        }
        Before memory b = snapshot(e, account, sold, hfBefore);
        e.manager.executeBatch{gas: SELL_GAS}(sale.perm, _calls(e, account, sale.slices, sold, repay));
        hfAfter = check(e, account, b);
        emit GooseExecutor.ProtectSold(account, sold, repay, hfBefore, hfAfter, sale.atOnce);
    }

    /// What a sale's post-checks compare with.
    struct Before {
        uint256[7] sold; // shares the batch sells, by reserve id
        uint256 hf;
        uint256 debt;
        uint256 cash;
        uint256 savings;
        uint256[7] wallet; // the account's stock balances
        uint256[7] backing; // what backs the credit, for each stock the batch doesn't sell
        uint256[7] mine; // the executor's balance of each stock the batch sells
    }

    function snapshot(GooseExecutor.Env memory e, address account, uint256[7] memory sold, uint256 hf)
        public
        view
        returns (Before memory b)
    {
        b.sold = sold;
        b.hf = hf;
        b.debt = e.spoke.getUserTotalDebt(e.usdcReserveId, account);
        b.cash = e.usdc.balanceOf(account);
        b.savings = e.aUsdc.balanceOf(account);
        for (uint256 r; r < 7; ++r) {
            b.wallet[r] = IERC20(e.stocks[r]).balanceOf(account);
            if (sold[r] == 0) b.backing[r] = e.spoke.getUserSuppliedAssets(r, account);
            else b.mine[r] = IERC20(e.stocks[r]).balanceOf(address(this));
        }
    }

    /// A sale's post-checks: the debt is lower and the health higher; exactly what came out of Aave was sold, so no
    /// stock balance in the wallet moved; nothing else that backs the credit moved, so a never-sell stock is untouched;
    /// savings didn't move, cash isn't lower, and the executor holds none of the stock. Returns the health after.
    function check(GooseExecutor.Env memory e, address account, Before memory b) public view returns (uint256 hf) {
        if (e.spoke.getUserTotalDebt(e.usdcReserveId, account) >= b.debt) revert GooseExecutor.DebtNotLower();
        hf = e.spoke.getUserAccountData(account).healthFactor;
        if (hf <= b.hf) revert GooseExecutor.HealthNotHigher();
        for (uint256 r; r < 7; ++r) {
            if (IERC20(e.stocks[r]).balanceOf(account) != b.wallet[r]) revert GooseExecutor.StockMoved();
            if (b.sold[r] == 0) {
                if (e.spoke.getUserSuppliedAssets(r, account) != b.backing[r]) revert GooseExecutor.BackingMoved();
            } else if (IERC20(e.stocks[r]).balanceOf(address(this)) > b.mine[r]) {
                revert GooseExecutor.ExecutorGotFunds();
            }
        }
        if (e.aUsdc.balanceOf(account) < b.savings) revert GooseExecutor.SavingsMoved();
        // The swaps paid at least each minimum; what they paid above it stays in the wallet as cash.
        if (e.usdc.balanceOf(account) < b.cash) revert GooseExecutor.CashLower();
    }

    function _calls(
        GooseExecutor.Env memory e,
        address account,
        Slice[] memory slices,
        uint256[7] memory sold,
        uint256 repay
    ) internal view returns (PM.Call[] memory calls) {
        uint256 k;
        for (uint256 r; r < 7; ++r) {
            if (sold[r] > 0) ++k;
        }
        calls = new PM.Call[](1 + k + 3 * slices.length);
        calls[0] = PM.Call(address(e.usdc), 0, abi.encodeCall(IERC20.approve, (address(e.spoke), repay)));
        uint256 n = 1;
        for (uint256 r; r < 7; ++r) {
            if (sold[r] > 0) {
                calls[n++] = PM.Call(e.stocks[r], 0, abi.encodeCall(IERC20.approve, (e.router, sold[r])));
            }
        }
        for (uint256 i; i < slices.length; ++i) {
            Slice memory s = slices[i];
            calls[n++] = PM.Call(address(e.spoke), 0, abi.encodeCall(ISpoke.withdraw, (s.reserveId, s.shares, account)));
            IAeroRouter.ExactInputSingleParams memory swap = IAeroRouter.ExactInputSingleParams({
                tokenIn: e.stocks[s.reserveId],
                tokenOut: address(e.usdc),
                tickSpacing: JobBase.STOCK_TICK_SPACING,
                recipient: account,
                deadline: block.timestamp,
                amountIn: s.shares,
                amountOutMinimum: s.minOut,
                sqrtPriceLimitX96: 0
            });
            calls[n++] = PM.Call(e.router, 0, abi.encodeCall(IAeroRouter.exactInputSingle, (swap)));
            calls[n++] =
                PM.Call(address(e.spoke), 0, abi.encodeCall(ISpoke.repay, (e.usdcReserveId, s.minOut, account)));
        }
    }

    // ================================================================== the pool cap

    /// What all accounts may still sell into a stock's pool in the current window, in USDC at Aave's price.
    function _poolLeft(GooseExecutor.PoolUse memory u, uint256 cap) internal view returns (uint256) {
        if (block.timestamp >= u.start + POOL_WINDOW) return cap;
        return cap > u.sold ? cap - u.sold : 0;
    }

    function _usePool(GooseExecutor.PoolUse storage u, uint256 amount) internal {
        if (block.timestamp >= u.start + POOL_WINDOW) {
            u.start = uint48(block.timestamp);
            u.sold = 0;
        }
        u.sold += uint208(amount);
    }

    // ================================================================== helpers

    /// What the planned slices sell, in USDC at Aave's price.
    function _value(Sale memory sale) internal pure returns (uint256 v) {
        for (uint256 i; i < sale.slices.length; ++i) {
            v += sale.slices[i].shares * sale.prices[sale.slices[i].reserveId] / 1e10;
        }
    }
}
