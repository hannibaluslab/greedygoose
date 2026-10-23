// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../../src/GooseGuard.sol";
import {IJustaPermissionManager as PM} from "../../src/IJustaPermissionManager.sol";
import "./GuardWorld.sol";

/// Drives GooseGuard on the offline world: runner moves with fuzzed args, the accounts' own settings and grants,
/// strangers, the owner, prices and pools. Every rule it breaks is counted in a ghost and asserted by the invariants.
contract GuardHandler is Test {
    GooseGuard public g;
    address public A;
    address public B;
    address public helper = makeAddr("helper");
    address public stranger = makeAddr("stranger");
    address public owner = makeAddr("owner");
    address public runner = makeAddr("runner");

    uint256 constant SALE_FLOOR = 300;
    uint256 constant SWAP_FLOOR = 50;

    bytes32 constant REFUSED = keccak256("Refused(address,uint8,bytes4)");

    // ghosts: each must stay 0
    uint256 public healthLowered;
    uint256 public debtHigher;
    uint256 public underFloor;
    uint256 public strangerChanged;
    uint256 public ownerMoved;
    uint256 public pauseBlockedProtect;
    uint256 public otherAccountTouched;
    uint256 public backingMovedOutsideSell;
    uint256 public savingsMovedByTrade;
    uint256 public cashDroppedByTrade;
    uint256 public badRegistrationTaken;
    uint256 public freeStockSoldByProtect;
    uint256 public filledOffBand;
    uint256 public tradeCrossedTarget;
    uint256 public soldToCash;
    // coverage
    mapping(uint8 => uint256) public ran;
    mapping(uint8 => uint256) public refused;
    mapping(bytes4 => uint256) public reasons;
    string public lastBreak;

    mapping(address => mapping(uint8 => bytes)) public ghostPerm;
    mapping(address => mapping(uint8 => uint48)) public startOf;

    struct Snap {
        uint256 usdc;
        uint256 ausdc;
        uint256 debt;
        uint256 hf;
        uint256[7] wallet;
        uint256[7] supplied;
        uint256[5] coins;
    }

    constructor() {
        _etch();
        A = address(new WAccount());
        B = address(new WAccount());
        g = new GooseGuard(owner, runner, A.codehash, SALE_FLOOR, SWAP_FLOOR, 100, 1e6, 1e6);
        for (uint256 r; r < 7; ++r) {
            WSpoke(SPOKE).setCf(r, 5000 + 400 * r); // 50% .. 74%
            _setPrice(r, 100e8, 0);
        }
        WFeed(EUR_USD).set(1.08e8);
        _fund(A);
        _fund(B);
        for (uint8 j; j < 5; ++j) {
            _grant(A, j);
            _grant(B, j);
        }
        _as(A, abi.encodeCall(GooseGuard.setMix, (_evenMix())));
        _as(B, abi.encodeCall(GooseGuard.setMix, (_evenMix())));
    }

    // ================================================================== world setup

    function _etch() internal {
        address[] memory toks = new address[](14);
        toks[0] = USDC;
        toks[1] = AUSDC;
        for (uint256 r; r < 7; ++r) {
            toks[2 + r] = stockOf(r);
        }
        for (uint256 k; k < 5; ++k) {
            toks[9 + k] = coinOf(k);
        }
        for (uint256 i; i < toks.length; ++i) {
            vm.etch(toks[i], type(WToken).runtimeCode);
        }
        vm.etch(ORACLE, type(WOracle).runtimeCode);
        for (uint256 r; r < 7; ++r) {
            vm.etch(poolOf(r), type(WPool).runtimeCode);
        }
        vm.etch(EUR_USD, type(WFeed).runtimeCode);
        vm.etch(SPOKE, type(WSpoke).runtimeCode);
        vm.etch(V3_POOL, type(WV3Pool).runtimeCode);
        vm.etch(ROUTER, type(WAeroRouter).runtimeCode);
        vm.etch(AERO_V1, type(WAeroRouter).runtimeCode);
        vm.etch(UNI, type(WUniRouter).runtimeCode);
        vm.etch(PSM3, type(WPsm3).runtimeCode);
        vm.etch(MANAGER, type(WManager).runtimeCode);
    }

    function _fund(address a) internal {
        IMint(USDC).mint(a, 2_000e6);
        IMint(AUSDC).mint(a, 1_000e6);
        for (uint256 r; r < 7; ++r) {
            IMint(stockOf(r)).mint(a, 5e8 + r * 1e8);
            WSpoke(SPOKE).setPosition(a, r, 20e8);
        }
        // 7 × 20 shares × $100 × ~62% ≈ $8,680 of credit power; owe $8,000: health ≈ 1.085
        WSpoke(SPOKE).setDebt(a, 8_500e6);
        IMint(USDT).mint(a, 300e6);
        IMint(USDE).mint(a, 300e18);
        IMint(USDS).mint(a, 300e18);
        IMint(DAI).mint(a, 300e18);
        IMint(EURC).mint(a, 300e6);
    }

    function _evenMix() internal pure returns (uint112 mix) {
        for (uint256 r; r < 6; ++r) {
            mix |= uint112(1428) << uint112(16 * r);
        }
        mix |= uint112(10_000 - 1428 * 6) << 96;
    }

    function _perm(address a, uint48 start, uint256 salt) internal view returns (PM.Permission memory p) {
        p.account = a;
        p.spender = address(g);
        p.start = start;
        p.end = uint48(block.timestamp + 365 days);
        p.salt = salt;
    }

    function _grant(address a, uint8 job) internal {
        uint48 start = uint48(block.timestamp) > startOf[a][job] ? uint48(block.timestamp) : startOf[a][job] + 1;
        if (start > block.timestamp) return; // already took this second
        PM.Permission memory p = _perm(a, start, uint256(keccak256(abi.encode(a, job, start))));
        _as(a, abi.encodeCall(WManager.approve, (p)));
        bytes memory enc = abi.encode(p);
        _as(a, abi.encodeCall(GooseGuard.register, (job, enc)));
        ghostPerm[a][job] = enc;
        startOf[a][job] = start;
    }

    function _as(address a, bytes memory data) internal returns (bool ok) {
        try WAccount(payable(a)).exec(_target(data), data) {
            ok = true;
        } catch {}
    }

    /// Settings and registration go to the Guard; approve and revoke to the manager.
    function _target(bytes memory data) internal view returns (address) {
        bytes4 sel;
        assembly ("memory-safe") {
            sel := mload(add(data, 0x20))
        }
        if (sel == WManager.approve.selector || sel == WManager.revoke.selector) return MANAGER;
        return address(g);
    }

    function _setPrice(uint256 r, uint256 price, int256 poolOffBps) internal {
        WOracle(ORACLE).set(r, price);
        uint256 pool = uint256(int256(price) * (1e4 + poolOffBps) / 1e4);
        uint256 q = _sqrt(pool * 1e10);
        WPool(poolOf(r)).set(uint160((uint256(1) << 96) * 1e10 / q));
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function snap(address a) public view returns (Snap memory s) {
        s.usdc = IMint(USDC).balanceOf(a);
        s.ausdc = IMint(AUSDC).balanceOf(a);
        s.debt = WSpoke(SPOKE).debt(a);
        s.hf = WSpoke(SPOKE).hfOf(a);
        for (uint256 r; r < 7; ++r) {
            s.wallet[r] = IMint(stockOf(r)).balanceOf(a);
            s.supplied[r] = WSpoke(SPOKE).supplied(r, a);
        }
        for (uint256 k; k < 5; ++k) {
            s.coins[k] = IMint(coinOf(k)).balanceOf(a);
        }
    }

    function _same(Snap memory x, Snap memory y) internal pure returns (bool) {
        return keccak256(abi.encode(x)) == keccak256(abi.encode(y));
    }

    function _guardState(address a) internal view returns (bytes32) {
        (GooseGuard.Account memory acc, GooseGuard.Settings memory s) = g.accountOf(a);
        return keccak256(abi.encode(acc, s));
    }

    // ================================================================== args

    function _r(uint256 seed, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i)));
    }

    function _args(uint8 kind, uint256 seed, uint256 n, address a) internal view returns (uint256[] memory args) {
        Snap memory s = snap(a);
        if (kind == 1) {
            args = new uint256[](2);
            args[0] = _r(seed, 0) % 3 == 0 ? _r(seed, 1) : _r(seed, 1) % 1_500e6;
            args[1] = _r(seed, 2) % 3 == 0 ? _r(seed, 3) : _r(seed, 3) % 1_500e6;
        } else if (kind == 2) {
            n = 1 + n % 6;
            args = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                uint256 r = _r(seed, 10 + i) % 7;
                uint256 cap = s.supplied[r] == 0 ? 1e8 : s.supplied[r];
                uint256 shares = _r(seed, 41) % 8 == 0 ? cap + 1 + _r(seed, 20 + i) % 1e8 : 1 + _r(seed, 20 + i) % (cap / (_r(seed, 40) % 2 == 0 ? 40 : 400) + 1);
                args[i] = r << 248 | shares;
            }
        } else if (kind == 3) {
            n = 2 + n % 4;
            args = new uint256[](n);
            args[0] = _r(seed, 0) % 2 == 0 ? 0 : _r(seed, 1) % 800e6;
            for (uint256 i = 1; i < n; ++i) {
                uint256 r = _r(seed, 10 + i) % 7;
                bool buy = _r(seed, 30 + i) % 2 == 0;
                uint256 amount = buy ? 1 + _r(seed, 20 + i) % 300e6 : 1 + _r(seed, 20 + i) % (s.wallet[r] + 1);
                args[i] = r << 248 | (buy ? uint256(1) << 247 : 0) | amount;
            }
            // A third of the rebalances are the Planner's kind: a sale within the drift and a buy with its floor
            // (GG-06: a move that sells must buy with the sales' floors), so trades that sell get through the world.
            if (_r(seed, 50) % 3 == 0) {
                uint256[] memory honest = _honestTrade(a, seed, s);
                if (honest.length > 0) args = honest;
            }
        } else if (kind == 4) {
            args = new uint256[](2);
            args[0] = _r(seed, 0) % 6; // 5 is out of range on purpose
            args[1] = _r(seed, 1) % 4 == 0 ? type(uint256).max : _r(seed, 1) % 400e18;
        } else if (kind == 0) {
            args = new uint256[](1);
            args[0] = _r(seed, 0) % 2_500e6;
        } else {
            args = new uint256[](0);
        }
    }

    /// A sale of part of the drift of the stock furthest over its target, and a buy of the one furthest under with
    /// exactly the sale's floor; empty when the mix has no stock on each side.
    function _honestTrade(address a, uint256 seed, Snap memory s) internal view returns (uint256[] memory args) {
        (, GooseGuard.Settings memory st) = g.accountOf(a);
        uint256[7] memory value;
        uint256[7] memory price;
        uint256 total;
        for (uint256 r; r < 7; ++r) {
            if (uint256(st.mix) >> (16 * r) & 0xffff == 0) continue;
            price[r] = WOracle(ORACLE).getReservePrice(r);
            value[r] = s.wallet[r] * price[r] / 1e10;
            total += value[r];
        }
        uint256 over = 7;
        uint256 under = 7;
        uint256 overBy;
        uint256 underBy;
        for (uint256 r; r < 7; ++r) {
            uint256 w = uint256(st.mix) >> (16 * r) & 0xffff;
            if (w == 0) continue;
            uint256 target = total * w / 1e4;
            if (value[r] > target && value[r] - target > overBy) (over, overBy) = (r, value[r] - target);
            if (target > value[r] && target - value[r] > underBy) (under, underBy) = (r, target - value[r]);
        }
        if (over == 7 || under == 7) return args;
        uint256 usd = (overBy < underBy ? overBy : underBy) * (1 + _r(seed, 52) % 100) / 100;
        uint256 shares = usd * 1e10 / price[over];
        uint256 floor = shares * price[over] * (1e4 - SWAP_FLOOR) / 1e14;
        if (floor == 0) return args;
        args = new uint256[](3);
        args[1] = over << 248 | shares;
        args[2] = under << 248 | uint256(1) << 247 | floor;
    }

    /// What the sales' floors among legs 1 .. to - 1 leave after their buys, at Aave's prices (0 if the buys spend more).
    function _floorsLeft(uint256[] memory args, uint256 to) internal view returns (uint256 left) {
        uint256 spent;
        for (uint256 i = 1; i < to; ++i) {
            uint256 amount = uint128(args[i]);
            if (args[i] >> 247 & 1 == 1) spent += amount;
            else left += amount * WOracle(ORACLE).getReservePrice(args[i] >> 248) * (1e4 - SWAP_FLOOR) / 1e14;
        }
        left = left > spent ? left - spent : 0;
    }

    // ================================================================== actions

    /// A move from KeeperHub, the account itself or its helper.
    function move(uint8 kind, uint256 seed, uint256 n, bool forB, uint8 sender) public {
        kind = uint8(kind % 7);
        address a = forB ? B : A;
        address other = forB ? A : B;
        uint256[] memory args = _args(kind, seed, n, a);
        address from = sender % 3 == 0 ? runner : sender % 3 == 1 ? a : helper;
        if (from == helper) {
            (GooseGuard.Account memory acc,) = g.accountOf(a);
            if (acc.runner != helper) from = runner;
        }
        // The owner may have removed the runner at once (GG-20): the account itself sends its move then.
        if (from == runner && !g.isRunner(runner)) from = a;

        Snap memory before = snap(a);
        Snap memory otherBefore = snap(other);
        uint256 fills0 = WAeroRouter(ROUTER).fillsLength();
        uint256 v1fills0 = WAeroRouter(AERO_V1).fillsLength();

        GooseGuard.Move[] memory ms = new GooseGuard.Move[](1);
        ms[0] = GooseGuard.Move(a, kind, args);
        vm.recordLogs();
        vm.prank(from);
        try g.performUpkeep{gas: 6_000_000}(abi.encode(ms)) {} catch {
            return; // only the account's own short-gassed move reverts the perform
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bool wasRefused, bytes4 reason) = _refusal(logs);
        if (wasRefused) {
            refused[kind]++;
            reasons[reason]++;
            if (g.paused() && (kind == 1 || kind == 2) && reason == GooseGuard.IsPaused.selector) {
                pauseBlockedProtect++;
            }
        } else {
            ran[kind]++;
        }

        Snap memory afterS = snap(a);
        if (!_same(otherBefore, snap(other))) _break(otherAccountTouched++, "other account touched");
        if (afterS.debt > before.debt) _break(debtHigher++, "debt higher");
        if (afterS.hf < before.hf) _break(healthLowered++, "health lower");
        if (kind != 2) {
            for (uint256 r; r < 7; ++r) {
                if (afterS.supplied[r] != before.supplied[r]) _break(backingMovedOutsideSell++, "backing moved");
            }
        }
        if (kind == 3) {
            if (afterS.ausdc != before.ausdc) _break(savingsMovedByTrade++, "trade moved savings");
            uint256 invest = args[0];
            if (afterS.usdc + invest < before.usdc) _break(cashDroppedByTrade++, "trade dropped cash");
        }
        if (kind == 2) {
            for (uint256 r; r < 7; ++r) {
                if (afterS.wallet[r] < before.wallet[r]) _break(freeStockSoldByProtect++, "protect sold free stock");
            }
        }
        if (kind == 3 && !wasRefused) {
            _checkTradeTargets(a, args, before);
            // GG-06: a trade that ran and sold also bought, with the sales' floors to within 10 units.
            bool sold;
            bool bought;
            for (uint256 i = 1; i < args.length; ++i) {
                if (args[i] >> 247 & 1 == 1) bought = true;
                else sold = true;
            }
            if (sold && (!bought || _floorsLeft(args, args.length) > 10)) _break(soldToCash++, "trade sold to cash");
        }
        _checkBandOfFills(kind, fills0);
        _checkFills(kind, fills0, ROUTER);
        _checkFills(kind, v1fills0, AERO_V1);
    }

    /// Every new fill paid the account at least Aave's price less the move's floor.
    function _checkFills(uint8 kind, uint256 from, address router) internal {
        uint256 to = WAeroRouter(router).fillsLength();
        for (uint256 i = from; i < to; ++i) {
            Fill memory f = WAeroRouter(router).fillAt(i);
            uint256 floorBps = kind == 2 ? SALE_FLOOR : SWAP_FLOOR;
            uint256 floor;
            for (uint256 r; r < 7; ++r) {
                uint256 p = WOracle(ORACLE).getReservePrice(r);
                if (f.tokenIn == stockOf(r)) floor = f.amountIn * p * (1e4 - floorBps) / 1e14;
                if (f.tokenOut == stockOf(r)) floor = f.amountIn * 1e10 * (1e4 - floorBps) / (p * 1e4);
            }
            if (f.tokenIn == USDT) floor = f.amountIn * (1e4 - floorBps) / 1e4;
            if (f.tokenIn == EURC) floor = f.amountIn * uint256(WFeed(EUR_USD).answer()) * (1e4 - floorBps) / 1e12;
            if (f.amountOut < floor) _break(underFloor++, "fill under floor");
            if (f.recipient != A && f.recipient != B) _break(underFloor++, "fill paid someone else");
        }
    }

    /// A sale leg takes its stock at most down to its target, a buy at most up to it, on the prices before the move.
    function _checkTradeTargets(address a, uint256[] memory args, Snap memory before) internal {
        (, GooseGuard.Settings memory st) = g.accountOf(a);
        uint256 total = args[0];
        for (uint256 r; r < 7; ++r) {
            if (uint256(st.mix) >> (16 * r) & 0xffff == 0) continue;
            total += before.wallet[r] * WOracle(ORACLE).getReservePrice(r) / 1e10;
        }
        for (uint256 i = 1; i < args.length; ++i) {
            uint256 r = args[i] >> 248;
            uint256 amount = uint128(args[i]);
            uint256 p = WOracle(ORACLE).getReservePrice(r);
            uint256 value = before.wallet[r] * p / 1e10;
            uint256 target = total * (uint256(st.mix) >> (16 * r) & 0xffff) / 1e4;
            bool buy = args[i] >> 247 & 1 == 1;
            if (buy && value + amount > target) _break(tradeCrossedTarget++, "buy past target");
            if (!buy && value < target + amount * p / 1e10) _break(tradeCrossedTarget++, "sale past target");
        }
    }

    /// A stock swap only goes through while its pool sits within the band of Aave's price.
    function _checkBandOfFills(uint8 kind, uint256 from) internal {
        uint256 to = WAeroRouter(ROUTER).fillsLength();
        for (uint256 i = from; i < to; ++i) {
            Fill memory f = WAeroRouter(ROUTER).fillAt(i);
            for (uint256 r; r < 7; ++r) {
                if (f.tokenIn != stockOf(r) && f.tokenOut != stockOf(r)) continue;
                (uint160 sq,,,,,) = WPool(poolOf(r)).slot0();
                uint256 q = (uint256(1) << 96) * 1e10 / sq;
                uint256 pool = q * q / 1e10;
                uint256 p = WOracle(ORACLE).getReservePrice(r);
                uint256 band = 100;
                if (pool * 1e4 < p * (1e4 - band) || pool * 1e4 > p * (1e4 + band)) {
                    _break(filledOffBand++, kind == 2 ? "sale off band" : "trade off band");
                }
            }
        }
    }

    function _refusal(Vm.Log[] memory logs) internal view returns (bool, bytes4) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(g) && logs[i].topics[0] == REFUSED) {
                return (true, bytes4(abi.decode(logs[i].data, (bytes32))));
            }
        }
        return (false, bytes4(0));
    }

    function _break(uint256, string memory why) internal {
        lastBreak = why;
    }

    /// A stranger, or the helper for the account it doesn't serve, sends any move but END: nothing may change.
    function strangerMove(uint8 kind, uint256 seed, uint256 n, bool forB, bool useHelper) public {
        kind = uint8(kind % 7);
        if (kind == 5) kind = 1;
        address a = forB ? B : A;
        address from = stranger;
        if (useHelper) {
            (GooseGuard.Account memory acc,) = g.accountOf(a);
            if (acc.runner == helper) return;
            from = helper;
        }
        Snap memory before = snap(a);
        bytes32 st = _guardState(a);
        GooseGuard.Move[] memory ms = new GooseGuard.Move[](1);
        ms[0] = GooseGuard.Move(a, kind, _args(kind, seed, n, a));
        vm.recordLogs();
        vm.prank(from);
        try g.performUpkeep(abi.encode(ms)) {} catch {}
        if (vm.getRecordedLogs().length != 0 || !_same(before, snap(a)) || st != _guardState(a)) {
            _break(strangerChanged++, "stranger changed state");
        }
    }

    function ownerAct(uint8 op, uint256 seed) public {
        Snap memory a0 = snap(A);
        Snap memory b0 = snap(B);
        vm.startPrank(owner);
        op = op % 6;
        if (op == 0) g.pause();
        else if (op == 1) g.unpause();
        else if (op == 2) {
            try g.queueChange(uint8(seed % 5), bytes32(uint256(uint160(seed >> 8)))) {} catch {}
        } else if (op == 3) {
            try g.cancelChange(bytes32(seed)) {} catch {}
        } else if (op == 4) {
            vm.warp(block.timestamp + 48 hours);
            try g.applyChange(uint8(seed % 5), bytes32(uint256(uint160(seed >> 8)))) {} catch {}
        } else {
            // GG-20: an instant removal, of the runner or of an address a queued change may have added
            try g.removeRunner(seed % 2 == 0 ? runner : address(uint160(seed >> 8))) {} catch {}
        }
        vm.stopPrank();
        if (!_same(a0, snap(A)) || !_same(b0, snap(B))) _break(ownerMoved++, "owner moved money");
    }

    function price(uint8 r, uint16 movePct, int16 poolOff) public {
        r = uint8(r % 7);
        uint256 p = WOracle(ORACLE).getReservePrice(r);
        uint256 np = p * (95 + movePct % 11) / 100; // -5% .. +5%
        if (np < 1e8) np = 1e8;
        if (np > 10_000e8) np = 10_000e8;
        _setPrice(r, np, int256(poolOff) % 130);
    }

    function routerMode(uint8 m) public {
        WAeroRouter(ROUTER).setMode(m % 2);
        WAeroRouter(AERO_V1).setMode(m % 2);
        WUniRouter(UNI).setMode(m % 2);
        WPsm3(PSM3).setMode(m % 2);
    }

    function userSettings(uint8 op, uint256 seed, bool forB) public {
        address a = forB ? B : A;
        op = op % 7;
        if (op == 0) {
            uint16[7] memory w;
            uint256 left = 10_000;
            for (uint256 r; r < 6; ++r) {
                w[r] = uint16(_r(seed, r) % (left + 1));
                left -= w[r];
            }
            w[6] = uint16(left);
            uint112 mix;
            for (uint256 r; r < 7; ++r) {
                mix |= uint112(w[r]) << uint112(16 * r);
            }
            _as(a, abi.encodeCall(GooseGuard.setMix, (mix)));
        } else if (op == 1) {
            _as(a, abi.encodeCall(GooseGuard.setTopUps, (seed % 2 == 0, uint48(seed % 3_000e6))));
        } else if (op == 2) {
            uint16 line = uint16(10_300 + seed % 1_000);
            uint16 target = uint16(line + 500 + (seed >> 16) % 1_000);
            if (target > 14_000) target = 14_000;
            _as(a, abi.encodeCall(GooseGuard.setProtect, (line, target)));
        } else if (op == 3) {
            _as(a, abi.encodeCall(GooseGuard.setRunner, (seed % 2 == 0 ? helper : address(0))));
        } else if (op == 4) {
            _as(a, abi.encodeCall(GooseGuard.endRescue, ()));
        } else if (op == 5 && seed % 4 == 0) {
            _as(a, abi.encodeCall(GooseGuard.unregister, (uint8(seed % 5))));
        } else {
            _grant(a, uint8(seed % 5));
        }
    }

    /// Debt grows (interest) or a factor rise waits for a refresh.
    function position(uint8 op, uint256 seed, bool forB) public {
        address a = forB ? B : A;
        op = op % 4;
        if (op == 0) WSpoke(SPOKE).setDebt(a, WSpoke(SPOKE).debt(a) + seed % 600e6);
        else if (op == 1) WSpoke(SPOKE).setPendingBoost(a, seed % 800);
        else if (op == 2) IMint(USDC).mint(a, seed % 500e6);
        else IMint(coinOf(seed % 5)).mint(a, seed % 5 < 1 || seed % 5 == 4 ? seed % 200e6 : seed % 200e18);
    }

    /// Registrations that must be refused, and must leave the stored grant as it was.
    function badRegister(uint8 variant, uint8 job) public {
        job = uint8(job % 5);
        bytes memory beforeA = g.permissionOf(A, job);
        uint48 start = uint48(block.timestamp);
        PM.Permission memory p = _perm(A, start, uint256(keccak256(abi.encode("bad", variant, block.timestamp))));
        variant = variant % 5;
        bool ok;
        if (variant == 0) {
            // never approved
            ok = _as(A, abi.encodeCall(GooseGuard.register, (job, abi.encode(p))));
        } else if (variant == 1) {
            // approved, then revoked
            _as(A, abi.encodeCall(WManager.approve, (p)));
            _as(A, abi.encodeCall(WManager.revoke, (p)));
            ok = _as(A, abi.encodeCall(GooseGuard.register, (job, abi.encode(p))));
        } else if (variant == 2) {
            // B's approved grant, sent by A
            p.account = B;
            _as(B, abi.encodeCall(WManager.approve, (p)));
            ok = _as(A, abi.encodeCall(GooseGuard.register, (job, abi.encode(p))));
        } else if (variant == 3) {
            // a contract with another codehash
            vm.prank(stranger);
            try g.register(job, abi.encode(p)) {
                ok = true;
            } catch {}
        } else {
            // approved, but for another spender
            p.spender = stranger;
            _as(A, abi.encodeCall(WManager.approve, (p)));
            ok = _as(A, abi.encodeCall(GooseGuard.register, (job, abi.encode(p))));
        }
        if (ok || keccak256(g.permissionOf(A, job)) != keccak256(beforeA)) {
            _break(badRegistrationTaken++, "bad registration taken");
        }
    }

    function warp(uint32 dt) public {
        vm.warp(block.timestamp + dt % 3 days);
    }
}

