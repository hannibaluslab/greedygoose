// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The Rebalancer's numbers. BPS, and USDC units (1e6 = $1) at Aave's price. GooseExecutor holds them within hard
/// bounds (D18, `limitsOk`); a change waits the public delay.
struct RebalanceLimits {
    uint16 bandBps; // a stock breaks its band past the smaller of this share of its target…
    uint16 bandMaxBps; // …and this many points of the mix
    uint16 poolGapBps; // a pool further than this from Aave's price holds the rebalance
    uint16 floorBps; // most a swap may get under Aave's price
    uint64 minTrade; // smallest trade worth making
    uint64 maxSlice; // largest swap
}

/// One stock, by reserve id.
struct RebalanceHolding {
    uint256 shares; // raw shares in the wallet: free stock, not backing the credit
    uint256 price; // Aave's oracle price, 8 decimals
    uint256 weight; // target weight in BPS; 0 = not in the mix, never traded
    uint256 sellLeft; // raw shares the grant's sell limit still allows this period; 0 = can't be sold
}

/// What the rule reads for one account.
struct RebalanceBook {
    RebalanceHolding[7] stocks;
    uint256 usdcLeft; // USDC units the grant's limit on the buy leg still allows this period
}

/// One swap. A sale swaps `amountIn` raw shares for at least `minOut` USDC units; a buy swaps `amountIn` USDC units for
/// at least `minOut` raw shares.
struct Trade {
    uint8 reserveId;
    bool buy;
    uint256 amountIn;
    uint256 minOut;
}

