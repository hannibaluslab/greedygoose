// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IAeroRouter, IERC20, IPsm3 as IPsm3Swap, IUniswapRouter} from "../IProtocols.sol";
import {Coin, EntryLimits, EntryRules} from "../EntryRules.sol";
import {PoolDepth} from "../PoolDepth.sol";
import {IGooseGuard, PlanBase} from "./PlanBase.sol";

interface IAaveV3Reserve {
    struct ReserveDataLegacy {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
    /// The reserve's liquidity index now, RAY: what a supply divides by to mint scaled aUSDC.
    function getReserveNormalizedIncome(address asset) external view returns (uint256);
}

interface ITotalSupply {
    function totalSupply() external view returns (uint256);
}

interface IFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IPsm3Read {
    function previewSwapExactIn(address assetIn, address assetOut, uint256 amountIn) external view returns (uint256);
}

/// @title CashPlanner
/// @notice GoosePlanner's cash part (spec-final-v2.md §10, phase 3): one account's CONVERT moves (Turn into cash) and
///         SAVE, sized the way GooseGuard will check them on live reads. A stateless view; GoosePlanner calls it in a
///         try.
contract CashPlanner is PlanBase {
    address internal constant PSM3 = 0x1601843c5E9bC251A3272907010AFa41Fa18347E;
    address internal constant AERODROME_V1_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5; // GooseGuard's
    address internal constant UNISWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481; // GooseGuard's
    IFeed internal constant EUR_USD = IFeed(0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F);
    uint64 public constant ENTRY_MAX_SWAP = 10_000e6;

    constructor(IGooseGuard guard) PlanBase(guard) {}

    /// The account's CONVERT moves, then its SAVE; none while the Guard is paused. `walletUsed` is wallet USDC a
    /// Protect repay this round takes first.
    function planCash(address a, uint256 walletUsed) external view returns (Move[] memory moves) {
        moves = new Move[](6);
        if (GUARD.paused()) return _trim(moves, 0);
        Ctx memory c = _ctx(a);
        c.walletUsed = walletUsed;
        uint256 n;
        if (c.jobs & (1 << JOB_ENTRY) != 0) n = _convertMoves(c, moves, n);
        if (c.jobs & (1 << JOB_SAVE) != 0) n = _saveMove(c, moves, n);
        _trim(moves, n);
    }

    // ================================================================== Turn into cash

    /// CONVERT [k, amountIn] for each coin EntryRules finds, in CASH_COINS order. A coin whose venue can't fill at the
    /// floor counts as waiting, so it never blocks the coins after it (save-entry trap 1); each conversion is held to
    /// what its venue can take inside the floor, and the rest goes in the next rounds.
    function _convertMoves(Ctx memory c, Move[] memory moves, uint256 n) internal view returns (uint256) {
        Coin[] memory coins = new Coin[](5);
        bool any;
        for (uint256 k; k < 5; ++k) {
            (address token, uint256 dec,,,) = coin(k);
            uint256 bal = IERC20(token).balanceOf(c.a);
            coins[k] = Coin(bal, dec, 0, true);
            if (bal >= 10 ** (dec - 6)) any = true; // at least one unit of face value
        }
        if (!any) return n;
        PM.Permission memory p = _permission(c.a, JOB_ENTRY);
        if (!_aliveP(c.a, JOB_ENTRY, p)) return n;
        for (uint256 k; k < 5; ++k) {
            (address token,,,,) = coin(k);
            if (coins[k].balance == 0 || !_lists(p, token, APPROVE) || !_swapListed(p, k)) continue;
            coins[k].limitLeft = _min(convertDepth(k, coins[k].balance), _spendLeft(p, token));
            coins[k].waiting = coins[k].limitLeft == 0;
        }
        EntryLimits memory l = EntryLimits(uint16(SWAP_FLOOR_BPS), 1, ENTRY_MAX_SWAP);
        for (uint256 i; i < 5; ++i) {
            (bool found, uint256 k, uint256 amountIn,) = EntryRules.plan(coins, l);
            if (!found) break;
            moves[n++] = _move(c.a, CONVERT, _two(k, amountIn));
            coins[k].waiting = true;
        }
        return n;
    }

    /// How much of coin k (raw units, at most `bal`) its venue can turn into USDC at no worse than face value less the
    /// swap floor, with DEPTH_ROOM_BPS to spare; 0 when it can't fill now. EURC's face value comes from the EUR/USD
    /// feed, which must be fresh.
    function convertDepth(uint256 k, uint256 bal) public view returns (uint256) {
        (address token, uint256 dec, address venue, int24 spacing, bool coinIsToken0) = coin(k);
        if (venue == address(0)) return _psmDepth(token, dec, bal);
        uint256 rate = 1e8; // dollars a coin, 8 decimals
        if (k == 4) {
            rate = eurUsd();
            if (rate == 0) return 0;
        }
        uint160 limit = _limit(rate, dec, coinIsToken0);
        return _min(bal, PoolDepth.maxIn(venue, spacing, coinIsToken0, limit, bal));
    }

    /// The pool price at the worst rate counted: raw USDC per raw coin = rate × (1 − floor + room), decimals adjusted.
    /// The pool's price is token1 per token0: USDC per coin when the coin is token0, its inverse otherwise.
    function _limit(uint256 rate, uint256 dec, bool coinIsToken0) internal view returns (uint160) {
        uint256 num = rate * (1e4 - SWAP_FLOOR_BPS + DEPTH_ROOM_BPS) * 1e6;
        uint256 den = 1e8 * 1e4 * 10 ** dec;
        return coinIsToken0 ? PoolDepth.sqrtOf(num, den) : PoolDepth.sqrtOf(den, num);
    }

    /// USDS through PSM3, 1:1: its preview must clear the floor, and PSM3 must hold the USDC.
    function _psmDepth(address token, uint256 dec, uint256 bal) internal view returns (uint256) {
        try IPsm3Read(PSM3).previewSwapExactIn(token, address(USDC), bal) returns (uint256 out) {
            if (out * 1e4 < (bal / 10 ** (dec - 6)) * (1e4 - SWAP_FLOOR_BPS)) return 0;
            uint256 held = USDC.balanceOf(PSM3);
            return out <= held ? bal : held * 10 ** (dec - 6) * 99 / 100;
        } catch {
            return 0;
        }
    }

    /// EUR/USD, 8 decimals, or 0 when the feed is stale or broken (the Guard refuses EURC then too).
    function eurUsd() public view returns (uint256) {
        try EUR_USD.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt + EURC_FEED_MAX_AGE < block.timestamp) return 0;
            return uint256(answer);
        } catch {
            return 0;
        }
    }

    /// CASH_COINS (lib/tokens/stables.ts:106) in order, each with its venue's pool (step0-facts.md, entry coin pools;
    /// USDS goes through PSM3, no pool).
    /// The grant lists the swap GooseGuard's CONVERT makes for coin k: Aerodrome's router for USDT and EURC,
    /// Uniswap's for USDe and DAI, PSM3 for USDS.
    function _swapListed(PM.Permission memory p, uint256 k) internal pure returns (bool) {
        if (k == 2) return _lists(p, PSM3, IPsm3Swap.swapExactIn.selector);
        if (k == 1 || k == 3) return _lists(p, UNISWAP_ROUTER, IUniswapRouter.exactInputSingle.selector);
        return _lists(p, AERODROME_V1_ROUTER, IAeroRouter.exactInputSingle.selector);
    }

    function coin(uint256 k)
        public
        pure
        returns (address token, uint256 decimals, address venue, int24 spacing, bool coinIsToken0)
    {
        // USDT on Aerodrome v1, tick spacing 1, USDC token0
        if (k == 0) {
            return (0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2, 6, 0xa41Bc0AFfbA7Fd420d186b84899d7ab2aC57fcD1, 1, false);
        }
        // USDe on Uniswap at 0.05%, tick spacing 10, USDe token0
        if (k == 1) {
            return
                (0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34, 18, 0xedAf6Ca46FB852D4AB0A2e9449d267cf03213F05, 10, true);
        }
        // USDS through Spark's PSM3
        if (k == 2) return (0x820C137fa70C8691f0e44Dc420a5e53c168921Dc, 18, address(0), 0, false);
        // DAI on Uniswap at 0.01%, tick spacing 1, DAI token0
        if (k == 3) {
            return (0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb, 18, 0xC18F50d6A832f12F6DcAaeEe8D0c87A65B96787E, 1, true);
        }
        // EURC on Aerodrome v1, tick spacing 1, EURC token0
        return (0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42, 6, 0xc5E51044eB7318950B1aFb044FccFb25782C48c1, 1, true);
    }

    // ================================================================== Save

    /// SAVE [amount]: wallet USDC above the keep-back (less a repay's share) into Aave V3 savings, up to Keep while
    /// top-ups are on (the rest waits to be invested), within what Aave V3 still takes.
    function _saveMove(Ctx memory c, Move[] memory moves, uint256 n) internal view returns (uint256) {
        uint256 room = _sub(USDC.balanceOf(c.a), KEEP_BACK + c.walletUsed);
        if (c.topUpsOn) room = _min(room, _sub(c.keep, AUSDC.balanceOf(c.a)));
        if (room == 0) return n;
        room = _min(room, v3Room());
        // Aave V3 refuses a supply that mints no scaled aUSDC (InvalidAmount), so a save of a unit or two (aUSDC
        // rounding a unit under Keep, say) would be refused every round: it's left out. Two units of margin over
        // Aave's own rounding.
        uint256 index = IAaveV3Reserve(AAVE_V3_POOL).getReserveNormalizedIncome(address(USDC));
        if (room * 1e27 / index < 2) return n;
        PM.Permission memory p = _permission(c.a, JOB_SAVE);
        if (!_aliveP(c.a, JOB_SAVE, p)) return n;
        room = _min(room, _spendLeft(p, address(USDC)));
        if (room * 1e27 / index < 2) return n;
        uint256[] memory args = new uint256[](1);
        args[0] = room;
        moves[n++] = _move(c.a, SAVE, args);
        return n;
    }

    /// What Aave V3 still takes as USDC savings: 0 while the reserve is inactive, frozen or paused, else the room under
    /// its supply cap with $1,000 of slack for interest (the draft's SaveJob._room).
    function v3Room() public view returns (uint256) {
        IAaveV3Reserve.ReserveDataLegacy memory d = IAaveV3Reserve(AAVE_V3_POOL).getReserveData(address(USDC));
        uint256 cfg = d.configuration;
        if (cfg >> 56 & 1 == 0 || cfg >> 57 & 1 != 0 || cfg >> 60 & 1 != 0) return 0;
        uint256 cap = (cfg >> 116 & ((1 << 36) - 1)) * 1e6;
        if (cap == 0) return type(uint256).max;
        uint256 used = ITotalSupply(address(AUSDC)).totalSupply() + uint256(d.accruedToTreasury) * d.liquidityIndex
            / 1e27 + 1_000e6;
        return _sub(cap, used);
    }
}
