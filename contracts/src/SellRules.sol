// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Protect · sell's numbers. Health factors WAD, floors in BPS, USDC amounts in units (1e6 = $1). GooseExecutor holds
/// them within hard bounds (D18, `checkLimits`); a change waits the public delay.
struct SellLimits {
    uint64 headsUpHf; // below this on a weekday (the Act line): a heads-up, then a sale
    uint64 nowHf; // below this, deep in Act: a sale at once
    uint64 targetHf; // a sale brings the health back to this
    uint32 headsUpDelay; // seconds from the heads-up to the sale
    uint16 floorBps; // most a sale after a heads-up may get under Aave's price
    uint16 actFloorBps; // the same, for a sale at once (below nowHf)
    uint64 poolCap; // USDC, at Aave's price, all accounts may sell into one stock's pool per POOL_WINDOW
    uint64 maxSlice; // USDC, at Aave's price, per swap
}

/// One stock, by reserve id.
struct Holding {
    uint256 shares; // raw shares backing the credit; 0 when it doesn't, or only with a collateral factor of 0
    uint256 price; // Aave's oracle price, 8 decimals
    uint256 cf; // collateral factor in BPS, from the reserve's current config: a withdrawal applies it to the position
    uint256 limit; // raw shares today's limit still allows; 0 = not for sale (never-sell, used up, reserve paused)
    uint256 poolLeft; // USDC units, at Aave's price, the pool's window still allows across all accounts
}

/// What the rule reads for one account.
struct Book {
    Holding[7] stocks;
    uint256 debt; // Value owed, rounded up
    uint256 usdcPrice; // 8 decimals: a repay of 1 unit lowers the debt by usdcPrice × 1e12 Value
    uint256 usdcLeft; // USDC units today's limit still allows: the repay leg's limit
}

/// One withdraw → swap → repay step of the batch.
struct Slice {
    uint8 reserveId;
    uint256 shares;
    uint256 minOut; // USDC units: the swap's minimum output, and exactly what this slice repays
}

enum SellTiming {
    Wait,
    HeadsUp,
    Clear,
    Sell
}

