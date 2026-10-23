// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
import {GooseGuard} from "../../src/GooseGuard.sol";
import {IAeroPool, IAeroRouter} from "../../src/IProtocols.sol";
import {PlannerForkBase} from "../PlannerForkBase.sol";

/// Audit PoC: harsher crashes than GooseKeeperHubRoundFork's -18% / 20 accounts / NVDAc only.
///   BASE_RPC_URL=https://mainnet.base.org forge test --match-contract PlannerCrashForkTest -vv
/// CRASH_N (accounts), CRASH_BPS (fall a round, bps), CRASH_ROUNDS, CRASH_MIXED (1 = NVDA/TSLA/AAPL).
contract PlannerCrashForkTest is PlannerForkBase {
    address constant ORACLE = 0xaBaf048fD7675Ea34a84332371ffd5D55E322A47;

    function _poolTo(uint256 r, uint256 price) internal {
        address pool = AERO_FACTORY.getPool(STOCKS[r], address(USDC), 10);
        (uint160 now_,,,,,) = IAeroPool(pool).slot0();
        uint160 target = _sqrtPriceOf(price);
        if (now_ == target) return;
        bool sell = target > now_;
        address tokenIn = sell ? STOCKS[r] : address(USDC);
        uint256 amountIn = sell ? 1e14 : 1e13;
        deal(tokenIn, address(this), amountIn);
        IERC20L(tokenIn).approve(ROUTER, type(uint256).max);
        IAeroRouter(ROUTER).exactInputSingle(
            IAeroRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: sell ? address(USDC) : STOCKS[r],
                tickSpacing: 10,
                recipient: address(this),
                deadline: vm.getBlockTimestamp(),
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: target
            })
        );
    }

    function _sqrtPriceOf(uint256 price) internal pure returns (uint160) {
        uint256 q = _sqrt(price * 1e10);
        return uint160((uint256(1) << 96) * 1e10 / q);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function _owing(string memory name, uint256 r, uint256 hf, bool savings) internal returns (address a) {
        a = _newJawAccount(name);
        _backWith(a, r, 2e8);
        uint256 credit = _drawTo(a, hf);
        if (savings) _save(a, credit);
        else deal(address(USDC), a, 0);
        _protectOn(a);
        _sellOn(a);
    }

    function test_harsher_crash() public {
        uint256 n = vm.envOr("CRASH_N", uint256(50));
        uint256 bps = vm.envOr("CRASH_BPS", uint256(283)); // 0.9717^10 = 0.75
        uint256 rounds = vm.envOr("CRASH_ROUNDS", uint256(10));
        bool mixed = vm.envOr("CRASH_MIXED", uint256(1)) == 1;
        uint256[3] memory rs = [uint256(5), 6, 0];
        address[] memory a = new address[](n);
        uint256[] memory stockOf = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            stockOf[i] = mixed ? rs[i % 3] : 5;
            // healths 1.06 .. 1.35 as the original, spread over n
            a[i] = _owing(string.concat("c", vm.toString(i)), stockOf[i], 1.06e18 + i * 0.29e18 / n, i % 2 == 0);
        }
        uint256[3] memory price;
        for (uint256 j; j < 3; ++j) {
            price[j] = _price(rs[j]);
        }
        RoundLog memory log;
        uint256 lowest = type(uint256).max;
        uint256 under1;
        uint256 underLineRounds;
        uint256 noMove;
        for (uint256 k; k < rounds + 3; ++k) {
            if (k < rounds) {
                for (uint256 j; j < (mixed ? 3 : 1); ++j) {
                    price[j] = price[j] * (1e4 - bps) / 1e4;
                    vm.mockCall(
                        ORACLE, abi.encodeWithSignature("getReservePrice(uint256)", rs[j]), abi.encode(price[j])
                    );
                }
            }
            uint256[] memory hfBefore = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                hfBefore[i] = _hf(a[i]);
            }
            for (uint256 w; w < 2; ++w) {
                for (uint256 j; j < (mixed ? 3 : 1); ++j) {
                    _poolTo(rs[j], price[j]);
                }
                _rw(log);
            }
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
            vm.roll(block.number + 300);
            uint256 below;
            for (uint256 i; i < n; ++i) {
                uint256 hf = _hf(a[i]);
                if (hf < lowest) lowest = hf;
                if (hf < 1e18) ++under1;
                (uint256 line,) = g.linesOf(a[i]);
                if (hf < line) {
                    ++below;
                    if (hf <= hfBefore[i]) ++noMove;
                }
            }
            underLineRounds += below;
            console2.log("round, lowest so far, accounts under line now", k, lowest, below);
        }
        _diagnose(a);
        console2.log("account-rounds under 1.0 (liquidatable)", under1);
        console2.log("account-rounds under the line", underLineRounds);
        console2.log("account-rounds under the line with health not lifted", noMove);
        console2.log("writes, moves, refused", log.writes, log.moves, log.refused);
        console2.log("most read gas, most write gas", log.maxReadGas, log.maxWriteGas);
    }

    /// Sell-only accounts (Protect · sell grant, no cash, no Protect-from-cash grant) backed by six stocks
    /// (AAPLc..NVDAc), all six falling SIX_BPS a round for SIX_ROUNDS. SIX_N accounts at healths 1.06 upward.
    function test_six_stock_sell_only() public {
        uint256 n = vm.envOr("SIX_N", uint256(5));
        uint256 bps = vm.envOr("SIX_BPS", uint256(283));
        uint256 rounds = vm.envOr("SIX_ROUNDS", uint256(10));
        address[] memory a = new address[](n);
        for (uint256 i; i < n; ++i) {
            a[i] = _newJawAccount(string.concat("six", vm.toString(i)));
            for (uint256 r; r < 6; ++r) {
                _backWith(a[i], r, 1e8);
            }
            _drawTo(a[i], 1.06e18 + i * 0.1e18 / n);
            deal(address(USDC), a[i], 0);
            _sellOn(a[i]);
        }
        uint256[6] memory price;
        for (uint256 r; r < 6; ++r) {
            price[r] = _price(r);
        }
        RoundLog memory log;
        uint256 lowest = type(uint256).max;
        uint256 under1;
        uint256 underLineRounds;
        uint256 underLineNoMove;
        for (uint256 k; k < rounds + 3; ++k) {
            if (k < rounds) {
                for (uint256 r; r < 6; ++r) {
                    price[r] = price[r] * (1e4 - bps) / 1e4;
                    vm.mockCall(ORACLE, abi.encodeWithSignature("getReservePrice(uint256)", r), abi.encode(price[r]));
                }
            }
            uint256[] memory hfBefore = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                hfBefore[i] = _hf(a[i]);
            }
            for (uint256 w; w < 2; ++w) {
                for (uint256 r; r < 6; ++r) {
                    _poolTo(r, price[r]);
                }
                _rw(log);
            }
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
            vm.roll(block.number + 300);
            uint256 below;
            for (uint256 i; i < n; ++i) {
                uint256 hf = _hf(a[i]);
                if (hf < lowest) lowest = hf;
                if (hf < 1e18) ++under1;
                (uint256 line,) = g.linesOf(a[i]);
                if (hf < line) {
                    ++below;
                    if (hf <= hfBefore[i]) ++underLineNoMove;
                }
                console2.log("  acct, hf", i, hf);
            }
            underLineRounds += below;
            console2.log("round, lowest so far, accounts under line now", k, lowest, below);
        }
        console2.log("account-rounds under 1.0 (liquidatable)", under1);
        console2.log("account-rounds under the line", underLineRounds);
        console2.log("account-rounds under the line with health not lifted", underLineNoMove);
        console2.log("writes, moves, refused", log.writes, log.moves, log.refused);
        console2.log("most read gas, most write gas", log.maxReadGas, log.maxWriteGas);
    }

    /// For each account under its line at the end: health, savings Protect could repay with, what planProtect
    /// returns for it alone, and whether the full read (checkUpkeep) plans anything at all.
    function _diagnose(address[] memory a) internal view {
        uint256 withCash;
        uint256 withCashPlannedAlone;
        for (uint256 i; i < a.length; ++i) {
            uint256 hf = _hf(a[i]);
            (uint256 line,) = g.linesOf(a[i]);
            if (hf >= line) continue;
            uint256 sav = protect.savingsOut(a[i]);
            uint256 m = protect.planProtect(a[i]).length;
            if (sav > 0) {
                ++withCash;
                if (m > 0) ++withCashPlannedAlone;
            }
            console2.log("  under line: acct, hf, savings", i, hf, sav);
            console2.log("    planProtect alone: moves", m);
        }
        (bool need,) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        console2.log("under line with savings, of them planned when asked alone", withCash, withCashPlannedAlone);
        console2.log("full read plans anything now", need);
    }

    /// _readWrite, also logging each move's account and its health before and after the write.
    function _rw(RoundLog memory log) internal {
        (bool need, bytes memory data) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        if (!need) {
            console2.log("  read: nothing to do");
            return;
        }
        GooseGuard.Move[] memory moves = abi.decode(data, (GooseGuard.Move[]));
        uint256[] memory before = new uint256[](moves.length);
        for (uint256 i; i < moves.length; ++i) {
            before[i] = _hf(moves[i].account);
        }
        vm.recordLogs();
        vm.prank(KEEPERHUB);
        g.performUpkeep{gas: KH_GAS}(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(g) && logs[i].topics[0] == REFUSED) ++log.refused;
        }
        for (uint256 i; i < moves.length; ++i) {
            (uint256 line, uint256 target) = g.linesOf(moves[i].account);
            console2.log("  move kind, legs", moves[i].kind, moves[i].args.length);
            console2.log("    account", moves[i].account);
            console2.log("    hf before, after", before[i], _hf(moves[i].account));
            console2.log("    line, target", line, target);
        }
        ++log.writes;
        log.moves += moves.length;
    }
}

interface IERC20L {
    function approve(address, uint256) external returns (bool);
}
