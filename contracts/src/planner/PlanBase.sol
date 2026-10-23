// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IAaveOracle, IAaveV3Pool, IAeroRouter, IERC20, IJustanAccount, ISpoke} from "../IProtocols.sol";
import {IClPool, PoolDepth} from "../PoolDepth.sol";

/// The parts of GooseGuard the Planner reads (spec-final-v2.md §2–§3). Only views: the Planner holds no permission.
interface IGooseGuard {
    /// GooseGuard.Account.
    struct Account {
        uint24 index;
        uint8 jobs;
        uint32 rescueAt;
        uint32 sessionAt;
        address runner;
    }

    /// GooseGuard.Settings.
    struct Settings {
        uint112 mix;
        uint16 line;
        uint16 target;
        uint32 mixSetAt;
        bool keepMix;
        bool topUpsOn;
        uint48 keep;
    }

    function accountOf(address a) external view returns (Account memory, Settings memory);
    function members(uint256 i) external view returns (address);
    function membersLength() external view returns (uint256);
    function protectMembers(uint256 i) external view returns (address);
    function protectMembersLength() external view returns (uint256);
    function linesOf(address a) external view returns (uint256 lineWad, uint256 targetWad);
    function sellLineOf(address a) external view returns (uint256);
    function permissionOf(address a, uint8 job) external view returns (bytes memory);
    function capOf(uint8 kind, uint256[] memory args) external view returns (uint256);
    function paused() external view returns (bool);
    function SALE_FLOOR_BPS() external view returns (uint256);
    function SWAP_FLOOR_BPS() external view returns (uint256);
    function BAND_BPS() external view returns (uint256);
    function TIGHT_BPS() external view returns (uint256);
    function KEEP_BACK() external view returns (uint256);
    function DUST() external view returns (uint256);
}

