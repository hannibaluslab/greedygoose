// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The Entry agent's numbers. BPS, and USDC units (1e6 = $1) of face value. GooseExecutor holds them within hard bounds
/// (D18, `limitsOk`); a change waits the public delay.
struct EntryLimits {
    uint16 floorBps; // most a swap may get under face value
    uint64 minEntry; // smallest swap worth making
    uint64 maxSwap; // largest swap: a larger balance is split over the next runs
}

/// One whitelisted coin, in EntryJob's order.
struct Coin {
    uint256 balance; // raw units in the wallet
    uint256 decimals;
    uint256 limitLeft; // raw units today's limit for this coin still allows
    bool waiting; // its last swap couldn't meet the floor, and the retry time hasn't come
}

/// @title EntryRules
/// @notice The Entry agent's rule, ported from the TypeScript reference (lib/guardian/entry.ts) line for line:
///         test/EntryRules.t.sol runs both on the vectors scripts/agent-vectors.ts exports, and they must agree exactly.
library EntryRules {
    uint256 internal constant BPS = 1e4;
    uint256 internal constant USDC_DECIMALS = 6;

    // Hard bounds (D18). Nothing can change them.
    uint16 internal constant FLOOR_BPS_MIN = 10;
    /// Never under 99% of face value.
    uint16 internal constant FLOOR_BPS_MAX = 100;
    uint64 internal constant MIN_ENTRY_MIN = 0.1e6;
    uint64 internal constant MIN_ENTRY_MAX = 100e6;
    uint64 internal constant MAX_SWAP_MIN = 100e6;
    uint64 internal constant MAX_SWAP_MAX = 100_000e6;

    function limitsOk(EntryLimits memory l) internal pure returns (bool) {
        return l.floorBps >= FLOOR_BPS_MIN && l.floorBps <= FLOOR_BPS_MAX && l.minEntry >= MIN_ENTRY_MIN
            && l.minEntry <= MIN_ENTRY_MAX && l.maxSwap >= MAX_SWAP_MIN && l.maxSwap <= MAX_SWAP_MAX;
    }

    /// The first coin, in whitelist order, worth converting now (planEntry): not waiting, and at least `minEntry` of
    /// face value within its daily limit. It swaps all of it, up to `maxSwap`, for at least face value less the floor,
    /// decimals adjusted; the rest goes in the next runs.
    function plan(Coin[] memory coins, EntryLimits memory l)
        internal
        pure
        returns (bool found, uint256 index, uint256 amountIn, uint256 minOut)
    {
        for (uint256 i; i < coins.length; ++i) {
            Coin memory c = coins[i];
            if (c.waiting) continue;
            uint256 scale = 10 ** (c.decimals - USDC_DECIMALS);
            amountIn = _min(_min(c.balance, c.limitLeft), l.maxSwap * scale);
            if (amountIn / scale < l.minEntry) continue;
            return (true, i, amountIn, _ceilDiv(amountIn * (BPS - l.floorBps), BPS * scale));
        }
        return (false, 0, 0, 0);
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