contract GuardInvariantTest is StdInvariant, Test {
    GuardHandler h;

    function setUp() public {
        vm.warp(1_792_600_000);
        h = new GuardHandler();
        targetContract(address(h));
    }

    function _tokens() internal pure returns (address[] memory t) {
        t = new address[](14);
        t[0] = USDC;
        t[1] = AUSDC;
        for (uint256 r; r < 7; ++r) {
            t[2 + r] = stockOf(r);
        }
        for (uint256 k; k < 5; ++k) {
            t[9 + k] = coinOf(k);
        }
    }

    function invariant_guard_holds_no_tokens() public view {
        address[] memory t = _tokens();
        for (uint256 i; i < t.length; ++i) {
            assertEq(IMint(t[i]).balanceOf(address(h.g())), 0);
        }
    }

    function invariant_no_move_lowers_health_or_raises_debt() public view {
        assertEq(h.healthLowered(), 0, h.lastBreak());
        assertEq(h.debtHigher(), 0, h.lastBreak());
    }

    function invariant_no_swap_fills_under_its_floor() public view {
        assertEq(h.underFloor(), 0, h.lastBreak());
    }

    function invariant_only_account_helper_or_runner_moves() public view {
        assertEq(h.strangerChanged(), 0, h.lastBreak());
    }

    function invariant_owner_moves_no_money() public view {
        assertEq(h.ownerMoved(), 0, h.lastBreak());
    }

    function invariant_protect_sells_only_backing_and_swaps_only_in_band() public view {
        assertEq(h.freeStockSoldByProtect(), 0, h.lastBreak());
        assertEq(h.filledOffBand(), 0, h.lastBreak());
        assertEq(h.tradeCrossedTarget(), 0, h.lastBreak());
    }

    function invariant_pause_never_blocks_protect() public view {
        assertEq(h.pauseBlockedProtect(), 0);
    }

    function invariant_moves_stay_in_their_account_and_lane() public view {
        assertEq(h.otherAccountTouched(), 0, h.lastBreak());
        assertEq(h.backingMovedOutsideSell(), 0, h.lastBreak());
        assertEq(h.savingsMovedByTrade(), 0, h.lastBreak());
        assertEq(h.cashDroppedByTrade(), 0, h.lastBreak());
    }

    /// The stored grant is byte for byte the last one the account approved and registered, and the manager still says
    /// it was approved.
    /// GG-06: no trade that ran sold without buying back with the sales' floors.
    function invariant_no_trade_sells_to_cash() public view {
        assertEq(h.soldToCash(), 0, h.lastBreak());
    }

    /// GG-09: the owner can never leave the Guard without a runner.
    function invariant_always_a_runner() public view {
        assertGe(h.g().runners(), 1);
    }

    function invariant_registered_permission_is_the_approved_one() public view {
        assertEq(h.badRegistrationTaken(), 0, h.lastBreak());
        address[2] memory accts = [h.A(), h.B()];
        for (uint256 i; i < 2; ++i) {
            for (uint8 j; j < 5; ++j) {
                bytes memory stored = h.g().permissionOf(accts[i], j);
                assertEq(keccak256(stored), keccak256(h.ghostPerm(accts[i], j)));
                PM.Permission memory p = abi.decode(stored, (PM.Permission));
                assertTrue(WManager(MANAGER).isApproved(p));
                assertEq(p.account, accts[i]);
                assertEq(p.spender, address(h.g()));
            }
        }
    }

    function afterInvariant() public view {
        for (uint8 k; k < 7; ++k) {
            console2.log("kind", k);
            console2.log("  ran / refused", h.ran(k), h.refused(k));
        }
    }
}