/// @title PlanBase
/// @notice What GoosePlanner and its two planning halves share: the move format, one account's reading, the Guard's
///         numbers, the permission checks and the stock pools. Stateless: the only storage slot is an empty holiday
///         map NyCalendar needs, never written.
/// @dev Compile-time numbers GooseGuard keeps internal are mirrored once here, each naming the Guard's constant. Its
///      immutables are read from it at construction (they can never change); its gas caps are read on every pack.
abstract contract PlanBase {
    /// GooseGuard.Move, field for field: performData is `abi.encode(Move[])`.
    struct Move {
        address account;
        uint8 kind;
        uint256[] args;
    }

    /// One account as the planner reads it.
    struct Ctx {
        address a;
        uint8 jobs;
        uint32 rescueAt;
        uint32 sessionAt;
        uint112 mix;
        uint32 mixSetAt;
        bool keepMix;
        bool topUpsOn;
        uint48 keep;
        bool rescuing;
        uint256 line;
        uint256 target;
        uint256 debt; // USDC units owed
        uint256 hf; // Aave's stored reading, max when nothing is owed
        uint256 walletUsed; // wallet USDC a planned repay takes first
    }

    // ================================================================== GooseGuard's constants (internal there)

    uint8 internal constant SAVE = 0; // GooseGuard.SAVE
    uint8 internal constant REPAY = 1; // GooseGuard.REPAY
    uint8 internal constant SELL = 2; // GooseGuard.SELL
    uint8 internal constant TRADE = 3; // GooseGuard.TRADE
    uint8 internal constant CONVERT = 4; // GooseGuard.CONVERT
    uint8 internal constant END = 5; // GooseGuard.END
    uint8 internal constant REFRESH = 6; // GooseGuard.REFRESH
    uint8 internal constant JOB_SAVE = 0; // the app's JOBS order, as GooseGuard's
    uint8 internal constant JOB_PROTECT = 1; // GooseGuard.JOB_PROTECT
    uint8 internal constant JOB_SELL = 2; // GooseGuard.JOB_SELL
    uint8 internal constant JOB_REBALANCE = 3;
    uint8 internal constant JOB_ENTRY = 4;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant DEFAULT_LINE = 1.03e18; // GooseGuard.DEFAULT_LINE
    uint256 internal constant DEFAULT_TARGET = 1.12e18; // GooseGuard.DEFAULT_TARGET
    uint256 internal constant OVERSHOOT = 0.01e18; // GooseGuard.OVERSHOOT
    uint256 internal constant DONE_GAP = 0.001e18; // GooseGuard.DONE_GAP
    uint256 internal constant RESCUE_MAX_AGE = 7 days; // GooseGuard.RESCUE_MAX_AGE
    uint256 internal constant REBALANCE_GAP = 20 hours; // GooseGuard.REBALANCE_GAP
    uint256 internal constant REBALANCE_SESSION = 1 hours; // GooseGuard.REBALANCE_SESSION
    uint256 internal constant INVEST_HF = 1.1e18; // GooseGuard.INVEST_HF
    uint256 internal constant EURC_FEED_MAX_AGE = 2 hours; // GooseGuard.EURC_FEED_MAX_AGE
    uint256 internal constant USDC_RESERVE_ID = 7; // GooseGuard.USDC_RESERVE_ID
    int24 internal constant STOCK_SPACING = 10; // GooseGuard.TICK_SPACING

    // ================================================================== Base addresses (the Guard's)

    PM internal constant MANAGER = PM(0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8);
    ISpoke internal constant SPOKE = ISpoke(0x17905Db0e4A3514467539956c084180616AE7B8D);
    IAaveOracle internal constant ORACLE = IAaveOracle(0xaBaf048fD7675Ea34a84332371ffd5D55E322A47);
    address internal constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    IERC20 internal constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20 internal constant AUSDC = IERC20(0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB);
    address internal constant STOCK_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F; // GooseGuard.ROUTER
    bytes4 internal constant APPROVE = 0x095ea7b3;

    // ================================================================== the Planner's own policy

    /// Pool depth is counted only to this far inside each move's floor (the pool fee plus a margin), so the swap's
    /// average price clears the floor even at the end of the walk.
    uint256 public constant DEPTH_ROOM_BPS = 15;
    /// Under the line, a repay that doesn't cover the account's whole need must move at least this ($1): less can't
    /// lift health, and dust repays at the lowest health would take a write's slots from accounts a repay would save.
    uint256 public constant MIN_REPAY = 1e6;
    /// GG-19: ProtectPlanner.rankOf adds this to the rank of an account under its own line, or in a rescue under its
    /// target, so one that is a candidate only through the Guard's raised sale line (1.08, no cash) is planned after
    /// every such account and never takes a write's pool from one nearer Aave's own sale.
    uint256 public constant AT_RISK = 1 << 128;
    /// Review R1: the top tier is set by Aave health alone, never by a user's own line, so an account parked at a safe
    /// health under a high personal line (up to 1.35) can't outrank one near Aave's own sale. Every account under
    /// CRITICAL_HF (1.03, the lowest line anyone can set) carries CRITICAL and comes before any AT_RISK account.
    uint256 public constant CRITICAL = 1 << 129;
    uint256 public constant CRITICAL_HF = 1.03e18;
    /// The most the Guard's gas caps may add up to in one write (KeeperHub sends 5.5M, about 5.4M reaches the Guard).
    /// ProtectPlanner cuts each sale to the room left under it, so the checks it runs see the sale that's sent.
    uint256 public constant PACK_GAS = 5_300_000;
    /// The longest grant the Planner decodes: the app's largest (Protect · sell over all seven stocks, 12 calls and 9
    /// spends, 2,624 bytes as `permissionOf` returns it) plus 25%. A longer one is no grant of the app's, and decoding
    /// it would only burn the read's gas (GG-04), so it counts as none.
    uint256 internal constant MAX_GRANT_BYTES = 3_280;

    // ================================================================== the Guard

    IGooseGuard public immutable GUARD;
    uint256 internal immutable SALE_FLOOR_BPS;
    uint256 internal immutable SWAP_FLOOR_BPS;
    uint256 internal immutable BAND_BPS;
    /// The Rebalance band's tight side, on the losing side of a trade (the swap floor less the pool fee and 5 bps).
    uint256 internal immutable TIGHT_BPS;
    uint256 internal immutable KEEP_BACK;

    /// The Guard's immutables are read once: they can never change.
    constructor(IGooseGuard guard) {
        GUARD = guard;
        SALE_FLOOR_BPS = guard.SALE_FLOOR_BPS();
        SWAP_FLOOR_BPS = guard.SWAP_FLOOR_BPS();
        BAND_BPS = guard.BAND_BPS();
        TIGHT_BPS = guard.TIGHT_BPS();
        KEEP_BACK = guard.KEEP_BACK();
    }

    // ================================================================== stocks and pools

    /// The seven stocks, by Aave reserve id (GooseGuard._stock).
    function stock(uint256 r) public pure returns (address) {
        if (r == 0) return 0xb200000000000000000000C2e324d24d7eEcd1fb; // AAPLc
        if (r == 1) return 0xb200000000000000000000d9192b6B456483C2E8; // AMZNc
        if (r == 2) return 0xb2000000000000000000002D0BA3164cc74f58B7; // GOOGLc
        if (r == 3) return 0xb2000000000000000000008bC8786B856E61707C; // METAc
        if (r == 4) return 0xB200000000000000000000Ab99cFa739E253872B; // MSFTc
        if (r == 5) return 0xb20000000000000000000078ee7ce2fE4908108C; // NVDAc
        return 0xb2000000000000000000001e800a7f5189430cD0; // TSLAc
    }

    /// Each stock's Aerodrome Slipstream pool with USDC, tick spacing 10, USDC as token0 (GooseGuard._pool).
    function pool(uint256 r) public pure returns (address) {
        if (r == 0) return 0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0;
        if (r == 1) return 0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b;
        if (r == 2) return 0xB1987CAD1682841b4b641d50E520777eC5Ab5542;
        if (r == 3) return 0xEAF57753BC382E0324a1D43F72E7027705a2273E;
        if (r == 4) return 0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54;
        if (r == 5) return 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;
        return 0x469337fDcc5E8f38e2E4B670B04F57865D13a7BB;
    }

    /// Stock r's pool price in USDC a share, 8 decimals (JobBase.priceOf with USDC as token0, as the Guard reads it).
    function poolPrice(uint256 r) public view returns (uint256) {
        (uint160 sqrtPriceX96,) = IClPool(pool(r)).slot0();
        uint256 q = (uint256(1) << 96) * 1e10 / sqrtPriceX96;
        return q * q / 1e10;
    }

    /// What stock r's pool can take, up to `enough`, before its price passes Aave's `price` less (a sale) or plus (a
    /// buy) `floorBps`, with DEPTH_ROOM_BPS to spare: raw shares for a sale, USDC units for a buy. The pool fills each
    /// swap through that range, so its average price clears the floor.
    function stockDepth(uint256 r, uint256 price, bool buy, uint256 floorBps, uint256 enough)
        public
        view
        returns (uint256)
    {
        // USDC is token0, the stock token1: the pool's price is raw shares per raw USDC. A sale (token1 in) raises it
        // and a buy (token0 in) lowers it; at Aave's price × bps / 1e4 it is 1e10 × 1e4 / (price × bps).
        uint256 bps = buy ? 1e4 + floorBps - DEPTH_ROOM_BPS : 1e4 - floorBps + DEPTH_ROOM_BPS;
        uint160 limit = PoolDepth.sqrtOf(1e10 * 1e4, price * bps);
        return _min(PoolDepth.maxIn(pool(r), STOCK_SPACING, buy, limit, enough), enough);
    }

    // ================================================================== reads

    /// The account's agents, rescue and settings, from the Guard.
    function _ctx(address a) internal view returns (Ctx memory c) {
        c.a = a;
        (IGooseGuard.Account memory acc, IGooseGuard.Settings memory set) = GUARD.accountOf(a);
        (c.jobs, c.rescueAt, c.sessionAt) = (acc.jobs, acc.rescueAt, acc.sessionAt);
        (c.mix, c.mixSetAt, c.keepMix, c.topUpsOn, c.keep) =
        (set.mix, set.mixSetAt, set.keepMix, set.topUpsOn, set.keep);
        c.rescuing = c.rescueAt != 0 && block.timestamp <= uint256(c.rescueAt) + RESCUE_MAX_AGE;
    }

    /// The account's lines and Aave's stored reading of it. `d` is left empty when nothing is owed. Aave's account
    /// read is the costly one (about 60k gas for one stock, 390k for seven), so it's read once.
    function _health(Ctx memory c) internal view returns (ISpoke.UserAccountData memory d) {
        (c.line, c.target) = GUARD.linesOf(c.a); // the user's own, or the defaults
        c.debt = SPOKE.getUserTotalDebt(USDC_RESERVE_ID, c.a);
        if (c.debt == 0) {
            c.hf = type(uint256).max;
        } else {
            d = SPOKE.getUserAccountData(c.a);
            c.hf = d.healthFactor;
        }
    }

    /// The account's registered permission for `job`, decoded (a junk one reverts, and the caller's try skips it). One
    /// longer than MAX_GRANT_BYTES is left undecoded and counts as none.
    function _permission(address a, uint8 job) internal view returns (PM.Permission memory p) {
        bytes memory raw = GUARD.permissionOf(a, job);
        if (raw.length == 0 || raw.length > MAX_GRANT_BYTES) return p;
        p = abi.decode(raw, (PM.Permission));
    }

    function _alive(address a, uint8 job) internal view returns (bool) {
        return _aliveP(a, job, _permission(a, job));
    }

    /// The manager would run a batch of `job` under `p` now: it's for this account and this Guard, inside its time
    /// window, every call it lists has no checker and every spend has no limit (the app's template), it lists the
    /// calls every move of `job` makes, the manager still owns the account, and it isn't revoked. Otherwise every move would be refused, and a junk grant at
    /// the lowest health would take a write's slots from real accounts. (The Guard registers only an approved one.)
    function _aliveP(address a, uint8 job, PM.Permission memory p) internal view returns (bool) {
        if (p.account != a || p.spender != address(GUARD)) return false;
        if (p.start > block.timestamp || p.end < block.timestamp) return false;
        for (uint256 i; i < p.calls.length; ++i) {
            if (p.calls[i].checker != address(0)) return false;
        }
        // The app's template (decision 9): every limit is the maximum. A capped grant would let a paying attacker's
        // tiny repays look like a rescue (GG-01); the app never grants one.
        for (uint256 i; i < p.spends.length; ++i) {
            if (p.spends[i].allowance != type(uint160).max) return false;
        }
        if (!_listsJob(p, job)) return false;
        if (!_managerOwns(a)) return false;
        return !MANAGER.isRevoked(p);
    }

    /// The calls every move of `job` makes, as the app grants them. A stock's approve and a coin's swap are checked
    /// per move, by what it moves.
    function _listsJob(PM.Permission memory p, uint8 job) internal pure returns (bool) {
        if (job == JOB_ENTRY) return true;
        if (job == JOB_REBALANCE) {
            return _lists(p, address(USDC), APPROVE) && _lists(p, STOCK_ROUTER, IAeroRouter.exactInputSingle.selector);
        }
        if (!_lists(p, address(USDC), APPROVE)) return false;
        if (job == JOB_SAVE) return _lists(p, AAVE_V3_POOL, IAaveV3Pool.supply.selector);
        if (!_lists(p, address(SPOKE), ISpoke.repay.selector)) return false;
        if (job == JOB_PROTECT) return _lists(p, AAVE_V3_POOL, IAaveV3Pool.withdraw.selector);
        return _lists(p, address(SPOKE), ISpoke.withdraw.selector)
            && _lists(p, STOCK_ROUTER, IAeroRouter.exactInputSingle.selector);
    }

    /// JobBase.managerOwns: a gas-capped `isOwnerAddress(manager)` that counts any odd answer as no.
    function _managerOwns(address account) internal view returns (bool owns) {
        bytes memory data = abi.encodeCall(IJustanAccount.isOwnerAddress, (address(MANAGER)));
        assembly ("memory-safe") {
            let ok := staticcall(50000, account, add(data, 0x20), mload(data), 0x00, 0x20)
            owns := and(and(ok, eq(returndatasize(), 0x20)), eq(mload(0x00), 1))
        }
    }

    /// Whether the permission lets the account call `selector` on `target`.
    function _lists(PM.Permission memory p, address target, bytes4 selector) internal pure returns (bool) {
        for (uint256 i; i < p.calls.length; ++i) {
            if (p.calls[i].target == target && p.calls[i].selector == selector) return true;
        }
        return false;
    }

    /// What the permission may still spend of `token` this period: unlimited when it lists the token, 0 when it doesn't
    /// (the manager would refuse the batch). Only a live grant is asked (`_aliveP`), and a live grant is the app's
    /// template, every limit at the maximum (decision 9), so no period is read.
    function _spendLeft(PM.Permission memory p, address token) internal pure returns (uint256) {
        for (uint256 i; i < p.spends.length; ++i) {
            if (p.spends[i].token == token) return type(uint128).max;
        }
        return 0;
    }

    /// The wallet rule (decision 1): what may go into the mix now is wallet USDC above the keep-back and above what
    /// tops savings up to Keep, less what a repay this round takes. Savings never go into stock.
    function _topUpRoom(address a, uint256 keep, uint256 walletUsed) internal view returns (uint256) {
        uint256 toKeep = _sub(keep, AUSDC.balanceOf(a));
        return _sub(USDC.balanceOf(a), KEEP_BACK + toKeep + walletUsed);
    }

    // ================================================================== small helpers

    function _move(address a, uint8 kind, uint256[] memory args) internal pure returns (Move memory) {
        return Move(a, kind, args);
    }

    function _two(uint256 x, uint256 y) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = x;
        a[1] = y;
    }

    function _trim(Move[] memory a, uint256 n) internal pure returns (Move[] memory) {
        assembly ("memory-safe") {
            mstore(a, n)
        }
        return a;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /// a − b, floored at 0.
    function _sub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
