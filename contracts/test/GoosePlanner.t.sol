// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {GoosePlanner} from "../src/GoosePlanner.sol";
import {IGooseGuard, PlanBase} from "../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../src/planner/TradePlanner.sol";
import {CashPlanner} from "../src/planner/CashPlanner.sol";
import {PoolDepth} from "../src/PoolDepth.sol";
import {Book, Holding, SellRules, Slice} from "../src/SellRules.sol";

/// A stand-in Guard with GooseGuard's read interface, its default numbers and its gas caps (GooseGuard.capOf).
contract MockGuard {
    address[] public members;
    mapping(address => IGooseGuard.Account) internal acc;
    mapping(address => IGooseGuard.Settings) internal set;
    bool public paused;
    uint256 public constant SALE_FLOOR_BPS = 300;
    uint256 public constant SWAP_FLOOR_BPS = 50;
    uint256 public constant BAND_BPS = 100;
    uint256 public constant TIGHT_BPS = 40;
    uint256 public constant KEEP_BACK = 1e6;
    uint256 public constant DUST = 1e6;

    function add(address a, uint8 jobs, uint32 rescueAt) external {
        members.push(a);
        acc[a] = IGooseGuard.Account(uint24(members.length), jobs, rescueAt, 0, address(0));
    }

    function membersLength() external view returns (uint256) {
        return members.length;
    }

    function setTimes(address a, uint32 rescueAt, uint32 sessionAt, uint32 mixSetAt) external {
        acc[a].rescueAt = rescueAt;
        acc[a].sessionAt = sessionAt;
        set[a].mixSetAt = mixSetAt;
    }

    function accountOf(address a) external view returns (IGooseGuard.Account memory, IGooseGuard.Settings memory) {
        return (acc[a], set[a]);
    }

    function linesOf(address) external pure returns (uint256, uint256) {
        return (1.03e18, 1.12e18);
    }

    function permissionOf(address, uint8) external pure returns (bytes memory) {
        return "";
    }

    function capOf(uint8 kind, uint256[] memory args) external pure returns (uint256) {
        if (kind == 0) return 500_000;
        if (kind == 1) return 1_200_000;
        if (kind == 2) {
            uint256 seen;
            uint256 stocks;
            for (uint256 i; i < args.length; ++i) {
                uint256 r = args[i] >> 248;
                if (r < 7 && seen >> r & 1 == 0) {
                    seen |= 1 << r;
                    ++stocks;
                }
            }
            return 1_300_000 + 450_000 * args.length + 300_000 * stocks;
        }
        if (kind == 3) return 500_000 + 320_000 * args.length;
        if (kind == 4) return 660_000;
        if (kind == 6) return 1_000_000;
        return 520_000;
    }
}

/// A stand-in Aave V4 spoke at the real spoke's address: each member's debt and health, and the gas a real
/// `getUserAccountData` costs (about 60–100k on a Base fork), so the scan meters itself as it would live.
contract MockSpoke {
    mapping(address => uint256) public debt;
    mapping(address => uint256) public hf;
    mapping(address => bool) public broken;
    uint256 public burn;

    struct UserAccountData {
        uint256 riskPremium;
        uint256 avgCollateralFactor;
        uint256 healthFactor;
        uint256 totalCollateralValue;
        uint256 totalDebtValueRay;
        uint256 activeCollateralCount;
        uint256 borrowCount;
    }

    function set(address a, uint256 d, uint256 h, bool b) external {
        debt[a] = d;
        hf[a] = h;
        broken[a] = b;
    }

    function setBurn(uint256 g) external {
        burn = g;
    }

    function getUserTotalDebt(uint256, address a) external view returns (uint256) {
        return debt[a];
    }

    function getUserAccountData(address a) external view returns (UserAccountData memory d) {
        require(!broken[a], "oracle down");
        uint256 stop = gasleft() - burn;
        while (gasleft() > stop) {}
        d.healthFactor = hf[a];
    }
}

