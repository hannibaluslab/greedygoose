// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IAaveV3Pool, IAeroRouter, IERC20} from "../IProtocols.sol";
import {CashRules, TopUps} from "../CashRules.sol";
import {NyCalendar} from "../NyCalendar.sol";
import {RebalanceBook, RebalanceLimits, RebalanceRules, Trade} from "../RebalanceRules.sol";
import {JobBase} from "./JobBase.sol";

/// @title RebalanceJob
/// @notice The Rebalancer (plan item 9): once a market day, 30 to 60 minutes after the open, it keeps the account's mix
///         of free stock on target, selling what broke out of its band to buy what fell short, on Aerodrome. With
///         top-ups on, that same check first puts the top-ups Save counted on an earlier day into the mix, taken from
///         savings, buying what's furthest below its target; a day it does, band trades wait for the next market day.
///         The rules are RebalanceRules; this library reads the account, builds the batch, sends it through the manager
///         and checks the result. The mix lives in the registry, and only the account sets it (`GooseExecutor.setMix`),
///         as it does top-ups and Keep (`GooseExecutor.setTopUps`).
///
///         The permission approves only the stocks the user lets it sell, each with a limit in shares, and USDC for the
///         buys. Only a grant with top-ups adds Aave V3's withdraw, with an aUSDC limit; nothing reaches backing. The
///         post-checks keep the wallet's USDC from going down, savings from falling by more than what was put in, and
///         every stock it touches where the plan put it.
/// @dev A linked library: its code runs as GooseExecutor, the spender, exactly as if it were inlined there.
library RebalanceJob {
    /// Most gas the manager's batch may use for a rebalance: seven swaps and their approvals, or a withdraw from
    /// savings and seven buys, measured on a Base fork.
    uint256 internal constant REBALANCE_GAS = 2_000_000;
    /// Kept for the reads, post-checks and bookkeeping around the batch.
    uint256 internal constant CHECKS_GAS = 300_000;
    /// The window, New York time: 30 to 60 minutes after the 9:30 open, on a day prices are live.
    uint256 internal constant FROM = 10 hours;
    uint256 internal constant UNTIL = 10 hours + 30 minutes;
    /// The Act line (config/risk.ts RISK.watchMin): no rebalancing while the credit is in Act. It is the status line,
    /// not Protect's (1.03), which acts further down (Adrian, 2026-10-19).
    uint256 internal constant ACT_HF = 1.1e18;
    /// The grant's terms carry this bit when it lets Rebalance put top-ups into the mix: Aave V3's withdraw comes first
    /// in its calls and aUSDC's limit sits at spends[1], so the stocks' limits start at spends[2]. Investing also needs
    /// the account's own switch (`TopUps.on`): anyone can register an approved grant, so the grant alone never turns it
    /// on.
    uint256 internal constant TOP_UPS = 1 << 255;
    /// `Plan.reason` of a batch that puts top-ups into the mix.
    uint8 internal constant INVEST = 1;

    /// What a planned rebalance carries to its batch.
    struct Batch {
        PM.Permission perm;
        Trade[] trades;
        uint32 day;
        uint256 invest; // USDC units withdrawn from savings for the buys, exactly their sum; 0 for band trades
    }

    // ================================================================== permission and settings

    /// The template the user approved: with top-ups, Aave V3's withdraw first; approve each stock it may sell to
    /// Aerodrome's router, approve USDC for the buys, swap. Limits a week each: the grant's cap on USDC (the buy leg)
    /// and, with top-ups, on aUSDC, then each stock it may sell, in shares.
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
        uint256 f = terms & TOP_UPS != 0 ? 1 : 0;
        uint256 k;
        for (uint256 r; r < 7; ++r) {
            if (JobBase.stockLimit(terms, r) > 0) ++k;
        }
        p.calls = new PM.CallPermission[](f + k + 2);
        p.spends = new PM.SpendLimit[](f + k + 1);
        p.spends[0] = PM.SpendLimit(address(e.usdc), g.cap, PM.PeriodUnit.Week, 1);
        if (f == 1) {
            p.calls[0] = PM.CallPermission(address(e.aaveV3Pool), IAaveV3Pool.withdraw.selector, address(0));
            p.spends[1] = PM.SpendLimit(address(e.aUsdc), g.cap, PM.PeriodUnit.Week, 1);
        }
        uint256 j = f;
        for (uint256 r; r < 7; ++r) {
            uint256 limit = JobBase.stockLimit(terms, r);
            if (limit == 0) continue;
            p.calls[j] = PM.CallPermission(e.stocks[r], IERC20.approve.selector, address(0));
            p.spends[++j] = PM.SpendLimit(e.stocks[r], uint160(limit), PM.PeriodUnit.Week, 1);
        }
        p.calls[f + k] = PM.CallPermission(address(e.usdc), IERC20.approve.selector, address(0));
        p.calls[f + k + 1] = PM.CallPermission(e.router, IAeroRouter.exactInputSingle.selector, address(0));
    }

    /// The terms a granted permission carries: its stock limits (JobBase), after USDC's and, with top-ups, aUSDC's,
    /// whose limit at spends[1] sets TOP_UPS. The executor still rebuilds the template from them and compares it in full.
    function termsFrom(GooseExecutor.Env memory e, PM.Permission memory p) public pure returns (uint256) {
        bool topUps = p.spends.length > 1 && p.spends[1].token == address(e.aUsdc);
        return JobBase.stockTerms(e, p, topUps ? 2 : 1) | (topUps ? TOP_UPS : 0);
    }

    /// At least one stock it may sell, each within its registration bound (JobBase); the top-ups bit aside.
    function termsOk(GooseExecutor.Env memory e, uint256 terms) public view returns (bool) {
        return JobBase.stockTermsOk(e, terms & ~TOP_UPS);
    }

    /// The mix as the registry stores it. Reverts unless the weights add up to 100%, or are all 0 to clear it.
    function mixOf(uint16[7] calldata weights) external pure returns (uint256 mix) {
        bool ok;
        (mix, ok) = RebalanceRules.pack(weights);
        if (!ok) revert GooseExecutor.BadMix();
    }

    function checkLimits(RebalanceLimits memory l) public pure {
        if (!RebalanceRules.limitsOk(l)) revert GooseExecutor.OutOfBounds();
    }

    /// A change through the delay: within the bounds, and the swap floor and the pool gap no looser than `current`
    /// (decision, 2026-10-14). Checked when it is queued and again when it lands, so no change ever loosens what a
    /// user's swaps get against Aave's price.
    function checkChange(RebalanceLimits memory l, RebalanceLimits storage current) public view {
        checkLimits(l);
        if (l.floorBps > current.floorBps || l.poolGapBps > current.poolGapBps) revert GooseExecutor.OutOfBounds();
    }

    // ================================================================== plan and run

    /// What a run would do now: put top-ups into the mix, rebalance, prune a dead permission, or nothing.
    function plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(address => uint256) storage mixes,
        mapping(address => TopUps) storage topUps
    ) public view returns (GooseExecutor.Plan memory p) {
        (p,) = _plan(e, c, acc, mixes[c.account], topUps[c.account]);
    }

    /// Plans, then trades. The day counts as done once a batch is tried: one that can't meet its floors (a pool moved,
    /// or Aerodrome can't fill a swap at Aave's price less the floor) moves nothing, skips the day and keeps what's
    /// waiting. A batch that wouldn't fit in the gas left is deferred to the next run.
    function run(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        mapping(address => uint256) storage mixes,
        mapping(address => TopUps) storage topUps
    ) external returns (GooseExecutor.Plan memory p) {
        TopUps memory t = topUps[c.account];
        Batch memory b;
        (p, b) = _plan(e, c, acc, mixes[c.account], t);
        if (p.action != GooseExecutor.Action.Rebalance) return p;
        if (gasleft() < REBALANCE_GAS + CHECKS_GAS) {
            p.action = GooseExecutor.Action.Defer;
            return p;
        }
        acc.rebalanceDay = b.day;
        _rebalance(e, c.account, b, t, topUps);
    }

    /// The batch, under the post-checks. One the manager can't run (a swap below its floor) moves nothing. With top-ups
    /// on, what it put in comes out of what's ready, and what it left in the wallet is the agents' own change (P1).
    function _rebalance(
        GooseExecutor.Env memory e,
        address account,
        Batch memory b,
        TopUps memory t,
        mapping(address => TopUps) storage topUps
    ) internal {
        Before memory before = snapshot(e, account, b.trades, b.invest);
        try e.manager.executeBatch{gas: REBALANCE_GAS}(b.perm, _calls(e, account, b.trades, b.invest)) {}
        catch {
            emit GooseExecutor.RebalanceSkipped(account);
            return;
        }
        (uint256[7] memory sold, uint256[7] memory bought) = check(e, account, before);
        if (t.on) {
            if (b.invest > 0) CashRules.topUpInvested(t, b.invest, e.aUsdc.balanceOf(account));
            t.own += e.usdc.balanceOf(account) - before.cash; // never lower: `check`
            topUps[account] = t;
        }
        if (b.invest > 0) emit GooseExecutor.TopUpInvested(account, b.invest, bought);
        else emit GooseExecutor.Rebalanced(account, sold, bought);
    }

    /// The window and the day first, then the Act gate. With top-ups on, both by the account and in the grant, what's
    /// ready goes in when it's at least the smallest trade; otherwise the band trades. `t` comes back as the plan read
    /// it: rolled, any fall taken out, within savings above Keep.
    function _plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage acc,
        uint256 mix,
        TopUps memory t
    ) internal view returns (GooseExecutor.Plan memory p, Batch memory b) {
        p.job = GooseExecutor.Job.Rebalance;
        p.hf = c.hf;
        if (mix == 0 || c.frozen) return (p, b); // no mix, or prices are held today
        bool open;
        (open, b.day) = _window();
        if (!open || acc.rebalanceDay == b.day) return (p, b);
        if (p.hf == 0) p.hf = JobBase.health(e, c.account);
        if (p.hf < ACT_HF) return (p, b); // wait while the credit is in Act

        b.perm = permission(e, c.account, c.grant, c.salt, c.terms);
        RebalanceBook memory book = _book(e, c, b.perm, mix);
        if (t.on && c.terms & TOP_UPS != 0) {
            uint256 invest = _investable(e, c.account, b.perm, t, b.day, book.usdcLeft);
            if (invest >= c.rebalanceLimits.minTrade) {
                b.trades = RebalanceRules.invest(book, invest, c.rebalanceLimits);
                b.invest = _spent(b.trades);
            }
        }
        if (b.trades.length == 0) b.trades = RebalanceRules.trades(book, c.rebalanceLimits);
        if (b.trades.length == 0) return (p, b);
        // A stock it would trade can't be traded now: it waits, top-ups included.
        if (!_tradable(e, book, b.trades, c.rebalanceLimits.poolGapBps)) return (p, b);
        (bool alive, GooseExecutor.OffReason off) = JobBase.alive(e.manager, b.perm);
        if (!alive) {
            p.action = GooseExecutor.Action.Prune;
            p.off = off;
            return (p, b);
        }
        p.action = GooseExecutor.Action.Rebalance;
        p.amount = _spent(b.trades);
        if (b.invest > 0) p.reason = INVEST;
    }

    /// What may go into the mix now: what's ready (CashRules.topUpsReady, within savings above Keep), within what the
    /// grant's USDC and aUSDC limits leave, the latter less Aave's rounding, which the manager charges on aUSDC.
    function _investable(
        GooseExecutor.Env memory e,
        address account,
        PM.Permission memory perm,
        TopUps memory t,
        uint256 day,
        uint256 usdcLeft
    ) internal view returns (uint256 invest) {
        invest = CashRules.topUpsReady(t, day, e.aUsdc.balanceOf(account));
        uint256 savingsLeft = JobBase.capLeft(e.manager, perm, 1);
        savingsLeft = savingsLeft > JobBase.SAVINGS_ROUNDING ? savingsLeft - JobBase.SAVINGS_ROUNDING : 0;
        if (invest > savingsLeft) invest = savingsLeft;
        if (invest > usdcLeft) invest = usdcLeft;
    }

    /// Whether it is 30 to 60 minutes after the open in New York, and the New York day.
    function _window() internal view returns (bool open, uint32 day) {
        uint256 local = block.timestamp - NyCalendar.offset(block.timestamp);
        day = uint32(local / 1 days);
        open = local % 1 days >= FROM && local % 1 days < UNTIL;
    }

    /// What the buys spend, in USDC units.
    function _spent(Trade[] memory trades) internal pure returns (uint256 usdcIn) {
        for (uint256 i; i < trades.length; ++i) {
            if (trades[i].buy) usdcIn += trades[i].amountIn;
        }
    }

    /// The mix's free stock at Aave's prices, and what the grant's limits leave this period. Only a stock above its
    /// target can be sold, so only those pay for the limit read. The stock limits follow USDC's, and aUSDC's with
    /// top-ups.
    function _book(GooseExecutor.Env memory e, GooseExecutor.Ctx memory c, PM.Permission memory perm, uint256 mix)
        internal
        view
        returns (RebalanceBook memory book)
    {
        uint256 total;
        for (uint256 r; r < 7; ++r) {
            uint256 w = RebalanceRules.weight(mix, r);
            if (w == 0) continue;
            book.stocks[r].weight = w;
            book.stocks[r].shares = IERC20(e.stocks[r]).balanceOf(c.account);
            book.stocks[r].price = e.oracle.getReservePrice(r);
            total += book.stocks[r].shares * book.stocks[r].price / 1e10;
        }
        uint256 spend = c.terms & TOP_UPS != 0 ? 2 : 1;
        for (uint256 r; r < 7; ++r) {
            if (JobBase.stockLimit(c.terms, r) == 0) continue;
            uint256 value = book.stocks[r].shares * book.stocks[r].price / 1e10;
            if (book.stocks[r].weight > 0 && value * RebalanceRules.WHOLE > total * book.stocks[r].weight) {
                book.stocks[r].sellLeft = JobBase.capLeft(e.manager, perm, spend);
            }
            ++spend;
        }
        book.usdcLeft = JobBase.capLeft(e.manager, perm, 0);
    }

    /// Every stock the trades touch can be traded now: its reserve isn't paused (a corporate action holds its price)
    /// and its pool's price is within `gapBps` of Aave's.
    function _tradable(GooseExecutor.Env memory e, RebalanceBook memory book, Trade[] memory trades, uint256 gapBps)
        internal
        view
        returns (bool)
    {
        for (uint256 i; i < trades.length; ++i) {
            uint256 r = trades[i].reserveId;
            if (e.spoke.getReserve(r).flags & JobBase.PAUSED != 0) return false;
            // No pool reads as a price of 0, which is never in line.
            if (!RebalanceRules.poolInLine(JobBase.poolPrice(e, r), book.stocks[r].price, gapBps)) return false;
        }
        return true;
    }

    // ================================================================== the batch

    /// With top-ups, the exact `invest` out of savings to the account first, never all of it. Then approvals for the
    /// whole batch, the sales, then the buys, which spend exactly what the sales' minimums bring in, or the invest.
    /// Every swap goes to the account, with Aave's price less the floor as its minimum.
    function _calls(GooseExecutor.Env memory e, address account, Trade[] memory trades, uint256 invest)
        internal
        view
        returns (PM.Call[] memory calls)
    {
        uint256 sells;
        for (uint256 i; i < trades.length; ++i) {
            if (!trades[i].buy) ++sells;
        }
        uint256 usdcIn = _spent(trades);
        uint256 n = invest > 0 ? 1 : 0;
        calls = new PM.Call[](n + sells + (usdcIn > 0 ? 1 : 0) + trades.length);
        if (n == 1) {
            calls[0] = PM.Call(
                address(e.aaveV3Pool), 0, abi.encodeCall(IAaveV3Pool.withdraw, (address(e.usdc), invest, account))
            );
        }
        for (uint256 i; i < trades.length; ++i) {
            if (trades[i].buy) continue;
            calls[n++] = PM.Call(
                e.stocks[trades[i].reserveId], 0, abi.encodeCall(IERC20.approve, (e.router, trades[i].amountIn))
            );
        }
        if (usdcIn > 0) calls[n++] = PM.Call(address(e.usdc), 0, abi.encodeCall(IERC20.approve, (e.router, usdcIn)));
        for (uint256 i; i < trades.length; ++i) {
            calls[n++] = _swap(e, account, trades[i]);
        }
    }

    function _swap(GooseExecutor.Env memory e, address account, Trade memory t) internal view returns (PM.Call memory) {
        address stock = e.stocks[t.reserveId];
        IAeroRouter.ExactInputSingleParams memory swap = IAeroRouter.ExactInputSingleParams({
            tokenIn: t.buy ? address(e.usdc) : stock,
            tokenOut: t.buy ? stock : address(e.usdc),
            tickSpacing: JobBase.STOCK_TICK_SPACING,
            recipient: account,
            deadline: block.timestamp,
            amountIn: t.amountIn,
            amountOutMinimum: t.minOut,
            sqrtPriceLimitX96: 0
        });
        return PM.Call(e.router, 0, abi.encodeCall(IAeroRouter.exactInputSingle, (swap)));
    }

    /// What a rebalance's post-checks compare with.
    struct Before {
        Trade[] trades;
        uint256 invest; // USDC units the batch takes out of savings for the buys; 0 for band trades
        uint256 cash;
        uint256 savings;
        uint256[7] wallet; // the account's stock balances
        uint256[7] backing; // what backs the credit
        uint256[7] mine; // the executor's stock balances
    }

    function snapshot(GooseExecutor.Env memory e, address account, Trade[] memory trades, uint256 invest)
        public
        view
        returns (Before memory b)
    {
        b.trades = trades;
        b.invest = invest;
        b.cash = e.usdc.balanceOf(account);
        b.savings = e.aUsdc.balanceOf(account);
        for (uint256 r; r < 7; ++r) {
            b.wallet[r] = IERC20(e.stocks[r]).balanceOf(account);
            b.backing[r] = e.spoke.getUserSuppliedAssets(r, account);
            b.mine[r] = IERC20(e.stocks[r]).balanceOf(address(this));
        }
    }

    /// A rebalance's post-checks: each stock sold fell by exactly its sale and each stock bought rose by at least its
    /// minimum, so only mix stocks were bought and every other balance stayed put; nothing that backs the credit moved;
    /// the executor holds none of the stock. Band trades: savings didn't move, and the wallet's USDC rose by at least
    /// what the sales' minimums bring in less what the buys spent, so it never went down. Top-ups: the batch only buys,
    /// for exactly the invest; savings fell by at most the invest and Aave's rounding, and the wallet's USDC with what
    /// the buys spent is at least what it was plus the invest, so the buys spent the invest and nothing else. Returns
    /// the shares sold and bought.
    function check(GooseExecutor.Env memory e, address account, Before memory b)
        public
        view
        returns (uint256[7] memory sold, uint256[7] memory bought)
    {
        uint256[7] memory sell;
        uint256[7] memory buyMin;
        bool[7] memory buy;
        uint256 cashIn;
        uint256 cashOut;
        bool sells;
        for (uint256 i; i < b.trades.length; ++i) {
            Trade memory t = b.trades[i];
            if (t.buy) {
                buy[t.reserveId] = true;
                buyMin[t.reserveId] = t.minOut;
                cashOut += t.amountIn;
            } else {
                sell[t.reserveId] = t.amountIn;
                cashIn += t.minOut;
                sells = true;
            }
        }
        if (b.invest > 0 && (sells || cashOut != b.invest)) revert GooseExecutor.WrongAmount();
        for (uint256 r; r < 7; ++r) {
            uint256 wallet = IERC20(e.stocks[r]).balanceOf(account);
            if (buy[r]) {
                if (wallet < b.wallet[r] + buyMin[r]) revert GooseExecutor.StockMoved();
                bought[r] = wallet - b.wallet[r];
            } else if (wallet + sell[r] != b.wallet[r]) {
                revert GooseExecutor.StockMoved();
            }
            sold[r] = sell[r];
            if (e.spoke.getUserSuppliedAssets(r, account) != b.backing[r]) revert GooseExecutor.BackingMoved();
            if (IERC20(e.stocks[r]).balanceOf(address(this)) > b.mine[r]) revert GooseExecutor.ExecutorGotFunds();
        }
        uint256 rounding = b.invest > 0 ? JobBase.SAVINGS_ROUNDING : 0;
        if (e.aUsdc.balanceOf(account) + b.invest + rounding < b.savings) revert GooseExecutor.SavingsMoved();
        cashIn += b.invest;
        if (cashOut > cashIn || e.usdc.balanceOf(account) + cashOut < b.cash + cashIn) {
            revert GooseExecutor.CashLower();
        }
    }
}
