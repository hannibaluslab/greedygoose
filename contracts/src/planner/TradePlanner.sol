// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IERC20} from "../IProtocols.sol";
import {RebalanceBook, RebalanceHolding, RebalanceLimits, RebalanceRules, Trade} from "../RebalanceRules.sol";
import {IGooseGuard, PlanBase} from "./PlanBase.sol";

/// @title TradePlanner
/// @notice GoosePlanner's Rebalance part (spec-final-v2.md §10, phase 3): one account's TRADE, a top-up into the mix
///         or the band trades, sized the way GooseGuard will check them on live reads. A stateless view; GoosePlanner
///         calls it in a try.
contract TradePlanner is PlanBase {
    /// Rebalance bands (config/risk.ts REBALANCER): 20% of a stock's target, at most 5 points of the mix.
    uint16 public constant BAND_OF_TARGET_BPS = 2_000;
    uint16 public constant BAND_MAX_BPS = 500;
    uint64 public constant REBALANCE_MAX_SLICE = 25_000e6;
    /// Band trades wait while the credit's health is under this, as today's Rebalancer does (RebalanceJob.ACT_HF): a
    /// trade never touches backing, but Protect may be about to need the attention. The Guard gates only top-ups.
    uint256 public constant ACT_HF = 1.1e18;

    constructor(IGooseGuard guard) PlanBase(guard) {}

    /// The account's TRADE, if any; none while the Guard is paused. `walletUsed` is wallet USDC a Protect repay this
    /// round takes first.
    function planTrade(address a, uint256 walletUsed) external view returns (Move[] memory moves) {
        moves = new Move[](1);
        if (GUARD.paused()) return _trim(moves, 0);
        Ctx memory c = _ctx(a);
        c.walletUsed = walletUsed;
        _trim(moves, c.jobs & (1 << JOB_REBALANCE) != 0 ? _tradeMove(c, moves, 0) : 0);
    }

    /// The Rebalancer's numbers: the bands, the Guard's tight band side as the pool gap, the Guard's swap floor, no
    /// minimum trade.
    function limits() public view returns (RebalanceLimits memory) {
        return RebalanceLimits({
            bandBps: BAND_OF_TARGET_BPS,
            bandMaxBps: BAND_MAX_BPS,
            poolGapBps: uint16(TIGHT_BPS),
            floorBps: uint16(SWAP_FLOOR_BPS),
            minTrade: 0,
            maxSlice: REBALANCE_MAX_SLICE
        });
    }

    // ================================================================== Rebalance and top-ups

    /// TRADE: a top-up into the mix when the wallet rule allows one (buys only), otherwise the band trades when the
    /// pacing allows a sale. Each leg is held to its pool's depth inside the swap floor, a stock whose pool sits off
    /// the Guard's band is left out, and a leg whose floor rounds to 0 is dropped. No other minimum. Sales come before
    /// buys, and the buys spend at most the sales' floors, as the Guard checks them in order.
    function _tradeMove(Ctx memory c, Move[] memory moves, uint256 n) internal view returns (uint256) {
        if (c.mix == 0) return n;
        RebalanceBook memory b;
        b.usdcLeft = type(uint128).max;
        for (uint256 r; r < 7; ++r) {
            uint256 w = RebalanceRules.weight(c.mix, r);
            if (w == 0) continue;
            RebalanceHolding memory h = b.stocks[r];
            h.weight = w;
            h.price = ORACLE.getReservePrice(r);
            if (h.price == 0) return n; // the Guard can't value the book
            h.shares = IERC20(stock(r)).balanceOf(c.a);
            h.sellLeft = h.shares; // the first pass is unbounded
        }
        uint256 invest = c.topUpsOn && !c.rescuing ? _topUpRoom(c.a, c.keep, c.walletUsed) : 0;
        if (invest > 0) _health(c); // Aave's account read is costly: only when a top-up or a trade is in view
        if (invest > 0 && (c.debt == 0 || c.hf >= _max(INVEST_HF, c.line))) {
            PM.Permission memory g = _permission(c.a, JOB_REBALANCE);
            if (!_aliveP(c.a, JOB_REBALANCE, g)) return n;
            invest = _min(invest, _spendLeft(g, address(USDC)));
            if (invest == 0) return n;
            return _push(moves, n, c.a, invest, _fit(RebalanceRules.invest(b, invest, limits()), b));
        }
        // Band trades sell, so the pacing applies: a new session (a new mix, or 20 hours since the last one opened),
        // or the hour of the one under way.
        bool open = c.mixSetAt > c.sessionAt || block.timestamp >= uint256(c.sessionAt) + REBALANCE_GAP;
        if (!open && block.timestamp >= uint256(c.sessionAt) + REBALANCE_SESSION) return n;
        // First unbounded, to see which stocks would be sold; then each sale held to its pool and its grant.
        Trade[] memory t = RebalanceRules.trades(b, limits());
        if (t.length == 0) return n;
        if (c.line == 0) _health(c);
        if (c.debt > 0 && c.hf < ACT_HF) return n;
        PM.Permission memory p = _permission(c.a, JOB_REBALANCE);
        if (!_aliveP(c.a, JOB_REBALANCE, p)) return n;
        uint256[7] memory left; // only the stocks the first pass sold, each held to its pool and grant
        for (uint256 i; i < t.length; ++i) {
            if (t[i].buy) continue;
            uint256 r = t[i].reserveId;
            RebalanceHolding memory h = b.stocks[r];
            if (!_lists(p, stock(r), APPROVE) || !_bandOk(r, h.price, false)) continue;
            left[r] = _min(stockDepth(r, h.price, false, SWAP_FLOOR_BPS, t[i].amountIn), _spendLeft(p, stock(r)));
        }
        for (uint256 r; r < 7; ++r) {
            b.stocks[r].sellLeft = left[r];
        }
        t = _fit(RebalanceRules.trades(b, limits()), b);
        uint256 floors; // the sales' floors, as the Guard adds them up
        uint256 buys;
        for (uint256 i; i < t.length; ++i) {
            if (t[i].amountIn == 0) continue;
            if (t[i].buy) buys += t[i].amountIn;
            else floors += t[i].amountIn * b.stocks[t[i].reserveId].price * (1e4 - SWAP_FLOOR_BPS) / 1e14;
        }
        if (floors == 0 || buys == 0) return n; // the Rebalancer never sells to cash
        // _fit can shrink or drop a buy after sizing: the Guard refuses buys that leave more than 10 units of the
        // sales' floors unspent (SellsToCash), so such a move isn't planned.
        if (buys + 10 < floors) return n;
        if (buys > _spendLeft(p, address(USDC))) return n; // the manager would refuse the buys
        return _push(moves, n, c.a, 0, t);
    }

    /// Each buy held to its pool's depth inside the swap floor and to the Guard's band; a buy that can't go, or whose
    /// floor rounds to 0, becomes 0. A sale whose floor rounds to 0 becomes 0 too.
    function _fit(Trade[] memory t, RebalanceBook memory b) internal view returns (Trade[] memory) {
        for (uint256 i; i < t.length; ++i) {
            uint256 r = t[i].reserveId;
            uint256 price = b.stocks[r].price;
            if (t[i].buy) {
                if (!_bandOk(r, price, true)) {
                    t[i].amountIn = 0;
                    continue;
                }
                t[i].amountIn = stockDepth(r, price, true, SWAP_FLOOR_BPS, t[i].amountIn);
                if (t[i].amountIn * 1e10 * (1e4 - SWAP_FLOOR_BPS) / (price * 1e4) == 0) t[i].amountIn = 0;
            } else if (t[i].amountIn * price * (1e4 - SWAP_FLOOR_BPS) / 1e14 == 0) {
                t[i].amountIn = 0;
            }
        }
        return t;
    }

    /// TRADE [invest, r << 248 | isBuy << 247 | amount, …] with the legs that aren't 0, in the rules' order (sales,
    /// then buys); nothing when none is left.
    function _push(Move[] memory moves, uint256 n, address a, uint256 invest, Trade[] memory t)
        internal
        pure
        returns (uint256)
    {
        uint256 legs;
        for (uint256 i; i < t.length; ++i) {
            if (t[i].amountIn > 0) ++legs;
        }
        if (legs == 0) return n;
        uint256[] memory args = new uint256[](legs + 1);
        args[0] = invest;
        uint256 j = 1;
        for (uint256 i; i < t.length; ++i) {
            if (t[i].amountIn == 0) continue;
            args[j++] = uint256(t[i].reserveId) << 248 | (t[i].buy ? uint256(1) << 247 : 0) | t[i].amountIn;
        }
        moves[n++] = _move(a, TRADE, args);
        return n;
    }

    /// The Guard's Rebalance band (spec §4.0): within BAND_BPS of Aave's price on the favourable side, within
    /// TIGHT_BPS on the losing one.
    function _bandOk(uint256 r, uint256 price, bool buy) internal view returns (bool) {
        uint256 p = poolPrice(r) * 1e4;
        if (buy) return p >= price * (1e4 - BAND_BPS) && p <= price * (1e4 + TIGHT_BPS);
        return p >= price * (1e4 - TIGHT_BPS) && p <= price * (1e4 + BAND_BPS);
    }
}