/// ProtectPlanner with its slicer exposed (it's internal there, to keep the contract under the code limit).
contract ProtectHarness is ProtectPlanner {
    constructor(IGooseGuard g) ProtectPlanner(g) {}

    function slices(
        Book memory b,
        uint256[7] memory take,
        uint256 floorBps,
        uint256 maxSlice,
        uint256 floorHf,
        uint256 capRoom
    ) external view returns (Slice[] memory, uint256) {
        return slicesOf(b, take, floorBps, maxSlice, floorHf, capRoom);
    }
}

/// GoosePlanner with its packer exposed.
contract PlannerHarness is GoosePlanner {
    constructor(IGooseGuard g, ProtectPlanner p, TradePlanner t, CashPlanner c) GoosePlanner(g, p, t, c) {}

    function pack(Move[] memory protectMoves, Move[] memory ends, Move[] memory rest)
        external
        view
        returns (Move[] memory)
    {
        Found memory f = _newFound();
        for (uint256 i; i < protectMoves.length; ++i) {
            _add(f, 0, protectMoves[i]);
        }
        for (uint256 i; i < ends.length; ++i) {
            _add(f, 1, ends[i]);
        }
        for (uint256 i; i < rest.length; ++i) {
            _add(f, 2, rest[i]);
        }
        return _pack(f);
    }
}

