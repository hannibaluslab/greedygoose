// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {ISpoke} from "../IProtocols.sol";
import {CashRules, ProtectCase, Thresholds} from "../CashRules.sol";
import {Book, Holding, SellRules, Slice} from "../SellRules.sol";
import {IGooseGuard, PlanBase} from "./PlanBase.sol";

/// Aave V3's pool reads Protect sizes a repay from savings with (the draft's ProtectJob._savingsOut).
interface IAaveV3Liquidity {
    /// ReserveConfigurationMap: bit 56 active, 60 paused.
    function getConfiguration(address asset) external view returns (uint256);
    /// What the reserve can pay out now; a withdrawal above it reverts.
    function getVirtualUnderlyingBalance(address asset) external view returns (uint128);
}

/// @title ProtectPlanner
/// @notice GoosePlanner's Protect half (spec-final-v2.md §10, phase 2): one account's REPAY, SELL, REFRESH or END,
///         sized the way GooseGuard will check them on live reads. A stateless view; GoosePlanner calls it in a try.
contract ProtectPlanner is PlanBase {
    /// A planned sale: the book on the latest config and what the permission allows.
    struct Sale {
        bool ok; // the Sell agent is on and its permission is alive
        bool refreshable; // its permission lists Spoke.updateUserDynamicConfig
        uint256 latestHf; // health on each reserve's latest config
        Book book;
    }

    /// Spoke.updateUserDynamicConfig: REFRESH goes through the ProtectSell permission (step0-facts.md, fact 5).
    bytes4 internal constant REFRESH_CONFIG = 0x826002e2;
    /// A sale lands here past the target, half the overshoot margin, for a price move between the read and the write.
    uint256 public constant SELL_MARGIN = 0.005e18;
    /// Each slice's withdraw keeps health at least this on the latest config, so one 0.5% oracle update between the
    /// read and the write can't sink the first slice (SellRules uses 1.001: protect.md trap 4). An account already
    /// under 1.02 gets half its room above 1.0 instead, never less than SellRules' 1.001: a 1.01 floor would leave an
    /// account at 1.008 no first slice at all, and so no sale. See `withdrawFloor`.
    uint256 public constant WITHDRAW_FLOOR_HF = 1.01e18;
    uint256 public constant WITHDRAW_FLOOR_MIN = 1.001e18;
    uint256 public constant MAX_SLICES = 6;
    uint256 public constant SELL_MAX_SLICE = 5_000e6;
    /// A collateral-factor raise counts when the latest-config health is this far above the stored one.
    uint256 public constant RAISE_GAP = 0.001e18;

    constructor(IGooseGuard guard) PlanBase(guard) {}

    /// The account's Protect moves, in the order the Guard should run them: REPAY then SELL, or REFRESH, or END.
    function planProtect(address a) external view returns (Move[] memory moves) {
        moves = new Move[](2);
        Ctx memory c = _ctx(a);
        ISpoke.UserAccountData memory d = _health(c);
        _trim(moves, _protectMoves(c, d, moves, 0));
    }

    /// REPAY then SELL while Protect may act; REFRESH after a factor raise; END for a finished or expired rescue.
    function _protectMoves(Ctx memory c, ISpoke.UserAccountData memory d, Move[] memory moves, uint256 n)
        internal
        view
        returns (uint256)
    {
        bool protectOn = c.jobs & (1 << JOB_PROTECT) != 0;
        bool sellOn = c.jobs & (1 << JOB_SELL) != 0;
        if (!protectOn && !sellOn && c.rescueAt == 0) return n;
        if (c.debt == 0) {
            if (c.rescueAt != 0) moves[n++] = _move(c.a, END, new uint256[](0));
            return n;
        }
        // The Guard's gate: under the line, or in a rescue under the target.
        bool gate = c.hf < c.line || (c.rescuing && c.hf + DONE_GAP < c.target);
        if (!gate || (!protectOn && !sellOn)) {
            if (c.rescueAt != 0 && (!c.rescuing || c.hf + DONE_GAP >= c.target)) {
                moves[n++] = _move(c.a, END, new uint256[](0));
            }
            return n;
        }
        // Aave refuses a repay while the USDC reserve is paused, and every sale repays.
        if (SPOKE.getReserve(USDC_RESERVE_ID).flags & 1 != 0) return n;

        Sale memory s;
        if (sellOn) s = _saleBook(c, d);
        // A factor raise: the refresh alone lifts the stored reading, the one liquidation uses, for free. The next
        // read plans on the refreshed reading.
        if (s.ok && s.refreshable && s.latestHf > c.hf + RAISE_GAP) {
            moves[n++] = _move(c.a, REFRESH, new uint256[](0));
            return n;
        }
        uint256 repaid;
        if (protectOn) (n, repaid) = _repayMove(c, d, moves, n);
        if (s.ok) n = _sellMove(c, d, s, repaid, moves, n);
        return n;
    }

    /// REPAY [fromWallet, fromSavings]: CashRules.protectNeed at the user's own target, from wallet cash above the
    /// keep-back first, then the savings Aave V3 can pay out now, within what the grant may still spend. Under the line
    /// it's left out when it neither covers the need nor moves MIN_REPAY. In a rescue above the line any repay goes:
    /// those accounts come after every one under it, and their change from a sale is worth repaying.
    function _repayMove(Ctx memory c, ISpoke.UserAccountData memory d, Move[] memory moves, uint256 n)
        internal
        view
        returns (uint256, uint256 amount)
    {
        Thresholds memory t = Thresholds(uint64(c.line), uint64(c.target), 0, 0);
        (ProtectCase why, uint256 need, uint256 debtValue) =
            CashRules.protectNeed(d.totalCollateralValue, d.avgCollateralFactor, d.totalDebtValueRay, t, c.rescuing);
        if (why != ProtectCase.Act) return (n, 0);
        PM.Permission memory p = _permission(c.a, JOB_PROTECT);
        if (!_aliveP(c.a, JOB_PROTECT, p)) return (n, 0);
        uint256 wallet = _sub(USDC.balanceOf(c.a), KEEP_BACK);
        uint256 savings = _min(savingsOut(c.a), _watchedLeft(p, address(AUSDC)));
        uint256 want = _ceilDiv(_min(need, debtValue), 1e20);
        amount = _min(_min(want, wallet + savings), _spendLeft(p, address(USDC)));
        if (amount == 0 || (c.hf < c.line && amount < want && amount < MIN_REPAY)) return (n, 0);
        uint256 fromWallet = _min(amount, wallet);
        moves[n++] = _move(c.a, REPAY, _two(fromWallet, amount - fromWallet));
        return (n, amount);
    }

    /// SELL [r << 248 | shares, …] if the repay can't reach the target: SellRules on the latest config, sized to land
    /// at the target plus SELL_MARGIN, every withdraw keeping health at least WITHDRAW_FLOOR_HF. Left out when the
    /// Guard would refuse it: when it can't lift health to the stored reading it starts from (H6), or would overshoot.
    function _sellMove(
        Ctx memory c,
        ISpoke.UserAccountData memory d,
        Sale memory s,
        uint256 repaid,
        Move[] memory moves,
        uint256 n
    ) internal view returns (uint256) {
        Book memory b = s.book;
        uint256 repaidValue = repaid * b.usdcPrice * 1e12;
        if (b.debt <= repaidValue) return n;
        // Slices are cut on the debt after the repay, with the withdraw floor raised by what the repay takes off, so
        // each withdraw still keeps the floor if the Guard refuses the repay (a sale sized on a repay that didn't
        // happen would otherwise sink its first withdraw).
        uint256 floorHf = withdrawFloor(s.latestHf) * b.debt / (b.debt - repaidValue);
        b.debt -= repaidValue;
        // The stored reading the Guard gates the sale on: after the repay, when there is one.
        uint256 hfRef = c.hf;
        if (repaid > 0) {
            hfRef = d.totalCollateralValue * d.avgCollateralFactor / WAD * WAD / b.debt;
            if (hfRef + DONE_GAP >= c.target) return n; // the repay finishes the rescue
        }
        uint256[] memory legs = _legs(b, c, floorHf, hfRef);
        if (legs.length > 0) moves[n++] = _move(c.a, SELL, legs);
        return n;
    }

    /// The sale's legs, sized to the target plus SELL_MARGIN; none when the Guard would refuse the sale.
    function _legs(Book memory b, Ctx memory c, uint256 floorHf, uint256 hfRef)
        internal
        view
        returns (uint256[] memory legs)
    {
        uint256[7] memory take = SellRules.amounts(b, c.target + SELL_MARGIN, SALE_FLOOR_BPS, c.keepMix);
        (Slice[] memory slices, uint256 endHf) = slicesOf(b, take, SALE_FLOOR_BPS, SELL_MAX_SLICE, floorHf);
        if (slices.length == 0 || endHf < hfRef || endHf > c.target + OVERSHOOT) return legs;
        legs = new uint256[](slices.length);
        for (uint256 i; i < slices.length; ++i) {
            legs[i] = uint256(slices[i].reserveId) << 248 | slices[i].shares;
        }
    }

    /// The account's backing on each reserve's latest config (a withdraw moves the whole position to it), and what
    /// Protect · sell may sell of each stock: listed in its permission, reserve not paused, pool within the Guard's band
    /// of Aave's price either way, and no more than the pool can take before its price passes the sale floor.
    function _saleBook(Ctx memory c, ISpoke.UserAccountData memory d) internal view returns (Sale memory s) {
        PM.Permission memory p = _permission(c.a, JOB_SELL);
        if (!_aliveP(c.a, JOB_SELL, p)) return s;
        s.ok = true;
        s.refreshable = _lists(p, address(SPOKE), REFRESH_CONFIG);
        Book memory b = s.book;
        b.usdcPrice = ORACLE.getReservePrice(USDC_RESERVE_ID);
        b.usdcLeft = _spendLeft(p, address(USDC));
        b.debt = _ceilDiv(d.totalDebtValueRay, 1e27);
        bool[7] memory paused;
        for (uint256 r; r < 7; ++r) {
            (b.stocks[r], paused[r]) = _holding(c.a, r);
        }
        uint256 power = SellRules.power(b.stocks);
        s.latestHf = power * 1e14 / b.debt;
        // What the sale must make up, at most (before any repay), as SellRules.amounts counts it.
        uint256 aim = c.target + SELL_MARGIN;
        uint256 deficit = _sub(aim * b.debt, power * 1e14) + aim * b.usdcPrice * 1e12 * MAX_SLICES;
        uint256 repayGain = aim * (1e4 - SALE_FLOOR_BPS) * b.usdcPrice / 100;
        for (uint256 r; r < 7; ++r) {
            Holding memory h = b.stocks[r];
            if (h.shares == 0 || paused[r] || !_lists(p, stock(r), APPROVE)) continue;
            uint256 spot = poolPrice(r);
            if (spot * 1e4 < h.price * (1e4 - BAND_BPS) || spot * 1e4 > h.price * (1e4 + BAND_BPS)) continue;
            // The pool walk stops at what this stock alone could ever be asked for: its shares, or the shares that
            // would make up the whole deficit by themselves (SellRules never takes more of one stock).
            uint256 enough = h.shares;
            if (repayGain > h.cf * 1e24) enough = _min(enough, _ceilDiv(deficit, h.price * (repayGain - h.cf * 1e24)));
            h.limit = _min(stockDepth(r, h.price, false, SALE_FLOOR_BPS, enough), _spendLeft(p, stock(r)));
            h.poolLeft = type(uint128).max;
        }
    }

    /// Reserve r's backing for the account on its latest config, if it counts: collateral with a factor above 0.
    function _holding(address a, uint256 r) internal view returns (Holding memory h, bool paused) {
        (bool collateral,) = SPOKE.getUserReserveStatus(r, a);
        if (!collateral) return (h, false);
        uint256 shares = SPOKE.getUserSuppliedAssets(r, a);
        if (shares == 0) return (h, false);
        ISpoke.Reserve memory res = SPOKE.getReserve(r);
        h.cf = SPOKE.getDynamicReserveConfig(r, res.dynamicConfigKey).collateralFactor;
        if (h.cf == 0) return (h, false);
        h.shares = shares;
        h.price = ORACLE.getReservePrice(r);
        paused = res.flags & 1 != 0 || h.price == 0;
    }

    /// The health each withdraw must leave, from the latest-config health `hf` before the sale: WITHDRAW_FLOOR_HF, or
    /// halfway between 1.0 and `hf` when that is lower, never under WITHDRAW_FLOOR_MIN.
    function withdrawFloor(uint256 hf) public pure returns (uint256) {
        uint256 half = (1e18 + hf) / 2;
        if (half > WITHDRAW_FLOOR_HF) return WITHDRAW_FLOOR_HF;
        return half < WITHDRAW_FLOOR_MIN ? WITHDRAW_FLOOR_MIN : half;
    }

    /// SellRules.slices with the withdraw floor `floorHf` instead of the library's fixed 1.001, also returning the
    /// health the last slice leaves on the latest config. Copied here because SellRules' floor is a compile-time
    /// constant.
    function slicesOf(Book memory b, uint256[7] memory take, uint256 floorBps, uint256 maxSlice, uint256 floorHf)
        public
        pure
        returns (Slice[] memory out, uint256 endHf)
    {
        out = new Slice[](MAX_SLICES);
        SellRules.Cut memory c = SellRules.Cut(SellRules.power(b.stocks), b.debt, 0);
        uint8[7] memory o = SellRules.order(b.stocks);
        bool stop;
        for (uint256 k; k < 7 && !stop; ++k) {
            uint256 left = take[o[k]];
            while (left > 0) {
                if (c.n == MAX_SLICES) {
                    stop = true;
                    break;
                }
                Slice memory s = _cut(b, c, o[k], left, floorBps, maxSlice, floorHf);
                if (s.minOut == 0) {
                    stop = true;
                    break;
                }
                out[c.n++] = s;
                left -= s.shares;
            }
        }
        uint256 count = c.n;
        assembly ("memory-safe") {
            mstore(out, count)
        }
        endHf = c.debt == 0 ? type(uint256).max : c.power * 1e14 / c.debt;
    }

    /// SellRules._cut with the withdraw floor `floorHf`.
    function _cut(
        Book memory b,
        SellRules.Cut memory c,
        uint8 i,
        uint256 left,
        uint256 floorBps,
        uint256 maxSlice,
        uint256 floorHf
    ) private pure returns (Slice memory s) {
        Holding memory h = b.stocks[i];
        uint256 room =
            c.power * 1e14 > floorHf * c.debt ? (c.power * 1e14 - floorHf * c.debt) / (h.cf * h.price * 1e24) : 0;
        s.reserveId = i;
        s.shares = _min(_min(left, room), maxSlice * 1e10 / h.price);
        s.minOut = s.shares * h.price * (1e4 - floorBps) / 1e14;
        if (s.minOut == 0) return s;
        c.power -= h.cf * s.shares * h.price * 1e10;
        uint256 repaid = s.minOut * b.usdcPrice * 1e12;
        c.debt = repaid >= c.debt ? 0 : c.debt - repaid;
    }

    /// Savings Aave V3 can pay out now: the balance within the reserve's virtual balance; none while the reserve is
    /// inactive or paused (a frozen reserve still pays out). The draft's ProtectJob._savingsOut.
    function savingsOut(address a) public view returns (uint256 s) {
        s = AUSDC.balanceOf(a);
        if (s == 0) return 0;
        uint256 cfg = IAaveV3Liquidity(AAVE_V3_POOL).getConfiguration(address(USDC));
        if (cfg >> 56 & 1 == 0 || cfg >> 60 & 1 != 0) return 0;
        uint256 free = IAaveV3Liquidity(AAVE_V3_POOL).getVirtualUnderlyingBalance(address(USDC));
        return s < free ? s : free;
    }
}
