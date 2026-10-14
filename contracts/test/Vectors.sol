// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Thresholds} from "../src/CashRules.sol";
import {Coin} from "../src/EntryRules.sol";
import {RebalanceBook, RebalanceHolding, RebalanceLimits} from "../src/RebalanceRules.sol";
import {Book, Holding} from "../src/SellRules.sol";

/// The inputs behind contracts/test/vectors/*.json, drawn exactly as scripts/agent-vectors.ts draws them:
/// uint256(keccak256(abi.encode(tag, i, field))). The JSON carries what the TypeScript reference decided for each.
library Vectors {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant VALUE_PER_USD = 1e26;
    uint256 internal constant CALENDAR_START = 1_767_225_600; // 2026-01-01T00:00:00Z
    uint256 internal constant CALENDAR_DAYS = 1826;
    /// Where the hash test puts the executor (HASH_SPENDER in the script).
    address internal constant HASH_SPENDER = 0x0000000000000000000000000000000000600dE5;

    struct Protect {
        uint256 collateral;
        uint256 avgCf;
        uint256 debtRay;
        uint256 savings;
        uint256 capLeft;
        bool preFreeze;
        Thresholds t;
        uint256 minRepay;
    }

    struct Save {
        uint256 cash;
        uint256 capLeft;
        uint256 savesToday;
        uint256 keepBack;
        uint256 minSave;
        uint256 maxSavesPerDay;
    }

    struct Hash {
        uint8 job;
        address account;
        uint48 start;
        uint48 end;
        uint256 salt;
        uint160 cap;
    }

    struct Sell {
        Book book;
        uint256 targetHf;
        uint256 floorBps;
        bool keepMix;
        uint256 maxSlice;
    }

    struct Timing {
        uint256 hf;
        uint256 headsUpAt;
        uint256 now_;
        bool frozen;
        uint64 headsUpHf;
        uint64 nowHf;
        uint32 headsUpDelay;
    }

    struct SellHash {
        address account;
        uint48 start;
        uint48 end;
        uint256 salt;
        uint160 cap;
        uint256[7] limits; // raw shares, by reserve id
    }

    struct Rebalance {
        RebalanceBook book;
        bool[7] tradable;
        RebalanceLimits l;
    }

    struct Entry {
        Coin[] coins;
        uint16 floorBps;
        uint64 minEntry;
        uint64 maxSwap;
    }

    struct RebalanceHash {
        address account;
        uint48 start;
        uint48 end;
        uint256 salt;
        uint160 cap;
        uint256[7] limits; // raw shares, by reserve id
    }

    function rand(string memory tag, uint256 i, uint256 field) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(tag, i, field)));
    }

    function between(uint256 r, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + r % (hi - lo + 1);
    }

    function spread(uint256 r1, uint256 r2, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return (1 + r1 % 9) * 10 ** between(r2, lo, hi);
    }

    function protectInput(uint256 i) internal pure returns (Protect memory v) {
        uint256[20] memory r;
        for (uint256 f; f < 20; ++f) {
            r[f] = rand("protect", i, f);
        }
        uint256 trigger = between(r[14], 1.2e18, 2e18);
        uint256 target = between(r[15], trigger + 0.05e18, 2.5e18);
        uint256 drop = between(r[16], 0.05e18, 0.3e18);
        bool shield = r[19] % 4 == 0;
        uint256 stressed = trigger * (WAD - drop) / WAD;
        uint256 floorMin = shield && stressed >= 1.02e18 ? stressed + 1 : 1.02e18;
        uint256 floor = between(r[17], floorMin, trigger);
        uint256 hf = shield ? between(r[4], trigger, floor * WAD / (WAD - drop)) : between(r[4], 0.8e18, 2.6e18);
        v.t = Thresholds(uint64(trigger), uint64(target), uint64(drop), uint64(floor));

        v.collateral = spread(r[0], r[1], 1, 6) * VALUE_PER_USD + r[2] % VALUE_PER_USD;
        v.avgCf = between(r[3], 0.5e18, 0.85e18);
        uint256 debtValue = v.collateral * v.avgCf / WAD * WAD / hf;
        v.debtRay = r[6] % 20 == 0 ? 0 : debtValue * RAY + r[5] % RAY;
        v.savings = r[7] % 10 == 0 ? 0 : spread(r[8], r[9], 5, 11);
        v.capLeft = r[10] % 10 == 0 ? 0 : spread(r[11], r[12], 5, 10);
        v.preFreeze = shield || r[13] % 2 == 1;
        v.minRepay = 50_000 * 10 ** (r[18] % 4);
    }

    function saveInput(uint256 i) internal pure returns (Save memory v) {
        uint256[11] memory r;
        for (uint256 f; f < 11; ++f) {
            r[f] = rand("save", i, f);
        }
        v.keepBack = r[8] % 5_000_001;
        v.cash = r[0] % 5 == 0 ? r[1] % 10_000_000 : v.keepBack + spread(r[2], r[3], 5, 10);
        v.capLeft = r[4] % 8 == 0 ? 0 : spread(r[5], r[6], 5, 10);
        v.savesToday = r[7] % 12;
        v.minSave = 100_000 * 10 ** (r[9] % 4);
        v.maxSavesPerDay = 1 + r[10] % 24;
    }

    /// Odd ones land on a Friday between 15:00 and 03:00 UTC, around both edges of Leo's Friday window.
    function calendarTime(uint256 i) internal pure returns (uint256) {
        if (i % 2 == 0) return CALENDAR_START + rand("calendar", i, 0) % (CALENDAR_DAYS * 1 days);
        uint256 d = CALENDAR_START / 1 days + rand("calendar", i, 1) % CALENDAR_DAYS;
        uint256 friday = d - (d + 6) % 7; // 1970-01-02 (day 1) was a Friday
        return friday * 1 days + 15 hours + rand("calendar", i, 2) % 12 hours;
    }

    /// Holdings from 0.01 to 10,000 shares at $100–1,000, health from 0.95 to 1.6, and limits, pool windows and the USDC
    /// limit that bind a fifth of the time.
    function sellInput(uint256 i) internal pure returns (Sell memory v) {
        uint256 power;
        for (uint256 k; k < 7; ++k) {
            uint256 f = 10 + 12 * k;
            Holding memory h = v.book.stocks[k];
            h.shares = rand("sell", i, f) % 3 == 0 ? 0 : spread(rand("sell", i, f + 1), rand("sell", i, f + 2), 6, 11);
            h.price = between(rand("sell", i, f + 3), 1e10, 1e11);
            h.cf = between(rand("sell", i, f + 4), 5_000, 8_500);
            uint256 kind = rand("sell", i, f + 5) % 4;
            h.limit = kind == 0 ? 0 : kind == 1 ? spread(rand("sell", i, f + 6), rand("sell", i, f + 7), 5, 10) : 1e13;
            h.poolLeft =
                rand("sell", i, f + 8) % 5 == 0 ? spread(rand("sell", i, f + 9), rand("sell", i, f + 10), 5, 9) : 1e12;
            power += h.cf * h.shares * h.price * 1e10;
        }
        v.book.usdcPrice = between(rand("sell", i, 0), 99_500_000, 100_500_000);
        uint256 hf = between(rand("sell", i, 1), 0.95e18, 1.6e18);
        v.book.debt = (power * 1e14 + hf - 1) / hf;
        v.book.usdcLeft = rand("sell", i, 2) % 5 == 0 ? spread(rand("sell", i, 3), rand("sell", i, 4), 5, 9) : 1e13;
        v.targetHf = between(rand("sell", i, 5), 1.3e18, 1.6e18);
        v.floorBps = between(rand("sell", i, 6), 25, 500);
        v.keepMix = rand("sell", i, 7) % 3 == 0;
        v.maxSlice = between(rand("sell", i, 8), 100e6, 50_000e6);
    }

    function timingInput(uint256 i) internal pure returns (Timing memory v) {
        v.now_ = 1_792_000_000;
        v.headsUpHf = uint64(between(rand("timing", i, 0), 1.1e18, 1.5e18));
        v.hf = between(rand("timing", i, 1), 0.9e18, 1.6e18);
        v.headsUpAt = rand("timing", i, 2) % 3 == 0 ? 0 : v.now_ - rand("timing", i, 3) % 7_200;
        v.frozen = rand("timing", i, 4) % 4 == 0;
        v.nowHf = uint64(between(rand("timing", i, 5), 1.02e18, v.headsUpHf));
        v.headsUpDelay = uint32(between(rand("timing", i, 6), 600, 7_200));
    }

    /// A third of the stocks never-sell, at least one for sale.
    function sellHashInput(uint256 i) internal pure returns (SellHash memory v) {
        uint256 first = rand("sell-hash", i, 6) % 7;
        for (uint256 k; k < 7; ++k) {
            if (k != first && rand("sell-hash", i, 7 + k) % 3 == 0) continue;
            v.limits[k] = (1 + rand("sell-hash", i, 14 + k) % 1_000_000) * 1e4;
        }
        v.account = address(uint160(rand("sell-hash", i, 1)));
        v.start = uint48(1_700_000_000 + rand("sell-hash", i, 2) % 300_000_000);
        v.end = v.start + 1 + uint48(rand("sell-hash", i, 3) % 400_000_000);
        v.salt = rand("sell-hash", i, 4);
        v.cap = uint160(1 + rand("sell-hash", i, 5) % 5_000_000);
    }

    /// A mix of one to seven stocks worth $1k to $900k drifted from its targets by up to 60%, free stock outside the
    /// mix a quarter of the time, weekly limits that bind a quarter of the time, a USDC limit that binds a fifth of the
    /// time, and a pool out of line a tenth of the time.
    function rebalanceInput(uint256 i) internal pure returns (Rebalance memory v) {
        uint256[7] memory w = _mix(i);
        uint256 total = spread(rand("rebalance", i, 20), rand("rebalance", i, 21), 9, 11);
        uint256 drift = between(rand("rebalance", i, 19), 500, 6_000);
        for (uint256 k; k < 7; ++k) {
            v.book.stocks[k] = _drifted(i, k, w[k], total, drift);
            v.tradable[k] = rand("rebalance", i, 100 + k) % 10 != 0;
        }
        v.book.usdcLeft =
            rand("rebalance", i, 22) % 5 == 0 ? spread(rand("rebalance", i, 23), rand("rebalance", i, 24), 6, 9) : 1e15;
        v.l.bandBps = uint16(between(rand("rebalance", i, 25), 500, 5_000));
        v.l.bandMaxBps = uint16(between(rand("rebalance", i, 26), 100, 2_000));
        v.l.floorBps = uint16(between(rand("rebalance", i, 27), 10, 300));
        v.l.minTrade = uint64(between(rand("rebalance", i, 28), 1e6, 100e6));
        v.l.maxSlice = uint64(between(rand("rebalance", i, 29), 100e6, 50_000e6));
    }

    /// The target weights: each stock in the mix with odds 2/3, at least one, adding up to 10,000.
    function _mix(uint256 i) private pure returns (uint256[7] memory w) {
        uint256 first = rand("rebalance", i, 0) % 7;
        uint256 sum;
        for (uint256 k; k < 7; ++k) {
            if (k == first || rand("rebalance", i, 1 + k) % 3 != 0) w[k] = 1 + rand("rebalance", i, 10 + k) % 1000;
            sum += w[k];
        }
        uint256 assigned;
        for (uint256 k; k < 7; ++k) {
            w[k] = w[k] * 10_000 / sum;
            assigned += w[k];
        }
        w[first] += 10_000 - assigned;
    }

    function _drifted(uint256 i, uint256 k, uint256 weight, uint256 total, uint256 drift)
        private
        pure
        returns (RebalanceHolding memory h)
    {
        uint256 f = 30 + 10 * k;
        h.price = between(rand("rebalance", i, f), 1e9, 1e11);
        uint256 value;
        if (weight > 0) {
            value =
                total * weight / 10_000 * between(rand("rebalance", i, f + 1), 10_000 - drift, 10_000 + drift) / 10_000;
        } else if (rand("rebalance", i, f + 2) % 4 == 0) {
            value = spread(rand("rebalance", i, f + 3), rand("rebalance", i, f + 4), 6, 10);
        }
        h.shares = value * 1e10 / h.price;
        h.weight = weight;
        uint256 kind = rand("rebalance", i, f + 5) % 4;
        if (kind == 1) h.sellLeft = spread(rand("rebalance", i, f + 6), rand("rebalance", i, f + 7), 4, 9);
        else if (kind > 1) h.sellLeft = 1e18;
    }

    /// The four coins with balances from dust to $900k, daily limits that bind half the time, a coin waiting a fifth of
    /// the time.
    function entryInput(uint256 i) internal pure returns (Entry memory v) {
        uint8[4] memory decimals = [6, 18, 6, 18];
        v.coins = new Coin[](4);
        for (uint256 k; k < 4; ++k) {
            uint256 f = 10 + 10 * k;
            uint256 scale = 10 ** (decimals[k] - 6);
            Coin memory c = v.coins[k];
            c.decimals = decimals[k];
            if (rand("entry", i, f) % 3 != 0) {
                c.balance = spread(rand("entry", i, f + 1), rand("entry", i, f + 2), 4, 11) * scale
                    + rand("entry", i, f + 4) % scale;
            }
            uint256 kind = rand("entry", i, f + 3) % 4;
            c.limitLeft = kind == 0
                ? 0
                : kind == 1 ? spread(rand("entry", i, f + 5), rand("entry", i, f + 6), 5, 10) * scale : 1e30;
            c.waiting = rand("entry", i, f + 7) % 5 == 0;
        }
        v.floorBps = uint16(between(rand("entry", i, 0), 10, 100));
        v.minEntry = uint64(between(rand("entry", i, 1), 100_000, 100_000_000));
        v.maxSwap = uint64(between(rand("entry", i, 2), 100e6, 100_000e6));
    }

    /// A third of the stocks unsellable, at least one sellable.
    function rebalanceHashInput(uint256 i) internal pure returns (RebalanceHash memory v) {
        uint256 first = rand("rebalance-hash", i, 6) % 7;
        for (uint256 k; k < 7; ++k) {
            if (k != first && rand("rebalance-hash", i, 7 + k) % 3 == 0) continue;
            v.limits[k] = (1 + rand("rebalance-hash", i, 14 + k) % 1_000_000) * 1e4;
        }
        v.account = address(uint160(rand("rebalance-hash", i, 1)));
        v.start = uint48(1_700_000_000 + rand("rebalance-hash", i, 2) % 300_000_000);
        v.end = v.start + 1 + uint48(rand("rebalance-hash", i, 3) % 400_000_000);
        v.salt = rand("rebalance-hash", i, 4);
        v.cap = uint160(1 + rand("rebalance-hash", i, 5) % 5_000_000);
    }

    function entryHashInput(uint256 i) internal pure returns (Hash memory v) {
        v.account = address(uint160(rand("entry-hash", i, 1)));
        v.start = uint48(1_700_000_000 + rand("entry-hash", i, 2) % 300_000_000);
        v.end = v.start + 1 + uint48(rand("entry-hash", i, 3) % 400_000_000);
        v.salt = rand("entry-hash", i, 4);
        v.cap = uint160(1 + rand("entry-hash", i, 5) % 5_000_000);
    }

    function hashInput(uint256 i) internal pure returns (Hash memory v) {
        v.job = uint8(rand("hash", i, 0) % 2);
        v.account = address(uint160(rand("hash", i, 1)));
        v.start = uint48(1_700_000_000 + rand("hash", i, 2) % 300_000_000);
        v.end = v.start + 1 + uint48(rand("hash", i, 3) % 400_000_000);
        v.salt = rand("hash", i, 4);
        v.cap = uint160(1 + rand("hash", i, 5) % 5_000_000);
    }

    /// Bit i of a bitmap packed high bit first.
    function bit(bytes memory bits, uint256 i) internal pure returns (bool) {
        return uint8(bits[i >> 3]) & (0x80 >> (i & 7)) != 0;
    }
}