/// Offline unit tests for the Planner's maths: pool depth, sale slicing, the scan's coverage and the packing.
/// Run: forge test --match-contract GoosePlannerTest -vv
contract GoosePlannerTest is Test {
    address constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    uint8 constant PROTECT_BITS = 1 << 1 | 1 << 2;

    MockGuard guard;
    MockSpoke spoke;
    PlannerHarness planner;
    ProtectHarness protect;

    function setUp() public {
        guard = new MockGuard();
        vm.etch(SPOKE, type(MockSpoke).runtimeCode);
        spoke = MockSpoke(SPOKE);
        IGooseGuard ig = IGooseGuard(address(guard));
        protect = new ProtectHarness(ig);
        planner = new PlannerHarness(ig, protect, new TradePlanner(ig), new CashPlanner(ig));
    }

    // ================================================================== PoolDepth

    function test_sqrtAt_matches_TickMath_edges_and_rises() public pure {
        assertEq(PoolDepth.sqrtAt(0), 1 << 96);
        assertEq(PoolDepth.sqrtAt(-887272), 4295128739);
        assertEq(PoolDepth.sqrtAt(887272), 1461446703485210103287273052203988822378723970342);
        assertEq(PoolDepth.sqrtAt(1), 79232123823359799118286999568);
        assertEq(PoolDepth.sqrtAt(-1), 79224201403219477170569942574);
        uint160 last;
        for (int24 t = -2000; t <= 2000; t += 37) {
            uint160 s = PoolDepth.sqrtAt(t);
            assertGt(s, last);
            last = s;
        }
    }

    function testFuzz_mulDiv_matches_the_exact_product(uint128 a, uint128 b, uint128 d) public pure {
        vm.assume(d > 0);
        assertEq(PoolDepth.mulDiv(a, b, d), uint256(a) * b / d);
    }

    function testFuzz_mulDiv_with_a_512_bit_product(uint256 a, uint256 b) public pure {
        a = bound(a, 1 << 200, type(uint256).max);
        b = bound(b, 1 << 100, type(uint256).max);
        // (a × b) / b = a, through a product far past 256 bits.
        assertEq(PoolDepth.mulDiv(a, b, b), a);
    }

    function testFuzz_sqrt_is_the_floor(uint256 x) public pure {
        uint256 z = PoolDepth.sqrt(x);
        assertLe(z * z, x);
        if (z < type(uint128).max) assertGt((z + 1) * (z + 1), x);
    }

    function testFuzz_msb_and_lsb(uint256 x) public pure {
        vm.assume(x > 0);
        uint8 m = PoolDepth.msb(x);
        assertTrue(x >> m == 1);
        uint8 l = PoolDepth.lsb(x);
        assertTrue(x >> l & 1 == 1 && x & ((uint256(1) << l) - 1) == 0);
    }

    /// One range: the token1 a price rise takes and the token0 a fall takes match L × Δ√P and L × Δ(1/√P).
    function testFuzz_amounts_in_one_range(uint128 liq, uint256 bps) public pure {
        liq = uint128(bound(liq, 1e6, 1e24));
        bps = bound(bps, 1, 500);
        uint160 a = uint160(1 << 96);
        uint160 b = uint160(uint256(a) * (1e4 + bps) / 1e4);
        uint256 up = PoolDepth.amount1(a, b, liq);
        uint256 want = uint256(liq) * bps / 1e4;
        assertApproxEqAbs(up, want, 2 + want / 1e9);
        uint256 down = PoolDepth.amount0(a, b, liq);
        // L × (1/a − 1/b) × 2^96 with a = 2^96: L × (1 − 1 / (1 + bps)).
        want = uint256(liq) - uint256(liq) * 1e4 / (1e4 + bps);
        assertApproxEqAbs(down, want, 2 + want / 1e9);
    }

    /// The limit price round-trips: (sqrtOf(num, den) / 2^96)² ≈ num / den, for ratios from 1e-6 to 1e6.
    function testFuzz_sqrtOf_round_trips(uint256 num, uint256 ratio) public pure {
        num = bound(num, 1e12, 1e30);
        ratio = bound(ratio, 1e12, 1e24); // den / num, × 1e18
        uint256 den = num * ratio / 1e18;
        uint256 s = PoolDepth.sqrtOf(num, den) * 1e9 >> 96; // √(num / den) × 1e9
        assertApproxEqRel(s * s, num * 1e18 / den, 1e13);
    }

    // ================================================================== sale slicing

    function test_the_withdraw_floor_is_1_01_from_health_1_02_and_half_the_room_under_it() public view {
        assertEq(protect.withdrawFloor(1.12e18), 1.01e18);
        assertEq(protect.withdrawFloor(1.02e18), 1.01e18);
        assertEq(protect.withdrawFloor(1.01e18), 1.005e18);
        assertEq(protect.withdrawFloor(1.004e18), 1.002e18);
        assertEq(protect.withdrawFloor(1.0001e18), 1.001e18);
    }

    /// One stock, any size, price, factor and health under the line: each slice's withdraw keeps health at least the
    /// floor; every slice's repay is exactly the Guard's minOut; the sale raises health; and a sale that isn't cut short
    /// lands between the target and the target plus 0.01 (the Guard's overshoot rule).
    function testFuzz_a_one_stock_sale_lands_at_the_target(uint256 shares, uint256 price, uint256 cf, uint256 hf0)
        public
        view
    {
        shares = bound(shares, 1e8, 1e12);
        price = bound(price, 10e8, 2_000e8);
        cf = bound(cf, 5_000, 7_900);
        hf0 = bound(hf0, 1.0001e18, 1.0299e18);
        Book memory b;
        b.usdcPrice = 1e8;
        b.usdcLeft = type(uint128).max;
        b.stocks[0] = Holding(shares, price, cf, shares, type(uint128).max);
        b.debt = SellRules.power(b.stocks) * 1e14 / hf0;
        vm.assume(b.debt > 100e26); // at least $100 owed
        uint256 aim = 1.12e18 + protect.SELL_MARGIN();
        uint256[7] memory take = SellRules.amounts(b, aim, 300, false);
        uint256 floorHf = protect.withdrawFloor(hf0);
        (Slice[] memory s, uint256 endHf) = protect.slices(b, take, 300, 5_000e6, floorHf, type(uint256).max);
        assertLe(s.length, 6);
        uint256 power = SellRules.power(b.stocks);
        uint256 debt = b.debt;
        uint256 sold;
        for (uint256 i; i < s.length; ++i) {
            power -= cf * s[i].shares * price * 1e10;
            assertGe(power * 1e14, floorHf * debt, "a withdraw under the floor");
            assertEq(s[i].minOut, s[i].shares * price * (1e4 - 300) / 1e14, "not the Guard's minOut");
            debt -= s[i].minOut * 1e20;
            sold += s[i].shares;
        }
        if (s.length > 0) assertGt(endHf, hf0, "the sale didn't raise health");
        if (sold == take[0] && sold > 0) {
            assertGe(endHf + 0.001e18, 1.12e18, "short of the target");
            assertLe(endHf, 1.13e18, "past the target plus 0.01");
        }
    }

    /// Seven stocks from 1.01: the lowest factor goes first, and the sale never overshoots.
    function test_seven_stocks_sell_lowest_factor_first() public view {
        Book memory b;
        b.usdcPrice = 1e8;
        b.usdcLeft = type(uint128).max;
        uint16[7] memory cfs = [7000, 6800, 7200, 6500, 7400, 5500, 6000];
        for (uint256 r; r < 7; ++r) {
            b.stocks[r] = Holding(2e8, (100 + 50 * r) * 1e8, cfs[r], 2e8, type(uint128).max);
        }
        b.debt = SellRules.power(b.stocks) * 1e14 / 1.01e18;
        uint256[7] memory take = SellRules.amounts(b, 1.125e18, 300, false);
        (Slice[] memory s, uint256 endHf) = protect.slices(b, take, 300, 5_000e6, protect.withdrawFloor(1.01e18), type(uint256).max);
        assertGt(s.length, 0);
        assertEq(s[0].reserveId, 5, "not the lowest factor first");
        assertLe(endHf, 1.13e18);
        console2.log("slices, end health", s.length, endHf);
    }

    /// GG-03 (a lone keep-my-mix sale over too many stocks was never sent): the sale is cut inside ProtectPlanner to the
    /// room it's given, its Guard cap fits that room, and the health it returns is the cut sale's own, so the Guard's
    /// H6 and overshoot checks run on what's sent.
    function test_a_sale_cut_to_its_room_returns_the_cut_sales_health() public view {
        Book memory b;
        b.usdcPrice = 1e8;
        b.usdcLeft = type(uint128).max;
        uint16[7] memory cfs = [7000, 6800, 7200, 6500, 7400, 5500, 6000];
        for (uint256 r; r < 7; ++r) {
            b.stocks[r] = Holding(2e8, (100 + 50 * r) * 1e8, cfs[r], 2e8, type(uint128).max);
        }
        b.debt = SellRules.power(b.stocks) * 1e14 / 1.25e18;
        uint256[7] memory take = SellRules.amounts(b, 1.405e18, 300, true); // keep my mix: some of every stock
        uint256 floorHf = protect.withdrawFloor(1.25e18);
        (Slice[] memory full, uint256 endFull) = protect.slices(b, take, 300, 5_000e6, floorHf, type(uint256).max);
        assertEq(full.length, 6, "the uncut sale");
        uint256 room = guard.capOf(2, _legsOf(full, 3));
        assertGt(guard.capOf(2, _legsOf(full, 6)), planner.PACK_GAS(), "the uncut sale fits a write");
        (Slice[] memory cut, uint256 endCut) = protect.slices(b, take, 300, 5_000e6, floorHf, room);
        assertEq(cut.length, 3, "not cut to its room");
        assertLe(guard.capOf(2, _legsOf(cut, 3)), room);
        uint256 power = SellRules.power(b.stocks);
        uint256 debt = b.debt;
        for (uint256 i; i < cut.length; ++i) {
            assertEq(cut[i].reserveId, full[i].reserveId);
            assertEq(cut[i].shares, full[i].shares);
            Holding memory h = b.stocks[cut[i].reserveId];
            power -= h.cf * cut[i].shares * h.price * 1e10;
            debt -= cut[i].minOut * 1e20;
        }
        assertEq(endCut, power * 1e14 / debt, "not the cut sale's health");
        assertLt(endCut, endFull);
        assertGt(endCut, 1.25e18, "the cut sale doesn't lift health (H6)");
    }

    function _legsOf(Slice[] memory s, uint256 n) internal pure returns (uint256[] memory legs) {
        legs = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            legs[i] = uint256(s[i].reserveId) << 248 | s[i].shares;
        }
    }

    // ================================================================== the scan

    /// Weyl starts keyed on the round: with 60 members a read over 500, every member is scanned within 30 rounds.
    function test_scan_starts_cover_the_list() public view {
        uint256 n = 500;
        uint256 m = 60;
        bool[] memory seen = new bool[](n);
        uint256 covered;
        uint256 rounds;
        for (uint256 round = 2_942_000; covered < n; ++round) {
            uint256 start = planner.scanStart(round, n);
            for (uint256 j; j < m; ++j) {
                uint256 k = (start + j) % n;
                if (!seen[k]) {
                    seen[k] = true;
                    ++covered;
                }
            }
            ++rounds;
        }
        console2.log("rounds to cover 500 at 60 a read", rounds);
        assertLe(rounds, 30);
    }

    /// With every member owing and a real spoke's read cost, the scan meters itself to the 8M read and every member is
    /// reached within a bounded number of rounds; candidates come back lowest health first.
    function test_coverage_at_500_members() public {
        _coverage(500, 80_000);
    }

    function test_coverage_at_2000_members() public {
        _coverage(2000, 80_000);
    }

    function _coverage(uint256 n, uint256 burn) internal {
        spoke.setBurn(burn);
        uint256 have = guard.membersLength();
        for (uint256 i = have; i < n; ++i) {
            address a = address(uint160(0x10000 + i));
            guard.add(a, PROTECT_BITS, 0);
            spoke.set(a, 1_000e6, 1.4e18, false);
        }
        bool[] memory seen = new bool[](n);
        uint256 covered;
        uint256 rounds;
        uint256 per;
        for (uint256 round = 2_942_000; covered < n && rounds < 500; ++round) {
            (uint256 start, uint256 scanned,) = planner.scanOf{gas: 50_000_000}(round, 0, 1);
            per = scanned;
            for (uint256 j; j < scanned; ++j) {
                uint256 k = (start + j) % n;
                if (!seen[k]) {
                    seen[k] = true;
                    ++covered;
                }
            }
            ++rounds;
        }
        console2.log("members", n);
        console2.log("  scanned a read", per);
        console2.log("  rounds until all were scanned", rounds);
        assertEq(covered, n, "a member was never scanned");
    }

    /// A member whose Aave read reverts is skipped; the others are still found, lowest health first; an END-only
    /// candidate comes after them.
    function test_the_scan_skips_a_reverting_member_and_sorts_by_health() public {
        address a = address(0xA1);
        address b = address(0xB2);
        address c = address(0xC3);
        address d = address(0xD4);
        address e = address(0xE5);
        guard.add(a, PROTECT_BITS, 0);
        guard.add(b, PROTECT_BITS, 0);
        guard.add(c, PROTECT_BITS, 0);
        guard.add(d, PROTECT_BITS, 0);
        guard.add(e, 0, uint32(block.timestamp)); // a rescue on, nothing owed: END
        spoke.set(a, 100e6, 1.02e18, false);
        spoke.set(b, 100e6, 1.0e18, true); // its oracle reverts
        spoke.set(c, 100e6, 1.01e18, false);
        spoke.set(d, 100e6, 1.5e18, false); // healthy
        (,, address[] memory cands) = planner.scanOf{gas: 50_000_000}(0, 0, 1);
        assertEq(cands.length, 3);
        assertEq(cands[0], c);
        assertEq(cands[1], a);
        assertEq(cands[2], e);
    }

    /// Shards split the members by index.
    function test_shards_split_the_members() public {
        for (uint256 i; i < 10; ++i) {
            address a = address(uint160(0x100 + i));
            guard.add(a, PROTECT_BITS, 0);
            spoke.set(a, 100e6, 1.0e18 + i * 1e15, false);
        }
        (,, address[] memory even) = planner.scanOf{gas: 50_000_000}(7, 0, 2);
        (,, address[] memory odd) = planner.scanOf{gas: 50_000_000}(7, 1, 2);
        assertEq(even.length, 5);
        assertEq(odd.length, 5);
        assertEq(even[0], address(0x100));
        assertEq(odd[0], address(0x101));
        // Decision 11's second-read input (1, 1): the same members, starting half the list away.
        (uint256 first,,) = planner.scanOf{gas: 50_000_000}(7, 0, 1);
        (uint256 second,, address[] memory all) = planner.scanOf{gas: 50_000_000}(7, 1, 1);
        assertEq(second, (first + 5) % 10);
        assertEq(all.length, 10);
    }

    // ================================================================== rescue and pacing views

    /// A rescue counts for 7 days after it started.
    function test_rescuingOf_applies_the_7_day_expiry() public {
        address a = address(0xA1);
        vm.warp(1_800_000_000);
        guard.add(a, PROTECT_BITS, 0);
        assertFalse(planner.rescuingOf(a));
        guard.setTimes(a, uint32(block.timestamp), 0, 0);
        assertTrue(planner.rescuingOf(a));
        vm.warp(block.timestamp + 7 days);
        assertTrue(planner.rescuingOf(a));
        vm.warp(block.timestamp + 1);
        assertFalse(planner.rescuingOf(a));
    }

    /// Rebalance may sell now with no session yet, inside a session's hour, 20 hours after it opened, or after a new
    /// mix; otherwise at the session's start plus 20 hours.
    function test_nextTradeAt_follows_the_pacing() public {
        address a = address(0xA1);
        uint32 t0 = 1_800_000_000;
        vm.warp(t0);
        guard.add(a, 1 << 3, 0);
        assertEq(planner.nextTradeAt(a), 0, "no session yet");
        guard.setTimes(a, 0, t0, t0 - 100);
        vm.warp(t0 + 30 minutes);
        assertEq(planner.nextTradeAt(a), 0, "inside the hour");
        vm.warp(t0 + 2 hours);
        assertEq(planner.nextTradeAt(a), t0 + 20 hours, "paced");
        guard.setTimes(a, 0, t0, t0 + 2 hours);
        assertEq(planner.nextTradeAt(a), 0, "a new mix opens a session");
        guard.setTimes(a, 0, t0, t0 - 100);
        vm.warp(t0 + 20 hours);
        assertEq(planner.nextTradeAt(a), 0, "20 hours on");
    }

    // ================================================================== packing

    function _m(address a, uint8 kind, uint256 legs, uint256 stockBits) internal pure returns (PlanBase.Move memory m) {
        uint256 n = kind == 3 ? legs + 1 : legs;
        m = PlanBase.Move(a, kind, new uint256[](n));
        uint256 i = kind == 3 ? 1 : 0;
        for (uint256 r; r < 7 && i < n; ++r) {
            if (stockBits >> r & 1 == 1) m.args[i++] = r << 248 | 1;
        }
    }

    /// Protect first, then END and REFRESH, then the rest; the caps add up to at most 5.3M, a move that doesn't fit is
    /// passed over for a smaller one after it, and a sale or trade through a stock already moved waits.
    function test_the_pack_takes_tiers_in_order_within_5_3M_and_one_move_a_pool() public view {
        PlanBase.Move[] memory p = new PlanBase.Move[](4);
        p[0] = _m(address(1), 1, 2, 0); // REPAY 1.2M
        p[1] = _m(address(1), 2, 1, 1 << 5); // SELL NVDA, 1 leg: 1.3 + 0.45 + 0.3 = 2.05M → 3.25M
        p[2] = _m(address(2), 2, 1, 1 << 5); // SELL NVDA again: waits
        p[3] = _m(address(3), 1, 2, 0); // REPAY 1.2M → 4.45M
        PlanBase.Move[] memory e = new PlanBase.Move[](2);
        e[0] = _m(address(5), 6, 0, 0); // REFRESH 1.0M: doesn't fit
        e[1] = _m(address(4), 5, 0, 0); // END 0.52M → 4.97M
        PlanBase.Move[] memory r = new PlanBase.Move[](2);
        r[0] = _m(address(6), 3, 2, 1 | 1 << 1); // TRADE 0.5 + 3 × 0.32 = 1.46M: doesn't fit
        r[1] = _m(address(7), 4, 2, 0); // CONVERT 0.66M: doesn't fit
        PlanBase.Move[] memory out = planner.pack(p, e, r);
        assertEq(out.length, 4);
        assertEq(out[0].account, address(1));
        assertEq(out[0].kind, 1);
        assertEq(out[1].kind, 2);
        assertEq(out[2].account, address(3));
        assertEq(out[3].account, address(4));
        uint256 gas;
        for (uint256 i; i < out.length; ++i) {
            gas += guard.capOf(out[i].kind, out[i].args);
        }
        assertLe(gas, planner.PACK_GAS());
    }
}
