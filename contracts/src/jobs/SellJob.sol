// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IAeroRouter, IERC20, ISpoke} from "../IProtocols.sol";
import {CashRules, TopUps} from "../CashRules.sol";
import {Book, Holding, SellLimits, SellRules, Slice} from "../SellRules.sol";
import {JobBase} from "./JobBase.sol";

/// @title SellJob
/// @notice Protect · sell (plan item 1, steps 10–12): below Protect's line, or during a rescue savings couldn't finish,
///         sell some of the stock that backs the credit on Aerodrome and repay with the proceeds, back to the target, in
///         slices that keep Aave's health check happy after every withdrawal. At once, with no heads-up (Adrian,
///         2026-10-19). The rule is SellRules; this library reads the account, builds the batch, sends it through the
///         manager and checks the result.
///
///         The permission lists only the stocks the user lets Protect sell, each with its own daily limit. A never-sell
///         stock has no `approve` in `calls`, so the manager refuses any batch that would sell it.
/// @dev A linked library: its code runs as GooseExecutor, the spender, exactly as if it were inlined there.
library SellJob {
    /// Most gas the manager's batch may use for a sale: about 660k plus 234k a slice, measured on a Base fork.
    uint256 internal constant SELL_GAS = 2_600_000;
    /// Kept for the reads and post-checks around the batch.
    uint256 internal constant CHECKS_GAS = 400_000;
    /// Planning a sale, before the batch: about 1.35M cold for seven stocks (ProtectSellSevenStockGasForkTest). A run
    /// that may sell checks it first, so a runner that sends too little gas defers the sale instead of running out mid
    /// plan, which would count as a failure and, repeated, switch Protect off.
    uint256 internal constant PLAN_GAS = 1_500_000;
    /// The pool cap counts every account's sales into one stock's pool over this window.
    uint48 internal constant POOL_WINDOW = 10 minutes;
    /// A stock is for sale only while its pool sits no more than the floor less this under Aave's price: the room for
    /// the pools' 0.05% fee and a slice's price impact (a $5,000 slice moves each pool under 0.01%, 2026-10-14).
    uint256 internal constant POOL_ROOM_BPS = 25;
    /// M3: a stock is for sale only while its pool sits at most this far under Aave's price (or the floor less
    /// POOL_ROOM_BPS, if that is closer), so a runner that moves the pool first can take at most this much.
    uint256 internal constant POOL_BAND_BPS = 100;
    /// M1: a rescue above Protect's line may use at most this share of a stock's window; the rest is kept for sales
    /// below the line.
    uint256 internal constant RESCUE_SHARE_BPS = 5_000;
    /// M1: while a window is in its first half, one account may use at most this share of it.
    uint256 internal constant ACCOUNT_SHARE_BPS = 5_000;
    /// A sale whose batch couldn't run waits this long, doubling with each skip in a row (2, 4, 8, then 16 minutes).
    uint256 internal constant SALE_RETRY = 2 minutes;
    uint256 internal constant MAX_SKIPS = 4;
    /// Where the sale's wait sits in the account's word in `GooseExecutor.entryWaits`, after Entry's four coins (bits
    /// 0-127): the retry time at bits 128-159, the skips in a row at 160-167.
    uint256 internal constant RETRY_AT = 128;
    uint256 internal constant SKIPS_AT = 160;

    /// What a planned sale carries to its batch.
    struct Sale {
        PM.Permission perm;
        Slice[] slices;
        uint256[7] prices;
        uint256 hf; // H6: the model's health before the sale, on each reserve's latest config (what Aave applies once the
        // first withdrawal refreshes the position)
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

    /// What a run would do now: sell, end a finished rescue, prune a dead permission, or nothing.
    function plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(uint256 => GooseExecutor.PoolUse) storage pools,
        mapping(address => uint256) storage waits
    ) public view returns (GooseExecutor.Plan memory p) {
        (p,) = _plan(e, c, acc, pools, waits[c.account]);
    }

    /// Plans, then sells. A sale that wouldn't fit in the gas left is deferred to the next run. A sale that leaves the
    /// credit under the target starts (or keeps) the rescue, so the next runs go on selling without waiting for the
    /// line again; one that reaches the target ends it. What the swaps paid over their minimums stays in the wallet as
    /// the agents' own change, which Save never counts as a top-up (P1).
    function run(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(uint256 => GooseExecutor.PoolUse) storage pools,
        mapping(address => TopUps) storage topUps,
        mapping(address => uint256) storage waits
    ) external returns (GooseExecutor.Plan memory p) {
        if (gasleft() < PLAN_GAS && _retryAt(waits[c.account]) <= block.timestamp && _mightSell(e, c, acc)) {
            p.job = GooseExecutor.Job.ProtectSell;
            p.action = GooseExecutor.Action.Defer;
            return p;
        }
        Sale memory sale;
        (p, sale) = _plan(e, c, acc, pools, waits[c.account]);
        if (p.action != GooseExecutor.Action.Sell) return p;
        if (gasleft() < SELL_GAS + CHECKS_GAS) {
            p.action = GooseExecutor.Action.Defer;
            return p;
        }
        uint256 cash = e.usdc.balanceOf(c.account);
        (bool done, uint256 hfAfter, bool owes) = _sell(e, c.account, sale, c.thresholds.targetHf);
        _wait(waits, c.account, done, hfAfter);
        if (!done) return p;
        JobBase.addOwn(topUps[c.account], e.usdc.balanceOf(c.account) - cash); // never lower: `check`
        // Counted once per stock, as the rule budgets it: a rounding up per slice could pass the cap by a unit.
        uint256[7] memory sold;
        uint256 repay;
        for (uint256 i; i < sale.slices.length; ++i) {
            sold[sale.slices[i].reserveId] += sale.slices[i].shares;
            repay += sale.slices[i].minOut;
        }
        emit GooseExecutor.ProtectSold(c.account, sold, repay, p.hf, hfAfter);
        for (uint256 r; r < 7; ++r) {
            if (sold[r] > 0) _usePool(pools, r, c.account, JobBase.ceilDiv(sold[r] * sale.prices[r], 1e10));
        }
        acc.rescueAt = JobBase.rescueAfter(acc.rescueAt, owes, hfAfter, c.thresholds.targetHf);
    }

    /// A skipped sale waits SALE_RETRY, doubling with each skip in a row up to 16 minutes, so a batch that keeps
    /// failing can't take every run's gas; it is never a failure. A sale that ran clears the wait. On a skip `why`
    /// is the failed post-check's selector (0: the batch itself reverted).
    function _wait(mapping(address => uint256) storage waits, address account, bool done, uint256 why) private {
        uint256 w = waits[account];
        if (done) {
            if (w >> SKIPS_AT & 0xff != 0) waits[account] = w & ~(uint256(type(uint40).max) << RETRY_AT);
            return;
        }
        uint256 skips = (w >> SKIPS_AT & 0xff) + 1;
        if (skips > MAX_SKIPS) skips = MAX_SKIPS;
        uint32 retryAt = uint32(block.timestamp + (SALE_RETRY << (skips - 1)));
        waits[account] = w & ~(uint256(type(uint40).max) << RETRY_AT) | (uint256(retryAt) | skips << 32) << RETRY_AT;
        emit GooseExecutor.SaleSkipped(account, bytes4(uint32(why)), retryAt);
    }

    /// The cheap part of `_plan`: whether this run may sell, before paying for a sale's plan.
    function _mightSell(GooseExecutor.Env memory e, GooseExecutor.Ctx memory c, GooseExecutor.Account storage acc)
        internal
        view
        returns (bool)
    {
        uint256 hf = c.hf != 0 ? c.hf : JobBase.health(e, c.account);
        bool rescuing = acc.rescueAt != 0;
        if (rescuing && JobBase.rescueDone(hf, c.thresholds.targetHf)) return false;
        return SellRules.sellsNow(hf, rescuing, c.frozen, c.thresholds.triggerHf, c.thresholds.targetHf);
    }

    function _plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(uint256 => GooseExecutor.PoolUse) storage pools,
        uint256 w
    ) internal view returns (GooseExecutor.Plan memory p, Sale memory sale) {
        p.job = GooseExecutor.Job.ProtectSell;
        p.hf = c.hf != 0 ? c.hf : JobBase.health(e, c.account);
        bool rescuing = acc.rescueAt != 0;
        // A rescue that's done ends here too, for an account that has Protect · sell without Protect from savings.
        if (rescuing && JobBase.rescueDone(p.hf, c.thresholds.targetHf)) {
            p.action = GooseExecutor.Action.EndRescue;
            return (p, sale);
        }
        if (!SellRules.sellsNow(p.hf, rescuing, c.frozen, c.thresholds.triggerHf, c.thresholds.targetHf)) {
            return (p, sale);
        }
        if (_retryAt(w) > block.timestamp) return (p, sale); // a skipped sale waits

        // Only worth it if there is something Protect may sell now.
        sale.perm = permission(e, c.account, c.grant, c.salt, c.terms);
        uint256 usdcLeft = JobBase.capLeft(e.manager, sale.perm, 0);
        if (usdcLeft == 0 || e.spoke.getReserve(e.usdcReserveId).flags & JobBase.PAUSED != 0) return (p, sale);
        uint256 floor = c.sellLimits.floorBps;
        Book memory b = _book(e, c, sale, pools, usdcLeft, floor, p.hf < c.thresholds.triggerHf);
        b.debt = JobBase.ceilDiv(e.spoke.getUserAccountData(c.account).totalDebtValueRay, 1e27);
        sale.hf = SellRules.power(b.stocks) * 1e14 / b.debt;
        uint256[7] memory take = SellRules.amounts(b, c.thresholds.targetHf, floor, acc.keepMix);
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
        p.action = GooseExecutor.Action.Sell;
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
        uint256 floor,
        bool urgent
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
                b.stocks[r].poolLeft = _poolLeft(pools, r, c.account, c.sellLimits.poolCap, urgent);
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
    /// failing the run; a pool above Aave's price only pays more. Read before every sale.
    function _fills(GooseExecutor.Env memory e, uint256 r, uint256 price, uint256 floorBps)
        internal
        view
        returns (bool)
    {
        uint256 band = floorBps < POOL_BAND_BPS + POOL_ROOM_BPS ? floorBps - POOL_ROOM_BPS : POOL_BAND_BPS;
        return JobBase.poolPrice(e, r) * SellRules.BPS >= price * (SellRules.BPS - band);
    }

    /// Takes each slice's stock out of Aave, swaps exactly that on Aerodrome to the account with Aave's price minus the
    /// floor as the minimum, and repays exactly that minimum. Approvals first, each for the whole run; the manager
    /// resets them after the batch. A batch that can't run (a swap the pool can't fill at its floor, say after someone
    /// moved the pool) moves nothing and is skipped, like the Rebalancer's, rather than counted as a failure: repeated,
    /// failures would switch Protect off. The post-checks still revert anything a batch that did run got wrong.
    /// Returns whether it sold, the health after, and whether anything is still owed.
    function _sell(GooseExecutor.Env memory e, address account, Sale memory sale, uint256 targetHf)
        internal
        returns (bool, uint256, bool)
    {
        uint256[7] memory sold;
        uint256 repay;
        for (uint256 i; i < sale.slices.length; ++i) {
            sold[sale.slices[i].reserveId] += sale.slices[i].shares;
            repay += sale.slices[i].minOut;
        }
        bytes memory batch =
            abi.encodeCall(PM.executeBatch, (sale.perm, _calls(e, account, sale.slices, sold, repay)));
        // The batch and its post-checks in one frame: a post-check that fails rolls the batch back with it, as a skip.
        (bool ok, bytes memory ret) = address(SellJob).delegatecall{gas: SELL_GAS + CHECKS_GAS}(
            abi.encodeWithSelector(SellJob.settle.selector, e, account, batch, sold, sale.hf, targetHf)
        );
        if (!ok) {
            uint256 why; // the failed post-check's selector; 0 when the batch itself reverted
            assembly ("memory-safe") {
                if gt(mload(ret), 3) { why := shr(224, mload(add(ret, 0x20))) }
            }
            return (false, why, true);
        }
        (uint256 hfAfter, bool owes) = abi.decode(ret, (uint256, bool));
        return (true, hfAfter, owes);
    }

    /// The sale's batch through the manager, then its post-checks. Only ever reached by SellJob's own delegatecall
    /// from `_sell` (a library's state-changing function refuses a direct call), so it runs as GooseExecutor.
    /// H6: health is compared with the model's health on the latest config (`hf`), which the first withdrawal moves
    /// the position to.
    function settle(
        GooseExecutor.Env memory e,
        address account,
        bytes memory batch,
        uint256[7] memory sold,
        uint256 hf,
        uint256 targetHf
    ) external returns (uint256, bool) {
        Before memory b = snapshot(e, account, sold, hf);
        (bool ok,) = address(e.manager).call{gas: SELL_GAS}(batch);
        if (!ok) revert();
        return check(e, account, b, targetHf);
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
            b.backing[r] = e.spoke.getUserSuppliedAssets(r, account);
            if (sold[r] != 0) b.mine[r] = IERC20(e.stocks[r]).balanceOf(address(this));
        }
    }

    /// A sale's post-checks: the debt is lower and the health higher, but no higher than the target allows; exactly
    /// what came out of Aave was sold, so no stock balance in the wallet moved; nothing else that backs the credit
    /// moved, so a never-sell stock is untouched; savings didn't move, cash isn't lower, and the executor holds none of
    /// the stock. Returns the health after, and whether anything is still owed.
    function check(GooseExecutor.Env memory e, address account, Before memory b, uint256 targetHf)
        public
        view
        returns (uint256 hf, bool owes)
    {
        uint256 debt = e.spoke.getUserTotalDebt(e.usdcReserveId, account);
        if (debt >= b.debt) revert GooseExecutor.DebtNotLower();
        owes = debt != 0;
        hf = e.spoke.getUserAccountData(account).healthFactor;
        if (hf <= b.hf) revert GooseExecutor.HealthNotHigher();
        // Never more than the rescue needs: back to the target, give or take rounding.
        if (owes && hf > targetHf + CashRules.OVERSHOOT_HF) revert GooseExecutor.Overshoot();
        for (uint256 r; r < 7; ++r) {
            if (IERC20(e.stocks[r]).balanceOf(account) != b.wallet[r]) revert GooseExecutor.StockMoved();
            uint256 left = e.spoke.getUserSuppliedAssets(r, account);
            if (b.sold[r] == 0) {
                if (left != b.backing[r]) revert GooseExecutor.BackingMoved();
            } else {
                // At least what the sale sold came out of Aave (H4): measured, not taken from the plan.
                if (left + b.sold[r] > b.backing[r]) revert GooseExecutor.BackingMoved();
                if (IERC20(e.stocks[r]).balanceOf(address(this)) > b.mine[r]) revert GooseExecutor.ExecutorGotFunds();
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

    function _retryAt(uint256 w) internal pure returns (uint256) {
        return w >> RETRY_AT & type(uint32).max;
    }

    // ================================================================== the pool cap

    /// What this account may still sell into stock r's pool in the current window, in USDC at Aave's price (M1): what
    /// all accounts together have left, a rescue above Protect's line only up to RESCUE_SHARE_BPS of the cap, and,
    /// while the window is in its first half, at most ACCOUNT_SHARE_BPS of it for one account. Keys 0-6 of `pools` hold
    /// each stock's window for all accounts; key account << 8 | r holds that account's own use of it.
    function _poolLeft(
        mapping(uint256 => GooseExecutor.PoolUse) storage pools,
        uint256 r,
        address account,
        uint256 cap,
        bool urgent
    ) internal view returns (uint256 left) {
        GooseExecutor.PoolUse memory all = pools[r];
        bool open = block.timestamp < all.start + POOL_WINDOW;
        uint256 used = open ? all.sold : 0;
        uint256 limit = urgent ? cap : cap * RESCUE_SHARE_BPS / SellRules.BPS;
        left = limit > used ? limit - used : 0;
        if (open && block.timestamp >= all.start + POOL_WINDOW / 2) return left;
        GooseExecutor.PoolUse memory mine = pools[_key(account, r)];
        uint256 mineUsed = open && mine.start == all.start ? mine.sold : 0;
        uint256 share = cap * ACCOUNT_SHARE_BPS / SellRules.BPS;
        share = share > mineUsed ? share - mineUsed : 0;
        if (share < left) left = share;
    }

    function _usePool(
        mapping(uint256 => GooseExecutor.PoolUse) storage pools,
        uint256 r,
        address account,
        uint256 amount
    ) internal {
        GooseExecutor.PoolUse storage all = pools[r];
        if (block.timestamp >= all.start + POOL_WINDOW) {
            all.start = uint48(block.timestamp);
            all.sold = 0;
        }
        all.sold += uint208(amount);
        uint256 k = _key(account, r);
        GooseExecutor.PoolUse memory mine = pools[k];
        pools[k] = GooseExecutor.PoolUse(all.start, (mine.start == all.start ? mine.sold : 0) + uint208(amount));
    }

    function _key(address account, uint256 r) internal pure returns (uint256) {
        return uint256(uint160(account)) << 8 | r;
    }

}