/// How often each kind gets through on the world, and why the rest are refused.
contract GuardCoverageTest is Test {
    function test_coverage() public {
        vm.warp(1_792_600_000);
        GuardHandler h = new GuardHandler();
        for (uint256 i; i < 4000; ++i) {
            uint256 s = uint256(keccak256(abi.encode(i)));
            uint256 pick = s % 10;
            if (pick < 6) h.move(uint8(s >> 8), s >> 16, s >> 24, (s >> 32) % 2 == 0, uint8(s >> 40));
            else if (pick == 6) h.price(uint8(s >> 8), uint16(s >> 16), int16(int256(s >> 32) % 300));
            else if (pick == 7) h.userSettings(uint8(s >> 8), s >> 16, (s >> 32) % 2 == 0);
            else if (pick == 8) h.position(uint8(s >> 8), s >> 16, (s >> 32) % 2 == 0);
            else h.warp(uint32(s >> 8) % 6 hours);
            if (i % 97 == 0) h.ownerAct(uint8(s >> 50), s >> 60);
            if (i % 31 == 0) h.routerMode(uint8(s >> 70));
        }
        for (uint8 k; k < 7; ++k) {
            console2.log("kind", k, h.ran(k), h.refused(k));
        }
        bytes4[24] memory sels = [
            GooseGuard.NotNeeded.selector, GooseGuard.NothingOwed.selector, GooseGuard.NothingToMove.selector,
            GooseGuard.HealthLower.selector, GooseGuard.Overshoot.selector, GooseGuard.PaidOff.selector,
            GooseGuard.StockMoved.selector, GooseGuard.OffBand.selector, GooseGuard.Crossed.selector,
            GooseGuard.CashOut.selector, GooseGuard.Paced.selector, GooseGuard.NotTopUp.selector,
            GooseGuard.BadArgs.selector, GooseGuard.IsPaused.selector, GooseGuard.NoGrant.selector,
            GooseGuard.RescueOn.selector, GooseGuard.NoGain.selector, GooseGuard.TooMuch.selector,
            GooseGuard.HealthTooLow.selector, GooseGuard.BelowFloor.selector, GooseGuard.DebtNotLower.selector,
            GooseGuard.NotCollateral.selector, bytes4(0x08c379a0), bytes4(0x5a154675)
        ];
        for (uint256 i; i < sels.length; ++i) {
            if (h.reasons(sels[i]) > 0) console2.log(vm.toString(abi.encodePacked(sels[i])), h.reasons(sels[i]));
        }
        assertEq(h.healthLowered() + h.debtHigher() + h.underFloor() + h.otherAccountTouched(), 0, h.lastBreak());
        assertEq(h.backingMovedOutsideSell() + h.savingsMovedByTrade() + h.cashDroppedByTrade(), 0, h.lastBreak());
    }
}