/// @title RebalanceRules
/// @notice The Rebalancer's rules, ported from the TypeScript reference line for line: the band trades from
///         lib/agents/rules/rebalance.ts and the top-ups' buys from lib/agents/rules/topUps.ts. test/RebalanceRules.t.sol
///         runs both on the vectors scripts/agent-vectors.ts exports, and they must agree exactly.
/// @dev Integer maths only. Shares and prices with 8 decimals, USDC units with 6, weights in BPS. A holding is worth
///      shares × price / 1e10 USDC units at Aave's price.
library RebalanceRules {
    uint256 internal constant BPS = 1e4;
    /// The mix's weights add up to this.
    uint256 internal constant WHOLE = 1e4;

    // Hard bounds (D18). Nothing can change them.
    uint16 internal constant BAND_BPS_MIN = 500;
    uint16 internal constant BAND_BPS_MAX = 5_000;
    uint16 internal constant BAND_MAX_BPS_MIN = 100;
    uint16 internal constant BAND_MAX_BPS_MAX = 2_000;
    uint16 internal constant POOL_GAP_BPS_MIN = 10;
    uint16 internal constant POOL_GAP_BPS_MAX = 200;
    uint16 internal constant FLOOR_BPS_MIN = 10;
    uint16 internal constant FLOOR_BPS_MAX = 300;
    uint64 internal constant MIN_TRADE_MIN = 1e6;
    uint64 internal constant MIN_TRADE_MAX = 1_000e6;
    uint64 internal constant MAX_SLICE_MIN = 100e6;
    uint64 internal constant MAX_SLICE_MAX = 50_000e6;

    function limitsOk(RebalanceLimits memory l) internal pure returns (bool) {
        return l.bandBps >= BAND_BPS_MIN && l.bandBps <= BAND_BPS_MAX && l.bandMaxBps >= BAND_MAX_BPS_MIN
            && l.bandMaxBps <= BAND_MAX_BPS_MAX && l.poolGapBps >= POOL_GAP_BPS_MIN && l.poolGapBps <= POOL_GAP_BPS_MAX
            && l.floorBps >= FLOOR_BPS_MIN && l.floorBps <= FLOOR_BPS_MAX && l.minTrade >= MIN_TRADE_MIN
            && l.minTrade <= MIN_TRADE_MAX && l.maxSlice >= MAX_SLICE_MIN && l.maxSlice <= MAX_SLICE_MAX
            && l.minTrade <= l.maxSlice;
    }

    /// The trades that bring the mix back (rebalanceTrades). A stock breaks its band when it sits further from its
    /// target than the smaller of `bandBps` of the target and `bandMaxBps` points; it is traded back to half the band,
    /// and only it. The other side of the trade goes to the stocks still in their band that are furthest from their
    /// target (to their target, no further), so the sales and the buys match at Aave's price. Each trade is held to
    /// `maxSlice`, a sale to the stock's sell limit, the buys to the grant's USDC limit; trades under `minTrade`
    /// are skipped, and the other side shrinks to match. Nothing to sell or nothing to buy means no trade: the
    /// Rebalancer never sells to cash or buys with it. Sales come first; the buys spend exactly what the sales'
    /// minimums bring in, so the wallet's USDC is never lower.
    function trades(RebalanceBook memory b, RebalanceLimits memory l) internal pure returns (Trade[] memory) {
        Legs memory g;
        uint256 total;
        for (uint256 i; i < 7; ++i) {
            if (b.stocks[i].weight > 0) total += _value(b.stocks[i]);
        }
        if (total == 0) return new Trade[](0);
        if (!_primary(b, l, g, total)) return new Trade[](0);
        _otherSide(l.minTrade, g);
        if (!_match(g, l.minTrade, b.usdcLeft)) return new Trade[](0);
        return _swaps(b, l.floorBps, g);
    }

    /// Top-ups into the mix (investTrades): `amount` USDC units from savings buy the mix's stocks, the one furthest below
    /// its target first, each target taken against the mix with the top-up in (`total + amount`), ties to the lower
    /// reserve id. Each buy is at least `minTrade`, at most `maxSlice` and never past its target, so a mix on target buys
    /// pro rata. It never sells. The buys spend exactly their `amountIn`, and what they leave of `amount` waits for the
    /// next check, so the invest is their sum.
    function invest(RebalanceBook memory b, uint256 amount, RebalanceLimits memory l)
        internal
        pure
        returns (Trade[] memory out)
    {
        uint256 total = amount;
        for (uint256 i; i < 7; ++i) {
            if (b.stocks[i].weight > 0) total += _value(b.stocks[i]);
        }
        uint256[7] memory gap;
        bool[7] memory mix;
        for (uint256 i; i < 7; ++i) {
            RebalanceHolding memory h = b.stocks[i];
            if (h.weight == 0) continue;
            mix[i] = true;
            uint256 target = total * h.weight / BPS;
            uint256 value = _value(h);
            if (target > value) gap[i] = target - value;
        }
        (uint8[7] memory o, uint256 n) = _byGap(gap, mix);
        uint256[7] memory buy;
        uint256 count;
        for (uint256 k; k < n && amount > 0; ++k) {
            uint8 i = o[k];
            uint256 leg = _min(amount, _min(gap[i], l.maxSlice));
            if (leg < l.minTrade) continue;
            buy[i] = leg;
            amount -= leg;
            ++count;
        }
        out = new Trade[](count);
        count = 0;
        for (uint8 i; i < 7; ++i) {
            if (buy[i] > 0) out[count++] = _buy(i, buy[i], b.stocks[i].price, l.floorBps);
        }
    }

    /// Whether a pool's price sits within `gapBps` of Aave's (poolInLine). Both prices with 8 decimals.
    function poolInLine(uint256 poolPrice, uint256 aavePrice, uint256 gapBps) internal pure returns (bool) {
        uint256 gap = poolPrice > aavePrice ? poolPrice - aavePrice : aavePrice - poolPrice;
        return gap * BPS <= gapBps * aavePrice;
    }

    /// The mix as stored in the registry: each weight in BPS, 16 bits a stock by reserve id. `ok` when they add up to
    /// WHOLE, or are all 0 to clear the mix.
    function pack(uint16[7] memory weights) internal pure returns (uint256 mix, bool ok) {
        uint256 sum;
        for (uint256 r; r < 7; ++r) {
            sum += weights[r];
            mix |= uint256(weights[r]) << (16 * r);
        }
        ok = sum == WHOLE || sum == 0;
    }

    function weight(uint256 mix, uint256 r) internal pure returns (uint256) {
        return mix >> (16 * r) & type(uint16).max;
    }

    // ================================================================== steps

    /// What `trades` keeps track of: the legs at Aave's price, by reserve id, and the stocks still in their band.
    struct Legs {
        uint256[7] sell;
        uint256[7] buy;
        uint256[7] sellable; // the most a sale may be: the sell limit left, and maxSlice
        uint256[7] above; // in its band: how far above target
        uint256[7] below; // in its band: how far below target
        bool[7] inBand;
        uint256 maxSlice;
    }

    /// The legs that bring each broken-out stock back to half its band. False if no stock broke out.
    function _primary(RebalanceBook memory b, RebalanceLimits memory l, Legs memory g, uint256 total)
        private
        pure
        returns (bool any)
    {
        g.maxSlice = l.maxSlice;
        for (uint256 i; i < 7; ++i) {
            RebalanceHolding memory h = b.stocks[i];
            if (h.weight == 0) continue;
            g.sellable[i] = _min(h.sellLeft * h.price / 1e10, l.maxSlice);
            uint256 value = _value(h);
            uint256 target = total * h.weight / BPS;
            uint256 band = total * _min(h.weight * l.bandBps / BPS, l.bandMaxBps) / BPS;
            if (value > target + band) {
                any = true;
                uint256 leg = _min(value - target - band / 2, g.sellable[i]);
                if (leg >= l.minTrade) g.sell[i] = leg;
            } else if (value + band < target) {
                any = true;
                uint256 leg = _min(target - band / 2 - value, l.maxSlice);
                if (leg >= l.minTrade) g.buy[i] = leg;
            } else {
                g.inBand[i] = true;
                if (value > target) g.above[i] = value - target;
                else g.below[i] = target - value;
            }
        }
    }

    /// The other side of the trade, from the stocks in their band furthest from target first (the fewest swaps).
    function _otherSide(uint256 minTrade, Legs memory g) private pure {
        uint256 sells = _sum(g.sell);
        uint256 buys = _sum(g.buy);
        bool buyMore = sells > buys;
        uint256 need = buyMore ? sells - buys : buys - sells;
        uint256[7] memory gap = buyMore ? g.below : g.above;
        (uint8[7] memory o, uint256 n) = _byGap(gap, g.inBand);
        for (uint256 k; k < n && need > 0; ++k) {
            uint8 i = o[k];
            uint256 leg = _min(need, _min(gap[i], buyMore ? g.maxSlice : g.sellable[i]));
            if (leg < minTrade) continue;
            if (buyMore) g.buy[i] = leg;
            else g.sell[i] = leg;
            need -= leg;
        }
    }

    /// The stocks in their band with a gap, largest gap first, ties to the lower reserve id.
    function _byGap(uint256[7] memory gap, bool[7] memory inBand) private pure returns (uint8[7] memory o, uint256 n) {
        for (uint8 i; i < 7; ++i) {
            if (!inBand[i] || gap[i] == 0) continue;
            uint256 k = n++;
            for (; k > 0 && gap[o[k - 1]] < gap[i]; --k) {
                o[k] = o[k - 1];
            }
            o[k] = i;
        }
    }

    /// Matches the sides within the USDC limit: the larger one shrinks, and a trade that falls under the minimum goes.
    /// False when nothing is left on one side.
    function _match(Legs memory g, uint256 minTrade, uint256 usdcLeft) private pure returns (bool) {
        bool dropped = true;
        while (dropped) {
            uint256 flow = _min(_min(_sum(g.sell), _sum(g.buy)), usdcLeft);
            if (flow == 0) return false;
            dropped = _shrink(g.sell, flow, minTrade);
            if (_shrink(g.buy, flow, minTrade)) dropped = true;
        }
        return true;
    }

    function _shrink(uint256[7] memory legs, uint256 flow, uint256 minTrade) private pure returns (bool dropped) {
        uint256 t = _sum(legs);
        if (t == flow) return false;
        for (uint256 i; i < 7; ++i) {
            legs[i] = legs[i] * flow / t;
            if (legs[i] > 0 && legs[i] < minTrade) {
                legs[i] = 0;
                dropped = true;
            }
        }
    }

    /// The swaps: sales at the floor, then buys that spend exactly what the sales' minimums bring in.
    function _swaps(RebalanceBook memory b, uint256 floorBps, Legs memory g) private pure returns (Trade[] memory out) {
        uint256 n;
        for (uint256 i; i < 7; ++i) {
            if (g.sell[i] > 0 || g.buy[i] > 0) ++n;
        }
        out = new Trade[](n);
        n = 0;
        uint256 budget;
        for (uint8 i; i < 7; ++i) {
            if (g.sell[i] == 0) continue;
            out[n] = _sale(i, g.sell[i], b.stocks[i].price, floorBps);
            budget += out[n++].minOut;
        }
        uint256 buys = _sum(g.buy);
        for (uint8 i; i < 7; ++i) {
            if (g.buy[i] > 0) out[n++] = _buy(i, g.buy[i] * budget / buys, b.stocks[i].price, floorBps);
        }
    }

    /// A sale of `value` USDC units of stock at Aave's price, for at least that less the floor.
    function _sale(uint8 i, uint256 value, uint256 price, uint256 floorBps) private pure returns (Trade memory) {
        uint256 shares = value * 1e10 / price;
        return Trade(i, false, shares, shares * price * (BPS - floorBps) / 1e14);
    }

    /// A buy spending `usdcIn`, for at least its value in shares at Aave's price less the floor.
    function _buy(uint8 i, uint256 usdcIn, uint256 price, uint256 floorBps) private pure returns (Trade memory) {
        return Trade(i, true, usdcIn, usdcIn * 1e10 * (BPS - floorBps) / (price * BPS));
    }

    function _value(RebalanceHolding memory h) private pure returns (uint256) {
        return h.shares * h.price / 1e10;
    }

    function _sum(uint256[7] memory v) private pure returns (uint256 s) {
        for (uint256 i; i < 7; ++i) {
            s += v[i];
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
