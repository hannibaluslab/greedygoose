// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GuardForkBase} from "./GuardForkBase.sol";

/// Build step 7 (spec-final-v2.md §14, items 9-10).
///
/// Replay: the same performData sent twice, in the same block and in the next. There is no nonce: every move re-reads
/// live state, so a repeat is refused, or (a sale or trade still short of its target) converges and is refused once
/// there. Nothing ever overshoots, and each repeat's gas is logged (the spec estimated under 120k).
///
/// Prices moved between the read and the write: the moves are built from one reading (as the Planner's checkUpkeep
/// would), then a real whale swap moves a pool or Aave's price jumps (its Chainlink source mocked), then KeeperHub
/// performs. The move is refused, the perform doesn't revert, and the next round (10 minutes on, re-planned on fresh
/// reads, the pool arbitraged back) runs.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardReplayForkTest -vv
contract GooseGuardReplayForkTest is GuardForkBase {
    function setUp() public {
        _setUpGuard();
    }

    /// An NVDAc-backed account drawn to `hf`, the credit's cash in savings with $50 left in the wallet, every agent on.
    function _owing(string memory name, uint256 hf) internal returns (address a) {
        a = _newJawAccount(name);
        _backUsd(a, NVDA, 4_000e6);
        _drawTo(a, hf);
        _save(a, _bal(address(USDC), a) - 50e6);
        _allOn(a);
    }

    /// Sends the same performData again and returns the repeat's reason and gas.
    function _again(address a, bytes memory performData) internal returns (bytes4 reason, uint256 gasUsed) {
        Vm.Log[] memory logs;
        (gasUsed, logs) = _perform(performData);
        reason = _reason(logs, a);
    }

    function _nextBlock() internal {
        vm.roll(block.number + 1);
        vm.warp(vm.getBlockTimestamp() + 2);
    }

    // ================================================================== replay

    /// A repay that lands at the target ends the rescue question: its repeat is refused at the gate (NotNeeded), in
    /// the same block and the next, and moves nothing.
    function test_replaying_a_repay_that_reached_the_target_is_refused_cheaply() public {
        address a = _owing("replay", 1.02e18);
        bytes memory performData = _one(a, REPAY, _a2(0, _repayTo(a, 1.123e18)));
        assertEq(_reason(_logsOf(performData), a), bytes4(0), "the first repay was refused");
        for (uint256 i; i < 2; ++i) {
            if (i == 1) _nextBlock();
            Holdings memory h = _holdings(a);
            (bytes4 reason, uint256 used) = _again(a, performData);
            console2.log(i == 0 ? "same block: repeat gas" : "next block: repeat gas", used);
            assertEq(reason, GooseGuard.NotNeeded.selector, "the repeat wasn't refused at the gate");
            _assertUnchanged(a, h);
            // The spec (14.9) estimated under 120k; the gate's two Aave reads cost more cold (logged, not asserted).
            if (used >= 120_000) console2.log("  over the spec's 120k estimate");
        }
    }

    /// A repay that lands short of the target (1.10) leaves a rescue on, so its repeat passes the gate and is refused
    /// only after its batch, by the overshoot rule: nothing moves, but it costs a whole repay's gas.
    function test_replaying_a_repay_short_of_the_target_is_refused_by_the_overshoot_rule() public {
        address a = _owing("short", 1.02e18);
        bytes memory performData = _one(a, REPAY, _a2(0, _repayTo(a, 1.10e18)));
        assertEq(_reason(_logsOf(performData), a), bytes4(0), "the first repay was refused");
        for (uint256 i; i < 2; ++i) {
            if (i == 1) _nextBlock();
            Holdings memory h = _holdings(a);
            (bytes4 reason, uint256 used) = _again(a, performData);
            console2.log(i == 0 ? "same block: repeat gas" : "next block: repeat gas", used);
            assertEq(reason, GooseGuard.Overshoot.selector, "the repeat wasn't refused");
            _assertUnchanged(a, h);
        }
    }

    /// A sale in a rescue converges: each repeat runs while it stays under the target plus 0.01, and is refused once
    /// it would pass it. Health never passes 1.13.
    function test_replaying_a_sale_converges_and_never_overshoots() public {
        address a = _owing("sale", 1.025e18);
        uint256[] memory legs = new uint256[](2);
        legs[0] = _leg(NVDA, _slice(a, NVDA, 250));
        legs[1] = legs[0];
        bytes memory performData = _one(a, SELL, legs);
        uint256 ran;
        bytes4 last;
        for (uint256 i; i < 12; ++i) {
            if (i % 2 == 1) _nextBlock();
            Holdings memory h = _holdings(a);
            (bytes4 reason, uint256 used) = _again(a, performData);
            console2.log("repeat", i, "health", _hf(a));
            console2.log("  gas", used);
            assertLe(_hf(a), 1.13e18, "a repeat overshot");
            if (reason == bytes4(0)) {
                ++ran;
            } else {
                _assertUnchanged(a, h);
                last = reason;
                break;
            }
        }
        console2.log("repeats that ran before the refusal", ran);
        assertTrue(last == GooseGuard.Overshoot.selector || last == GooseGuard.NotNeeded.selector, "never refused");
    }

    /// Save, Turn into cash and a top-up only go one way: each repeat finds nothing left to move.
    function test_replaying_one_way_moves_finds_nothing_to_move() public {
        address a = _newJawAccount("oneway");
        _saveOn(a);
        _entryOn(a);
        _rebalanceOn(a);
        deal(address(USDC), a, 501e6);
        deal(USDT, a, 100e6);
        uint16[7] memory w;
        w[AAPL] = 10_000;
        vm.startPrank(a);
        g.setMix(_pack(w));
        g.setTopUps(true, 0);
        vm.stopPrank();
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](2);
        moves[0] = _move(a, CONVERT, _a2(0, 100e6));
        moves[1] = _move(a, TRADE, _a2(400e6, _buy(AAPL, 400e6)));
        bytes memory performData = abi.encode(moves);
        (, Vm.Log[] memory logs) = _perform(performData);
        assertEq(_reasons(logs).length, 0, "the first round was refused");
        for (uint256 i; i < 2; ++i) {
            if (i == 1) _nextBlock();
            Holdings memory h = _holdings(a);
            uint256 used;
            (used, logs) = _perform(performData);
            bytes4[] memory r = _reasons(logs);
            console2.log(i == 0 ? "same block: two repeats, gas" : "next block: two repeats, gas", used);
            assertEq(r.length, 2, "a repeat ran");
            assertEq(r[0], GooseGuard.NothingToMove.selector, "the conversion");
            assertEq(r[1], GooseGuard.TooMuch.selector, "the top-up: its cash is gone");
            _assertUnchanged(a, h);
        }
        // SAVE (top-ups off): everything above $1 goes the first time.
        vm.prank(a);
        g.setTopUps(false, 0);
        deal(address(USDC), a, 200e6);
        bytes memory save = _one(a, SAVE, _a1(1_000e6));
        assertEq(_reason(_logsOf(save), a), bytes4(0));
        (bytes4 reason, uint256 gasUsed) = _again(a, save);
        console2.log("save repeat gas", gasUsed);
        assertEq(reason, GooseGuard.NothingToMove.selector);
    }

    function _logsOf(bytes memory performData) internal returns (Vm.Log[] memory logs) {
        (, logs) = _perform(performData);
    }

    // ================================================================== prices moved between the read and the write

    /// A sale built on one reading; a whale then sells 1.5% of NVDAc's pool away before the write: refused (OffBand),
    /// no revert. Ten minutes on the pool is arbitraged back and the re-planned sale runs.
    function test_a_whale_swap_between_read_and_write_refuses_then_the_next_round_runs() public {
        address a = _owing("whale", 1.025e18);
        uint256[] memory legs = new uint256[](2);
        legs[0] = _leg(NVDA, _slice(a, NVDA, 250));
        legs[1] = legs[0];
        uint160 before = _sqrtPrice(NVDA);
        _nudge(NVDA, -150);
        Holdings memory h = _holdings(a);
        (, Vm.Log[] memory logs) = _perform(_one(a, SELL, legs));
        assertEq(_reason(logs, a), GooseGuard.OffBand.selector, "the sale wasn't refused");
        _assertUnchanged(a, h);

        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        vm.roll(block.number + 300);
        _restorePool(NVDA, before);
        legs[0] = _leg(NVDA, _slice(a, NVDA, 250));
        legs[1] = legs[0];
        assertEq(_send(a, SELL, legs), bytes4(0), "the next round's sale was refused");
    }

    /// A repay built to land at 1.125; Aave's NVDAc price then jumps 1.5% before the write, so the same repay would
    /// land past 1.13: refused (Overshoot), no revert. The next round re-plans on the new price and runs.
    function test_an_oracle_jump_between_read_and_write_refuses_then_the_next_round_runs() public {
        address a = _owing("jump", 1.0e18 + 0.01e18);
        uint256 repay = _repayTo(a, 1.125e18);
        _mockPrice(NVDA, _price(NVDA) * 1015 / 1000);
        assertLt(_hf(a), 1.03e18, "the jump lifted it over the line");
        Holdings memory h = _holdings(a);
        (, Vm.Log[] memory logs) = _perform(_one(a, REPAY, _a2(0, repay)));
        assertEq(_reason(logs, a), GooseGuard.Overshoot.selector, "the stale repay wasn't refused");
        _assertUnchanged(a, h);

        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        vm.roll(block.number + 300);
        assertEq(_send(a, REPAY, _a2(0, _repayTo(a, 1.12e18))), bytes4(0), "the re-planned repay was refused");
        assertApproxEqAbs(_hf(a), 1.12e18, 0.002e18);
    }

    /// A sale built on one reading; Aave's NVDAc price then drops 2% (the pool doesn't follow yet), so the pool sits
    /// 2% over Aave's: refused (OffBand) before any withdraw. Once the pool is arbitraged down to the new price the
    /// re-planned sale runs.
    function test_an_oracle_drop_between_read_and_write_refuses_then_the_next_round_runs() public {
        address a = _owing("drop", 1.025e18);
        uint256[] memory legs = new uint256[](1);
        legs[0] = _leg(NVDA, _slice(a, NVDA, 150));
        _mockPrice(NVDA, _price(NVDA) * 98 / 100);
        Holdings memory h = _holdings(a);
        (, Vm.Log[] memory logs) = _perform(_one(a, SELL, legs));
        assertEq(_reason(logs, a), GooseGuard.OffBand.selector, "the sale wasn't refused");
        _assertUnchanged(a, h);

        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        vm.roll(block.number + 300);
        _nudge(NVDA, 0); // arbitrage: the pool meets Aave's new price
        legs[0] = _leg(NVDA, _slice(a, NVDA, 50)); // health fell with the price: a slice its withdraw can afford
        assertEq(_send(a, SELL, legs), bytes4(0), "the next round's sale was refused");
    }

    /// A Rebalance buy built on one reading; a whale buys NVDAc first and lifts its pool 0.6% over Aave's, past the
    /// buy side's 0.40%: refused (OffBand). Arbitraged back, the next round's buy runs.
    function test_a_whale_buy_before_a_rebalance_buy_refuses_then_the_next_round_runs() public {
        address a = _newJawAccount("mixbuy");
        _rebalanceOn(a);
        uint16[7] memory w;
        w[AAPL] = 5000;
        w[NVDA] = 5000;
        vm.prank(a);
        g.setMix(_pack(w));
        deal(STOCKS[AAPL], a, _sharesFor(AAPL, 1_500e6));
        deal(NVDAC, a, _sharesFor(NVDA, 500e6));
        vm.warp(vm.getBlockTimestamp() + 1);
        // The buy spends exactly the sale's floor (GG-06).
        uint256 sell = _sharesFor(AAPL, 400e6);
        uint256[] memory args = _a3(0, _leg(AAPL, sell), _buy(NVDA, sell * _price(AAPL) * 9950 / 1e14));
        uint160 before = _sqrtPrice(NVDA);
        _nudge(NVDA, 60);
        Holdings memory h = _holdings(a);
        (, Vm.Log[] memory logs) = _perform(_one(a, TRADE, args));
        assertEq(_reason(logs, a), GooseGuard.OffBand.selector, "the trade wasn't refused");
        _assertUnchanged(a, h);

        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        vm.roll(block.number + 300);
        _restorePool(NVDA, before);
        assertEq(_send(a, TRADE, args), bytes4(0), "the next round's trade was refused");
    }
}