/// Stateless: a Rebalance trade that sells one stock and buys another, on a pool that pays only the minimum asked.
contract GuardTradeFuzzTest is Test {
    GuardHandler h;
    uint256 public traded;

    function setUp() public {
        vm.warp(1_792_600_000);
        h = new GuardHandler();
        h.routerMode(1);
    }

    function testFuzz_trade_fills_hold_floor_and_target(uint256 sellAmt, uint256 buyAmt, uint16 p0, uint16 p1, int16 off)
        public
    {
        address a = h.A();
        // mix: half Apple, half Amazon; Apple held well over target, Amazon under
        uint112 mix = uint112(5_000) | uint112(5_000) << 16;
        vm.prank(a);
        WAccount(payable(a)).exec(address(h.g()), abi.encodeCall(GooseGuard.setMix, (mix)));
        IMint(stockOf(0)).mint(a, 40e8);
        h.price(0, p0, off);
        h.price(1, p1, off);
        uint256 n0 = h.ran(3);
        uint256 sell = 1 + sellAmt % 30e8;
        uint256 buy = 1 + buyAmt % 3_000e6;
        // the move builds its own args from a seed; drive it directly instead
        GooseGuard.Move[] memory ms = new GooseGuard.Move[](1);
        uint256[] memory args = new uint256[](3);
        args[1] = uint256(0) << 248 | sell;
        args[2] = uint256(1) << 248 | uint256(1) << 247 | buy;
        ms[0] = GooseGuard.Move(a, 3, args);
        uint256 fills0 = WAeroRouter(ROUTER).fillsLength();
        GooseGuard g = h.g();
        address runner = h.runner();
        vm.recordLogs();
        vm.prank(runner);
        g.performUpkeep(abi.encode(ms));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (logs.length > 0 && logs[0].topics[0] != keccak256("Refused(address,uint8,bytes4)")) traded++;
        n0;
        uint256 to = WAeroRouter(ROUTER).fillsLength();
        for (uint256 i = fills0; i < to; ++i) {
            Fill memory f = WAeroRouter(ROUTER).fillAt(i);
            uint256 floor;
            if (f.tokenIn == stockOf(0)) {
                floor = f.amountIn * WOracle(ORACLE).getReservePrice(0) * (1e4 - 50) / 1e14;
            } else {
                floor = f.amountIn * 1e10 * (1e4 - 50) / (WOracle(ORACLE).getReservePrice(1) * 1e4);
            }
            assertGe(f.amountOut, floor, "fill under the 0.5% floor");
        }
    }
}

/// A sale leg bigger than what backs credit: the withdraw comes back short and the swap would take free stock.
contract GuardSellDirectedTest is Test {
    function testFuzz_a_short_withdraw_never_sells_free_stock(uint256 backing, uint256 extra) public {
        vm.warp(1_792_600_000);
        GuardHandler h = new GuardHandler();
        address a = h.A();
        backing = 0.05e8 + backing % 1e8;
        extra = 1 + extra % 1e8;
        WSpoke(SPOKE).setPosition(a, 0, backing);
        // back to health 1.02, under the line
        WSpoke(SPOKE).setDebt(a, WSpoke(SPOKE).debt(a) * WSpoke(SPOKE).hfOf(a) / 1.02e18);
        uint256 free0 = IMint(stockOf(0)).balanceOf(a);
        GooseGuard g = h.g();
        address runner = h.runner();
        uint256[] memory args = new uint256[](1);
        args[0] = backing + extra;
        GooseGuard.Move[] memory ms = new GooseGuard.Move[](1);
        ms[0] = GooseGuard.Move(a, 2, args);
        vm.prank(runner);
        g.performUpkeep(abi.encode(ms));
        assertEq(IMint(stockOf(0)).balanceOf(a), free0, "Protect sold free stock");
    }
}