/// @title SellRules
/// @notice Protect · sell's rule, ported from the TypeScript reference (lib/guardian/sell.ts) line for line:
///         test/SellRules.t.sol runs both on the vectors scripts/agent-vectors.ts exports, and they must agree exactly.
/// @dev Integer maths only. Units: Aave Value (1e26 = $1), WAD (1e18), prices and shares with 8 decimals, USDC units
///      with 6, collateral factors in BPS. A holding is worth shares × price × 1e10 Value and backs cf × that.
library SellRules {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 1e4;
    /// Collateral factors within one point of each other are a near-tie: the larger holding goes first.
    uint256 internal constant TIE_BPS = 100;
    /// Aave's spoke checks health ≥ 1.0 right after each withdrawal; a slice keeps it at least this high.
    uint256 internal constant WITHDRAW_FLOOR_HF = 1.001e18;
    /// Most slices in one run (one batch, within its gas cap). The rest waits for the next run.
    uint256 internal constant MAX_SLICES = 6;

    // Hard bounds (D18). Nothing can change them.
    /// Act is the line (Adrian, 2026-10-15): the heads-up line is the Act line (1.10, config/risk.ts RISK), the same as
    /// Protect's trigger (CashRules.TRIGGER_HF), and pinned there. No heads-up, and so no sale, in Watch; none of Act
    /// left without one; and never a sale line above the cash line, which would sell stock while cash sits in savings.
    uint64 internal constant HEADS_UP_HF = 1.1e18;
    /// A sale at once only deep in Act: 1.05 (halfway to Aave's limit at 1.0) at the lowest, so no change can hold
    /// the at-once sale back further.
    uint64 internal constant NOW_HF_MIN = 1.05e18;
    /// The heads-up keeps a band of its own above the at-once line, so a heads-up still goes out before most sales.
    uint64 internal constant NOW_GAP_MIN = 0.02e18;
    uint64 internal constant TARGET_GAP_MIN = 0.05e18;
    /// A sale brings the credit back to Watch, never past it: the target stays under the Safe line (1.50).
    uint64 internal constant TARGET_HF_MAX = 1.4e18;
    uint32 internal constant HEADS_UP_DELAY_MIN = 10 minutes;
    uint32 internal constant HEADS_UP_DELAY_MAX = 2 hours;
    uint16 internal constant FLOOR_BPS_MIN = 25;
    /// Under Aave's largest liquidation bonus (5.5%): Protect never pays more to avoid a liquidation than one costs.
    uint16 internal constant FLOOR_BPS_MAX = 500;
    uint64 internal constant POOL_CAP_MIN = 1_000e6;
    uint64 internal constant POOL_CAP_MAX = 250_000e6;
    uint64 internal constant MAX_SLICE_MIN = 100e6;
    uint64 internal constant MAX_SLICE_MAX = 50_000e6;

    function limitsOk(SellLimits memory l) internal pure returns (bool) {
        return l.headsUpHf == HEADS_UP_HF && l.nowHf >= NOW_HF_MIN && l.nowHf + NOW_GAP_MIN <= HEADS_UP_HF
            && l.targetHf >= HEADS_UP_HF + TARGET_GAP_MIN && l.targetHf <= TARGET_HF_MAX
            && l.headsUpDelay >= HEADS_UP_DELAY_MIN && l.headsUpDelay <= HEADS_UP_DELAY_MAX
            && l.floorBps >= FLOOR_BPS_MIN && l.actFloorBps >= l.floorBps && l.actFloorBps <= FLOOR_BPS_MAX
            && l.poolCap >= POOL_CAP_MIN && l.poolCap <= POOL_CAP_MAX && l.maxSlice >= MAX_SLICE_MIN
            && l.maxSlice <= MAX_SLICE_MAX;
    }

    /// When Protect sells (decision 3; Act is the line, 2026-10-15): below `headsUpHf` (the Act line) on a weekday a
    /// heads-up, then the sale `headsUpDelay` later if the health is still below; below `nowHf`, deep in Act, at once.
    /// Never in Safe or Watch, and never while prices are held (weekends and holidays). Back above `headsUpHf`, a
    /// pending heads-up is cleared, so a later fall gets a new one. `headsUpAt` is 0 when none is pending. `atOnce`
    /// sales use the wider Act floor.
    function timing(uint256 hf, uint256 headsUpAt, uint256 nowTs, bool frozen, SellLimits memory l)
        internal
        pure
        returns (SellTiming, bool atOnce)
    {
        if (hf >= l.headsUpHf) return (headsUpAt != 0 ? SellTiming.Clear : SellTiming.Wait, false);
        if (frozen) return (SellTiming.Wait, false);
        if (hf < l.nowHf) return (SellTiming.Sell, true);
        if (headsUpAt == 0) return (SellTiming.HeadsUp, false);
        return (nowTs >= headsUpAt + l.headsUpDelay ? SellTiming.Sell : SellTiming.Wait, false);
    }

    /// Sell order: lowest collateral factor first (the most safety per dollar sold), near-ties to the larger holding.
    function order(Holding[7] memory stocks) internal pure returns (uint8[7] memory o) {
        for (uint8 i; i < 7; ++i) {
            o[i] = i;
        }
        for (uint256 i = 1; i < 7; ++i) {
            for (uint256 j = i; j > 0 && _before(stocks[o[j]], stocks[o[j - 1]]); --j) {
                (o[j], o[j - 1]) = (o[j - 1], o[j]);
            }
        }
    }

    /// Backing power: Σ cf × value, in BPS · Value. Health = power × 1e14 / debt.
    function power(Holding[7] memory stocks) internal pure returns (uint256 p) {
        for (uint256 i; i < 7; ++i) {
            p += stocks[i].cf * stocks[i].shares * stocks[i].price * 1e10;
        }
    }

    /// The least stock to sell, per reserve id in raw shares, for the health to reach `targetHf` once the proceeds
    /// repay at the floor. Each stock is held to its backing, its daily limit, its pool's window and the USDC limit;
    /// what one can't cover spills over to the next in `order`.
    function amounts(Book memory b, uint256 targetHf, uint256 floorBps, bool keepMix)
        internal
        pure
        returns (uint256[7] memory take)
    {
        uint256 have = power(b.stocks) * 1e14;
        uint256 need = targetHf * b.debt;
        if (need <= have) return take;
        Run memory r;
        // Each slice's minimum output rounds down by under a unit of USDC: the slack covers every slice of the run.
        r.deficit = need - have + targetHf * b.usdcPrice * 1e12 * MAX_SLICES;
        r.usdcLeft = b.usdcLeft;
        r.keep = BPS - floorBps;
        // Health gained per raw share sold, × debt: the repay's weight at the target minus the backing given up.
        uint256 repay = targetHf * r.keep * b.usdcPrice / 100;
        for (uint256 i; i < 7; ++i) {
            Holding memory s = b.stocks[i];
            uint256 lost = s.cf * 1e24;
            if (s.shares > 0 && s.limit > 0 && s.cf > 0 && repay > lost) r.gainPer[i] = s.price * (repay - lost);
            r.poolLeft[i] = s.poolLeft;
        }

        uint8[7] memory o = order(b.stocks);
        if (keepMix) _sameShare(b, r, take, o);
        for (uint256 k; k < 7 && r.deficit > 0; ++k) {
            uint8 i = o[k];
            if (r.gainPer[i] > 0) _sell(b, r, take, i, _ceilDiv(r.deficit, r.gainPer[i]));
        }
    }

    /// Splits the amounts into withdraw → swap → repay slices, in `order`. Each withdrawal leaves the health at least
    /// WITHDRAW_FLOOR_HF (Aave reverts one that leaves it under 1.0), each swap stays within `maxSlice` USDC at Aave's
    /// price, and each repays exactly its minimum output. Stops at MAX_SLICES, or when Aave's floor leaves no room:
    /// the rest waits for the next run.
    function slices(Book memory b, uint256[7] memory take, uint256 floorBps, uint256 maxSlice)
        internal
        pure
        returns (Slice[] memory out)
    {
        out = new Slice[](MAX_SLICES);
        Cut memory c = Cut(power(b.stocks), b.debt, 0);
        uint8[7] memory o = order(b.stocks);
        for (uint256 k; k < 7; ++k) {
            uint256 left = take[o[k]];
            while (left > 0) {
                if (c.n == MAX_SLICES) return out;
                Slice memory s = _cut(b, c, o[k], left, floorBps, maxSlice);
                if (s.minOut == 0) return _trim(out, c.n);
                out[c.n++] = s;
                left -= s.shares;
            }
        }
        return _trim(out, c.n);
    }

    /// Where `slices` has got to: the backing power and the debt after the slices so far, and how many.
    struct Cut {
        uint256 power;
        uint256 debt;
        uint256 n;
    }

    /// The next slice of stock `i`, and the power and debt after it.
    function _cut(Book memory b, Cut memory c, uint8 i, uint256 left, uint256 floorBps, uint256 maxSlice)
        private
        pure
        returns (Slice memory s)
    {
        Holding memory h = b.stocks[i];
        uint256 room = c.power * 1e14 > WITHDRAW_FLOOR_HF * c.debt
            ? (c.power * 1e14 - WITHDRAW_FLOOR_HF * c.debt) / (h.cf * h.price * 1e24)
            : 0;
        s.reserveId = i;
        s.shares = _min(_min(left, room), maxSlice * 1e10 / h.price);
        s.minOut = s.shares * h.price * (BPS - floorBps) / 1e14;
        if (s.minOut == 0) return s;
        c.power -= h.cf * s.shares * h.price * 1e10;
        uint256 repaid = s.minOut * b.usdcPrice * 1e12;
        c.debt = repaid >= c.debt ? 0 : c.debt - repaid;
    }

    /// What `amounts` keeps track of while it sells.
    struct Run {
        uint256 deficit;
        uint256 usdcLeft;
        uint256 keep;
        uint256[7] gainPer;
        uint256[7] poolLeft;
    }

    /// "Keep my mix": the same share of every holding for sale, as far as each one's limits allow.
    function _sameShare(Book memory b, Run memory r, uint256[7] memory take, uint8[7] memory o) private pure {
        uint256 total;
        for (uint256 k; k < 7; ++k) {
            total += r.gainPer[o[k]] * b.stocks[o[k]].shares;
        }
        if (total == 0) return;
        uint256 q = _min(_ceilDiv(r.deficit * WAD, total), WAD); // the share to sell, WAD: at most all of it
        for (uint256 k; k < 7 && r.deficit > 0; ++k) {
            uint8 i = o[k];
            if (r.gainPer[i] > 0) _sell(b, r, take, i, _ceilDiv(q * b.stocks[i].shares, WAD));
        }
    }

    function _sell(Book memory b, Run memory r, uint256[7] memory take, uint8 i, uint256 want) private pure {
        Holding memory s = b.stocks[i];
        uint256 n = _min(_min(want, s.shares - take[i]), s.limit - take[i]);
        n = _min(_min(n, r.poolLeft[i] * 1e10 / s.price), r.usdcLeft * 1e14 / (s.price * r.keep));
        if (n == 0) return;
        take[i] += n;
        r.poolLeft[i] -= _ceilDiv(n * s.price, 1e10);
        r.usdcLeft -= _ceilDiv(n * s.price * r.keep, 1e14);
        uint256 gain = r.gainPer[i] * n;
        r.deficit = gain >= r.deficit ? 0 : r.deficit - gain;
    }

    function _before(Holding memory a, Holding memory b) private pure returns (bool) {
        uint256 gap = a.cf > b.cf ? a.cf - b.cf : b.cf - a.cf;
        if (gap <= TIE_BPS) return a.shares * a.price > b.shares * b.price;
        return a.cf < b.cf;
    }

    function _trim(Slice[] memory out, uint256 n) private pure returns (Slice[] memory) {
        assembly ("memory-safe") {
            mstore(out, n)
        }
        return out;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
