// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ProtectCase} from "./CashRules.sol";
import {NyCalendar} from "./NyCalendar.sol";
import {IGooseGuard, PlanBase} from "./planner/PlanBase.sol";
import {ProtectPlanner} from "./planner/ProtectPlanner.sol";
import {CashPlanner} from "./planner/CashPlanner.sol";
import {TradePlanner} from "./planner/TradePlanner.sol";

/// @title GoosePlanner
/// @notice Works out GreedyGoose's moves for GooseGuard (spec-final-v2.md §10). KeeperHub calls `checkUpkeep` every 10
///         minutes, twice a round, and sends what it returns to `GooseGuard.performUpkeep`. The Planner is stateless:
///         it holds no state, no permission and no money, and the Guard bounds every amount it proposes again on live
///         reads. So it can be replaced any day by repointing KeeperHub's two read steps, with nothing for users to do.
///
///         One read, each account in its own `try` so one account's revert can't stop the round for everyone:
///         1. Protect scan: each member, from a golden-ratio start keyed on the round, until the scan's share of the
///            read budget is used. Candidates: under their own line, in a rescue under their target, or with a rescue
///            to end.
///         2. Protect plan (ProtectPlanner), most USDC Protect can put toward the need first (ProtectPlanner.rankOf;
///            spec §10 changes here from lowest health first: GG-01, adopted from both judges), each candidate packed
///            into what's left of PACK_GAS as it's planned: REPAY (wallet, then savings) and SELL if still short, as
///            two moves; REFRESH after a collateral-factor raise; END for a finished or expired rescue.
///         3. One page for the rest: CONVERT and SAVE (CashPlanner), TRADE for Rebalance and top-ups (TradePlanner).
///         The write takes moves while the Guard's gas caps add up to at most PACK_GAS: Protect first, then END and
///         REFRESH, then CONVERT, TRADE, SAVE.
/// @dev The planning parts are separate contracts so each fits under the 24 KB code limit; all four are stateless,
///      and swapping any of them is a new GoosePlanner that KeeperHub reads.
contract GoosePlanner is PlanBase {
    // ================================================================== types (the app's)

    /// GooseExecutor.Action's order, which the app's planNext reads (lib/agents/next.ts:56); Refresh is new and last.
    enum Action {
        None,
        Prune,
        Repay,
        Save,
        Sell,
        EndRescue,
        Defer,
        Rebalance,
        Convert,
        Refresh
    }

    /// The app's JOBS order (GooseExecutor.Job).
    enum Job {
        Save,
        Protect,
        ProtectSell,
        Rebalance,
        Entry
    }

    /// GooseExecutor.OffReason, kept for the Plan's layout.
    enum OffReason {
        Revoked,
        Expired,
        NotOwner,
        Stuck
    }

    /// GooseExecutor.Plan's layout: what the next round would do for one account.
    struct Plan {
        Action action;
        Job job;
        uint256 amount; // USDC units: the repay, the sale's repay, the save, a trade's buys, a conversion's input
        uint256 hf; // health before the move, WAD (max: nothing owed)
        uint8 reason; // Repay: ProtectCase.Act. Convert: the coin's index in CASH_COINS. Rebalance: 1 = a top-up
        OffReason off;
    }

    // ================================================================== types (the read's)

    /// The Protect scan's verdict on one member.
    struct Cand {
        address a;
        uint256 hf; // the order: health (scanOf), or ~ProtectPlanner.rankOf (the read); max for an END-only candidate
        bool sellOnly; // no cash: only a sale can carry it
    }

    /// One read's budget and position.
    struct Read {
        uint256 entry; // gasleft() at entry
        uint256 limit; // gas this read may use
        uint256 shard;
        uint256 shards;
        uint256 round;
        uint256 members;
        uint256 start; // the scan's first index
        bool vet; // rank candidates by what Protect can do for them (the read), not by health (scanOf)
    }

    /// Moves found this read, by tier: 0 Protect, 1 END and REFRESH, 2 the rest.
    struct Found {
        Move[][3] tier;
        uint256[3] n;
    }

    // ================================================================== policy

    /// The most gas one read uses, and what it leaves unused under whatever cap the reader sets (spec §10).
    uint256 public constant READ_GAS = 8_000_000;
    uint256 public constant READ_RESERVE = 500_000;
    /// The Protect scan stops at this share of the read's budget, Protect planning at the next; the page gets the rest.
    uint256 public constant SCAN_PCT = 60;
    uint256 public constant PROTECT_PCT = 82;
    /// Most gas one account's check or plan may take, so a runaway account can't eat the read.
    uint256 public constant CHECK_GAS = 1_500_000;
    uint256 public constant PLAN_GAS = 2_500_000;
    /// Gas a phase must still have before it plans one more account.
    uint256 public constant PLAN_ROOM = 400_000;
    /// Protect plans at most MAX_CANDS candidates a read; the scan keeps CAND_RESERVE more, so a candidate whose plan
    /// comes back empty hands its place to the next one in rank (G3).
    uint256 public constant MAX_CANDS = 24;
    uint256 public constant CAND_RESERVE = 8;
    uint256 public constant MAX_FOUND = 32;
    /// Optional policy (decision 7): leave sales and trades out while Aave's stock prices are held. Off: the Planner
    /// plans whatever the Guard accepts, weekends included.
    bool public constant SKIP_WEEKENDS = false;

    /// The Planner keeps no holidays (decision 7): never written, so NyCalendar sees weekends only.
    mapping(uint32 => bool) private _noHolidays;

    ProtectPlanner public immutable PROTECT;
    TradePlanner public immutable TRADER;
    CashPlanner public immutable CASH;

    /// Every part must plan for the same Guard.
    constructor(IGooseGuard guard, ProtectPlanner protect, TradePlanner trader, CashPlanner cash) PlanBase(guard) {
        require(protect.GUARD() == guard && trader.GUARD() == guard && cash.GUARD() == guard, "other guard");
        PROTECT = protect;
        TRADER = trader;
        CASH = cash;
    }

    // ================================================================== KeeperHub

    /// The round's moves for the Guard. `checkData = abi.encode(shard, shards)`; KeeperHub sends (0, 1) on both reads.
    /// Returns `(false, "")` when there is nothing to do.
    function checkUpkeep(bytes calldata checkData) external view returns (bool, bytes memory) {
        Read memory r;
        r.entry = gasleft();
        r.limit = r.entry > READ_RESERVE ? _min(READ_GAS, r.entry - READ_RESERVE) : 0;
        (r.shard, r.shards) = checkData.length >= 64 ? abi.decode(checkData, (uint256, uint256)) : (0, 1);
        if (r.shards == 0) r.shards = 1;
        r.round = block.timestamp / 600;
        r.members = GUARD.membersLength();
        if (r.members == 0) return (false, "");
        r.start = _start(r);
        r.vet = true;

        Found memory f = _newFound();
        (Cand[] memory cands,) = _scan(r);
        _planProtect(r, cands, f);
        _planPage(r, f);
        Move[] memory out = _pack(f);
        if (out.length == 0) return (false, "");
        return (true, abi.encode(out));
    }

    /// The scan alone, for coverage: how many members one read reaches from `round`'s start, and its candidates.
    function scanOf(uint256 round, uint256 shard, uint256 shards)
        external
        view
        returns (uint256 start, uint256 scanned, address[] memory cands)
    {
        Read memory r;
        r.entry = gasleft();
        r.limit = r.entry > READ_RESERVE ? _min(READ_GAS, r.entry - READ_RESERVE) : 0;
        (r.shard, r.shards, r.round) = (shard, shards == 0 ? 1 : shards, round);
        r.members = GUARD.membersLength();
        if (r.members == 0) return (0, 0, cands);
        r.start = start = _start(r);
        Cand[] memory c;
        (c, scanned) = _scan(r);
        cands = new address[](c.length);
        for (uint256 i; i < c.length; ++i) {
            cands[i] = c[i].a;
        }
    }

    /// Every move the next round would send for `a`, in the write's order: Protect, then CONVERT, TRADE, SAVE. Each
    /// part is planned in its own try. `round` is KeeperHub's (block.timestamp / 600); no size depends on it today.
    function planAccount(address a, uint256 round) public view returns (Move[] memory moves) {
        round;
        moves = new Move[](9);
        uint256 n;
        uint256 walletUsed;
        try PROTECT.planProtect(a) returns (Move[] memory p) {
            for (uint256 i; i < p.length; ++i) {
                moves[n++] = p[i];
                if (p[i].kind == REPAY) walletUsed = p[i].args[0];
            }
        } catch {}
        Move[] memory rest = _planRest(a, walletUsed, type(uint256).max);
        for (uint256 i; i < rest.length; ++i) {
            moves[n++] = rest[i];
        }
        _trim(moves, n);
    }

    /// The scan's cheap Protect check for one member: 0 = nothing, 1 = Protect may act, 2 = only END. Stage 1 (G5),
    /// before Aave's costly account read, for a member with no rescue: the most its rank could be (its debt with
    /// Protect · sell on, otherwise its debt within the wallet above the keep-back plus its savings); nothing when
    /// that is 0 or no more than `bar`, the worst rank a full candidate list keeps.
    function protectCheck(address a, uint256 bar) external view returns (uint8 need, uint256 hf) {
        (IGooseGuard.Account memory acc,) = GUARD.accountOf(a);
        bool protects = acc.jobs & (1 << JOB_PROTECT | 1 << JOB_SELL) != 0;
        if (!protects && acc.rescueAt == 0) return (0, 0);
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE_ID, a);
        if (debt == 0) return (acc.rescueAt != 0 ? 2 : 0, type(uint256).max);
        if (acc.rescueAt == 0) {
            uint256 most = debt;
            if (acc.jobs & (1 << JOB_SELL) == 0) {
                most = _min(debt, _sub(USDC.balanceOf(a), KEEP_BACK) + AUSDC.balanceOf(a));
            }
            if (most <= bar) return (0, 0);
        }
        hf = SPOKE.getUserAccountData(a).healthFactor;
        (uint256 line, uint256 target) = GUARD.linesOf(a);
        bool rescuing = acc.rescueAt != 0 && block.timestamp <= uint256(acc.rescueAt) + RESCUE_MAX_AGE;
        if (protects && (hf < line || (rescuing && hf + DONE_GAP < target))) return (1, hf);
        if (acc.rescueAt != 0 && (!rescuing || hf + DONE_GAP >= target)) return (2, hf);
        return (0, hf);
    }

    /// The gas left when the call arrives, and `n` bytes back: KeeperHub's read cap and payload size, measured live.
    function probe(uint256 n) external view returns (uint256 gasAtEntry, bytes memory filler) {
        gasAtEntry = gasleft();
        filler = new bytes(n);
    }

    // ================================================================== the read: scan, plan, pack

    /// Phase 1: from the round's start, each member's cheap Protect check until the scan's budget is used. Keeps the
    /// MAX_CANDS + CAND_RESERVE first in rank (lowest health in scanOf), END-only candidates after them. Returns how
    /// many members it reached. A member starts while CHECK_GAS / 3 of the scan's share is left, and its check and
    /// rank together never run past that share plus CHECK_GAS / 3, so the read can't run out of gas.
    function _scan(Read memory r) internal view returns (Cand[] memory cands, uint256 j) {
        cands = new Cand[](MAX_CANDS + CAND_RESERVE);
        uint256 n;
        uint256 stop = r.limit * SCAN_PCT / 100;
        uint256 end = stop + CHECK_GAS / 3;
        for (; j < r.members && _used(r) + CHECK_GAS / 3 < stop; ++j) {
            uint256 k = (r.start + j) % r.members;
            if (k % r.shards != r.shard % r.shards) continue;
            address a = GUARD.members(k);
            // A full list's worst rank: a member whose stage-1 bound can't beat it skips Aave's read (G5).
            uint256 bar = r.vet && n == cands.length ? ~cands[n - 1].hf : 0;
            try this.protectCheck{gas: _checkGas(r, end)}(a, bar) returns (uint8 need, uint256 hf) {
                Cand memory x = Cand(a, need == 2 ? type(uint256).max : hf, false);
                if (need == 1 && r.vet) x = _vet(r, end, a, hf);
                if (need != 0 && x.hf != 0) n = _insert(cands, n, x);
            } catch {}
        }
        assembly ("memory-safe") {
            mstore(cands, n)
        }
    }

    /// A candidate under its line ranked by what Protect can do for it (ProtectPlanner.rankOf): most first, and left
    /// out (rank 0) when no move can help. A rankOf that reverts leaves it out too.
    function _vet(Read memory r, uint256 end, address a, uint256 hf) internal view returns (Cand memory x) {
        x.a = a;
        try PROTECT.rankOf{gas: _checkGas(r, end)}(a, hf) returns (uint256 key, bool sellOnly) {
            if (key != 0) (x.hf, x.sellOnly) = (~key, sellOnly);
        } catch {}
    }

    /// Phase 2: Protect's moves for the candidates in rank order, packed as they're planned: each one fits what's left
    /// of PACK_GAS (ProtectPlanner cuts its sale to fit), and a sale is cut around the pools earlier sales in this
    /// write sell into (GG-18), so the write carries several. Planning stops when not even a repay would fit, or after
    /// MAX_CANDS plans with a move (an empty plan hands its place on, G3), and skips a sale-only candidate when a
    /// one-slice sale wouldn't fit (GG-02).
    function _planProtect(Read memory r, Cand[] memory cands, Found memory f) internal view {
        uint256 stop = r.limit * PROTECT_PCT / 100;
        uint256 room = PACK_GAS;
        uint256 taken; // stocks this write's sales sell, as bits
        uint256 planned;
        // The Guard's caps for a repay and a one-slice sale.
        uint256[2] memory least = [GUARD.capOf(REPAY, new uint256[](2)), GUARD.capOf(SELL, new uint256[](1))];
        for (uint256 i; i < cands.length && planned < MAX_CANDS; ++i) {
            if (_used(r) + PLAN_ROOM > stop || room < least[0]) break;
            if (cands[i].sellOnly && room < least[1]) continue;
            try PROTECT.planProtectExcept{gas: _planGas(r, stop)}(cands[i].a, taken, room) returns (Move[] memory m) {
                if (m.length != 0) ++planned;
                (room, taken) = _take(f, m, room, taken);
            } catch {}
        }
    }

    /// One candidate's Protect moves into the write: END and REFRESH to their tier, the rest while they fit `room`.
    /// Returns the room left and the stocks this write's sales now sell.
    function _take(Found memory f, Move[] memory m, uint256 room, uint256 taken)
        internal
        view
        returns (uint256, uint256)
    {
        for (uint256 k; k < m.length; ++k) {
            if (m[k].kind == END || m[k].kind == REFRESH) {
                _add(f, 1, m[k]);
                continue;
            }
            uint256 cap = GUARD.capOf(m[k].kind, m[k].args);
            if (cap > room) continue;
            room -= cap;
            taken |= _stocksOf(m[k]);
            _add(f, 0, m[k]);
        }
        return (room, taken);
    }

    /// Phase 3: one page of members, from the same start, for CONVERT, TRADE and SAVE; none while the Guard is paused.
    function _planPage(Read memory r, Found memory f) internal view {
        if (GUARD.paused()) return;
        for (uint256 j; j < r.members; ++j) {
            if (_used(r) + PLAN_ROOM > r.limit || f.n[2] >= MAX_FOUND) break;
            uint256 k = (r.start + j) % r.members;
            if (k % r.shards != r.shard % r.shards) continue;
            address a = GUARD.members(k);
            (IGooseGuard.Account memory acc,) = GUARD.accountOf(a);
            if (acc.jobs & (1 << JOB_SAVE | 1 << JOB_REBALANCE | 1 << JOB_ENTRY) == 0) continue;
            Move[] memory m = _planRest(a, _walletUsed(f, a), _planGas(r, r.limit));
            for (uint256 i; i < m.length; ++i) {
                _add(f, 2, m[i]);
            }
        }
    }

    /// CONVERT, TRADE and SAVE for `a`, in that order, each part in its own try with at most `gas` each.
    function _planRest(address a, uint256 walletUsed, uint256 gas) internal view returns (Move[] memory moves) {
        moves = new Move[](7);
        uint256 n;
        Move[] memory cash;
        try CASH.planCash{gas: _min(gas, gasleft())}(a, walletUsed) returns (Move[] memory m) {
            cash = m;
        } catch {}
        for (uint256 i; i < cash.length; ++i) {
            if (cash[i].kind == CONVERT) moves[n++] = cash[i];
        }
        try TRADER.planTrade{gas: _min(gas, gasleft())}(a, walletUsed) returns (Move[] memory m) {
            if (m.length > 0) moves[n++] = m[0];
        } catch {}
        for (uint256 i; i < cash.length; ++i) {
            if (cash[i].kind == SAVE) moves[n++] = cash[i];
        }
        _trim(moves, n);
    }

    /// The write: tier by tier, each move whose Guard gas cap still fits under PACK_GAS. A sale or trade through a pool
    /// another sale or trade in this write already moves waits for the next write, so each one meets the pool the
    /// Planner read.
    function _pack(Found memory f) internal view returns (Move[] memory out) {
        out = new Move[](f.n[0] + f.n[1] + f.n[2]);
        uint256 n;
        uint256 gas;
        uint256 touched; // stocks a packed SELL or TRADE moves, as bits
        bool held = SKIP_WEEKENDS && NyCalendar.frozen(_noHolidays, block.timestamp);
        for (uint256 t; t < 3; ++t) {
            for (uint256 i; i < f.n[t]; ++i) {
                Move memory m = f.tier[t][i];
                uint256 cap = GUARD.capOf(m.kind, m.args);
                if (gas + cap > PACK_GAS) continue;
                uint256 stocks = _stocksOf(m);
                if (stocks & touched != 0 || (held && stocks != 0)) continue;
                touched |= stocks;
                gas += cap;
                out[n++] = m;
            }
        }
        _trim(out, n);
    }

    // ================================================================== the app's views (today's shapes)

    /// What the next round would do for `a`: its first move, in GooseExecutor's Plan layout.
    function planOf(address a) external view returns (Plan memory p) {
        Move[] memory m = planAccount(a, block.timestamp / 600);
        if (SPOKE.getUserTotalDebt(USDC_RESERVE_ID, a) == 0) p.hf = type(uint256).max;
        else p.hf = SPOKE.getUserAccountData(a).healthFactor;
        if (m.length == 0) return p;
        Move memory first = m[0];
        uint8 kind = first.kind;
        if (kind == REPAY) {
            (p.action, p.job, p.amount) = (Action.Repay, Job.Protect, first.args[0] + first.args[1]);
            p.reason = uint8(ProtectCase.Act);
        } else if (kind == SELL) {
            (p.action, p.job) = (Action.Sell, Job.ProtectSell);
            for (uint256 i; i < first.args.length; ++i) {
                uint256 r = first.args[i] >> 248;
                p.amount += uint128(first.args[i]) * ORACLE.getReservePrice(r) * (1e4 - SALE_FLOOR_BPS) / 1e14;
            }
        } else if (kind == END) {
            (p.action, p.job) = (Action.EndRescue, Job.Protect);
        } else if (kind == REFRESH) {
            (p.action, p.job) = (Action.Refresh, Job.ProtectSell);
        } else if (kind == CONVERT) {
            (p.action, p.job, p.reason, p.amount) = (Action.Convert, Job.Entry, uint8(first.args[0]), first.args[1]);
        } else if (kind == TRADE) {
            (p.action, p.job, p.reason) = (Action.Rebalance, Job.Rebalance, first.args[0] > 0 ? 1 : 0);
            for (uint256 i = 1; i < first.args.length; ++i) {
                if (first.args[i] >> 247 & 1 == 1) p.amount += uint128(first.args[i]);
            }
        } else {
            (p.action, p.job, p.amount) = (Action.Save, Job.Save, first.args[0]);
        }
    }

    /// Every move the next round would send for `a`.
    function movesOf(address a) external view returns (Move[] memory) {
        return planAccount(a, block.timestamp / 600);
    }

    /// Protect's default line and target (GooseGuard.DEFAULT_LINE / DEFAULT_TARGET); each user's own are in
    /// `protectOf`. The weekend card's numbers (a 15% drop, Aave's line at 1.0) are the app's, kept for its layout.
    function thresholds()
        external
        pure
        returns (uint64 triggerHf, uint64 targetHf, uint64 stressDrop, uint64 stressFloorHf)
    {
        return (uint64(DEFAULT_LINE), uint64(DEFAULT_TARGET), 0.15e18, 1e18);
    }

    /// No minimums anywhere (decision 9): minRepay = minSave = 0. The keep-back is the Guard's. Saves aren't counted
    /// any more: maxSavesPerDay = 255 means no limit.
    function amounts()
        external
        view
        returns (uint64 minRepay, uint64 minSave, uint64 keepBack, uint32 weekendWindow, uint8 maxSavesPerDay)
    {
        return (0, 0, uint64(KEEP_BACK), 6 hours, type(uint8).max);
    }

    /// The Rebalancer's numbers in today's layout (TradePlanner.limits): minTrade = 0.
    function rebalanceLimits()
        external
        view
        returns (
            uint16 bandBps,
            uint16 bandMaxBps,
            uint16 poolGapBps,
            uint16 floorBps,
            uint64 minTrade,
            uint64 maxSlice
        )
    {
        return (
            TRADER.BAND_OF_TARGET_BPS(),
            TRADER.BAND_MAX_BPS(),
            uint16(TIGHT_BPS),
            uint16(SWAP_FLOOR_BPS),
            0,
            TRADER.REBALANCE_MAX_SLICE()
        );
    }

    /// Whether a rescue is on for `a`: started by a Protect move short of the target, and not yet 7 days old (the
    /// Guard's gate reads it the same way).
    function rescuingOf(address a) external view returns (bool) {
        (IGooseGuard.Account memory acc,) = GUARD.accountOf(a);
        return acc.rescueAt != 0 && block.timestamp <= uint256(acc.rescueAt) + RESCUE_MAX_AGE;
    }

    /// When the Guard's pacing next lets Rebalance sell for `a` (spec §4.4, decision 4): 0 = now (a new mix since the
    /// last session, 20 hours since it opened, or inside its hour), otherwise 20 hours after the last session opened.
    /// Pacing only: band trades also wait for a band to break and for health of at least 1.10 (TradePlanner.ACT_HF);
    /// top-ups are never paced.
    function nextTradeAt(address a) external view returns (uint256) {
        (IGooseGuard.Account memory acc, IGooseGuard.Settings memory s) = GUARD.accountOf(a);
        uint256 at = acc.sessionAt;
        if (s.mixSetAt > at || block.timestamp >= at + REBALANCE_GAP || block.timestamp < at + REBALANCE_SESSION) {
            return 0;
        }
        return at + REBALANCE_GAP;
    }

    /// The account's own Protect line and target, WAD.
    function protectOf(address a) external view returns (uint256 lineWad, uint256 targetWad) {
        return GUARD.linesOf(a);
    }

    /// The wallet rule, live: USDC that would go into the mix now (0 while top-ups are off). Not gated by health or a
    /// rescue, which hold it in the wallet until Protect is done.
    function topUpsReady(address a) external view returns (uint256) {
        (, IGooseGuard.Settings memory s) = GUARD.accountOf(a);
        return s.topUpsOn ? _topUpRoom(a, s.keep, 0) : 0;
    }

    /// When Aave's stock prices next stop updating (`ts` itself while they're held): 20:00 New York on Friday.
    function nextFreeze(uint256 ts) external view returns (uint256) {
        return NyCalendar.nextFreeze(_noHolidays, ts);
    }

    /// When they're next live (`ts` itself while they are): 20:00 New York on Sunday.
    function nextOpen(uint256 ts) external view returns (uint256) {
        return NyCalendar.nextOpen(_noHolidays, ts);
    }

    /// Whether Aave's stock prices are held at `ts` (weekends; the Planner keeps no holidays).
    function frozen(uint256 ts) external view returns (bool) {
        return NyCalendar.frozen(_noHolidays, ts);
    }

    // ================================================================== bookkeeping

    /// Pass `pass`'s first index over `size` members: pass × the golden ratio, scaled to the list (a Weyl sequence), so
    /// any run of rounds spreads its starts over the list however far each scan gets (the draft's _scanStart, keyed
    /// on the round instead of the block).
    function scanStart(uint256 pass, uint256 size) public pure returns (uint256 first) {
        unchecked {
            first = (pass * 0x9E3779B9 & 0xffffffff) * size >> 32;
        }
    }

    /// Where a read starts: the round's golden-ratio start. `checkData` (shard, shards) reads the members whose index is
    /// shard mod shards; a shard of `shards` or more (decision 11's `abi.encode(1, 1)` for KeeperHub's second read)
    /// reads the same members starting half the list away, so the round's two reads scan different members.
    function _start(Read memory r) internal pure returns (uint256) {
        uint256 offset = r.shard >= r.shards ? r.members / 2 : 0;
        return (scanStart(r.round, r.members) + offset) % r.members;
    }

    function _used(Read memory r) internal view returns (uint256) {
        return r.entry - gasleft();
    }

    function _planGas(Read memory r, uint256 stop) internal view returns (uint256) {
        return _min(PLAN_GAS, _sub(stop, _used(r)));
    }

    function _checkGas(Read memory r, uint256 end) internal view returns (uint256) {
        return _min(CHECK_GAS, _sub(end, _used(r)));
    }

    /// Inserts `x` into the sorted candidates (lowest `hf` first: lowest health, or most rank), keeping at most the
    /// list's length.
    function _insert(Cand[] memory cands, uint256 n, Cand memory x) internal pure returns (uint256) {
        uint256 most = cands.length;
        if (n == most && x.hf >= cands[n - 1].hf) return n;
        uint256 k = n < most ? n++ : n - 1;
        for (; k > 0 && cands[k - 1].hf > x.hf; --k) {
            cands[k] = cands[k - 1];
        }
        cands[k] = x;
        return n;
    }

    function _newFound() internal pure returns (Found memory f) {
        for (uint256 t; t < 3; ++t) {
            f.tier[t] = new Move[](MAX_FOUND);
        }
    }

    function _add(Found memory f, uint256 t, Move memory m) internal pure {
        if (f.n[t] < MAX_FOUND) f.tier[t][f.n[t]++] = m;
    }

    /// Wallet USDC this read's Protect repay for `a` takes.
    function _walletUsed(Found memory f, address a) internal pure returns (uint256) {
        for (uint256 i; i < f.n[0]; ++i) {
            Move memory m = f.tier[0][i];
            if (m.account == a && m.kind == REPAY) return m.args[0];
        }
        return 0;
    }

    /// The stocks a SELL or TRADE moves through their pools, as bits.
    function _stocksOf(Move memory m) internal pure returns (uint256 bits) {
        if (m.kind != SELL && m.kind != TRADE) return 0;
        for (uint256 i = m.kind == TRADE ? 1 : 0; i < m.args.length; ++i) {
            bits |= 1 << (m.args[i] >> 248);
        }
    }
}
