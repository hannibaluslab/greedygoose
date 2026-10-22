// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The read-only parts of a concentrated-liquidity pool that GoosePlanner sizes swaps with. Aerodrome Slipstream and
/// Uniswap v3 lay out these getters the same way for the words read here: `slot0` starts with the price and the tick
/// (Slipstream returns 6 words, Uniswap 7; only the first two are decoded), and `ticks` starts with liquidityGross and
/// liquidityNet (Slipstream adds stakedLiquidityNet after them).
interface IClPool {
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick);
    function liquidity() external view returns (uint128);
    function tickBitmap(int16 wordPosition) external view returns (uint256);
    function ticks(int24 tick) external view returns (uint128 liquidityGross, int128 liquidityNet);
}

/// @title PoolDepth
/// @notice How much a concentrated-liquidity pool can take before its price passes a limit: the planner's quote, read
///         in a view (a quoter needs a state-changing swap, so it can't run inside `checkUpkeep`). It walks the pool's
///         initialized ticks from the current price toward the limit the way the pool's own swap loop does, adding up
///         the input each range takes, and stops at the limit or after MAX_STEPS ranges (so a deep walk is cut short,
///         which only ever understates the depth). Fees are left out: the input that moves the price to the limit is
///         the amount after the fee, so the real swap can take slightly more. Uniswap v3's tick maths (TickMath,
///         TickBitmap, SqrtPriceMath), reimplemented for 0.8 and checked against live pools (GoosePlannerFork.t.sol).
library PoolDepth {
    uint256 internal constant Q96 = 1 << 96;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint160 internal constant MIN_SQRT = 4295128739;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;
    /// Ranges walked at most. A stock pool at tick spacing 10 crosses one range per 0.1% of price.
    uint256 internal constant MAX_STEPS = 24;

    /// The input the pool takes, raw units of the token going in, before its price passes `limit`: going down
    /// (`zeroForOne`, token0 in) or up (token1 in). 0 when the price is already at or past the limit. The walk stops
    /// once it has found `enough`, which is all the caller could use.
    function maxIn(address pool, int24 spacing, bool zeroForOne, uint160 limit, uint256 enough)
        internal
        view
        returns (uint256 amount)
    {
        (uint160 sqrtP, int24 tick) = IClPool(pool).slot0();
        if (zeroForOne ? limit >= sqrtP : limit <= sqrtP) return 0;
        uint256 liq = IClPool(pool).liquidity();
        for (uint256 s; s < MAX_STEPS; ++s) {
            (int24 next, bool initialized) = nextTick(pool, tick, spacing, zeroForOne);
            if (next < MIN_TICK) next = MIN_TICK;
            if (next > MAX_TICK) next = MAX_TICK;
            uint160 sqrtNext = sqrtAt(next);
            uint160 to = zeroForOne ? (sqrtNext < limit ? limit : sqrtNext) : (sqrtNext > limit ? limit : sqrtNext);
            amount += zeroForOne ? amount0(to, sqrtP, liq) : amount1(sqrtP, to, liq);
            if (to == limit || amount >= enough) return amount;
            if (initialized) {
                (, int128 net) = IClPool(pool).ticks(next);
                if (zeroForOne) net = -net;
                if (net < 0) {
                    uint256 cut = uint256(uint128(-net));
                    liq = liq > cut ? liq - cut : 0;
                } else {
                    liq += uint256(uint128(net));
                }
            }
            tick = zeroForOne ? next - 1 : next;
            sqrtP = sqrtNext;
        }
    }

    /// token0 between two prices: L × (1/√a − 1/√b), rounded down. `a` ≤ `b`.
    function amount0(uint160 a, uint160 b, uint256 liq) internal pure returns (uint256) {
        if (a >= b || liq == 0) return 0;
        return mulDiv(liq << 96, b - a, b) / a;
    }

    /// token1 between two prices: L × (√b − √a), rounded down. `a` ≤ `b`.
    function amount1(uint160 a, uint160 b, uint256 liq) internal pure returns (uint256) {
        if (a >= b || liq == 0) return 0;
        return mulDiv(liq, b - a, Q96);
    }

    /// The square-root price, Q64.96, at which raw token1 per raw token0 is `num / den`, kept inside the pool's range.
    function sqrtOf(uint256 num, uint256 den) internal pure returns (uint160) {
        uint256 s = sqrt(mulDiv(num, 1 << 192, den));
        if (s < MIN_SQRT) return MIN_SQRT + 1;
        if (s >= MAX_SQRT) return MAX_SQRT - 1;
        return uint160(s);
    }

    // ================================================================== Uniswap v3's TickBitmap

    /// The next initialized tick within one bitmap word of `tick`, at or below it (`lte`) or above it; when there is
    /// none, the word's edge, not initialized.
    function nextTick(address pool, int24 tick, int24 spacing, bool lte)
        internal
        view
        returns (int24 next, bool initialized)
    {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) --compressed;
        if (lte) {
            (int16 word, uint8 bit) = _position(compressed);
            uint256 mask = (uint256(1) << bit) - 1 + (uint256(1) << bit);
            uint256 masked = IClPool(pool).tickBitmap(word) & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed - int24(uint24(bit - msb(masked)))) * spacing
                : (compressed - int24(uint24(bit))) * spacing;
        } else {
            (int16 word, uint8 bit) = _position(compressed + 1);
            uint256 mask = ~((uint256(1) << bit) - 1);
            uint256 masked = IClPool(pool).tickBitmap(word) & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed + 1 + int24(uint24(lsb(masked) - bit))) * spacing
                : (compressed + 1 + int24(uint24(type(uint8).max - bit))) * spacing;
        }
    }

    function _position(int24 compressed) private pure returns (int16 word, uint8 bit) {
        word = int16(compressed >> 8);
        bit = uint8(uint24(compressed) & 0xff);
    }

    /// Index of the most significant set bit of `x` (> 0).
    function msb(uint256 x) internal pure returns (uint8 r) {
        if (x >= 1 << 128) (x, r) = (x >> 128, r + 128);
        if (x >= 1 << 64) (x, r) = (x >> 64, r + 64);
        if (x >= 1 << 32) (x, r) = (x >> 32, r + 32);
        if (x >= 1 << 16) (x, r) = (x >> 16, r + 16);
        if (x >= 1 << 8) (x, r) = (x >> 8, r + 8);
        if (x >= 1 << 4) (x, r) = (x >> 4, r + 4);
        if (x >= 1 << 2) (x, r) = (x >> 2, r + 2);
        if (x >= 1 << 1) r += 1;
    }

    /// Index of the least significant set bit of `x` (> 0).
    function lsb(uint256 x) internal pure returns (uint8) {
        return msb(x & (~x + 1));
    }

    // ================================================================== Uniswap v3's TickMath

    /// √(1.0001^tick) × 2^96, rounded up, as the pool computes it.
    function sqrtAt(int24 tick) internal pure returns (uint160) {
        uint256 t = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        uint256 r = t & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (t & 0x2 != 0) r = (r * 0xfff97272373d413259a46990580e213a) >> 128;
        if (t & 0x4 != 0) r = (r * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (t & 0x8 != 0) r = (r * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (t & 0x10 != 0) r = (r * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (t & 0x20 != 0) r = (r * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (t & 0x40 != 0) r = (r * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (t & 0x80 != 0) r = (r * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (t & 0x100 != 0) r = (r * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (t & 0x200 != 0) r = (r * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (t & 0x400 != 0) r = (r * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (t & 0x800 != 0) r = (r * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (t & 0x1000 != 0) r = (r * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (t & 0x2000 != 0) r = (r * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (t & 0x4000 != 0) r = (r * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (t & 0x8000 != 0) r = (r * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (t & 0x10000 != 0) r = (r * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (t & 0x20000 != 0) r = (r * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (t & 0x40000 != 0) r = (r * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (t & 0x80000 != 0) r = (r * 0x48a170391f7dc42444e8fa2) >> 128;
        if (tick > 0) r = type(uint256).max / r;
        return uint160((r >> 32) + (r % (1 << 32) == 0 ? 0 : 1));
    }

    // ================================================================== maths

    /// ⌊a × b / d⌋ with a 512-bit product (Remco Bloemen's mulDiv, as in Uniswap v3's FullMath).
    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly ("memory-safe") {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) return prod0 / d;
            require(d > prod1);
            uint256 remainder;
            assembly ("memory-safe") {
                remainder := mulmod(a, b, d)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = d & (~d + 1);
            assembly ("memory-safe") {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            result = prod0 * inv;
        }
    }

    /// ⌊√x⌋.
    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = 1 << (msb(x) / 2 + 1); // above √x
        uint256 y = (z + x / z) / 2;
        while (y < z) {
            z = y;
            y = (z + x / z) / 2;
        }
    }
}
