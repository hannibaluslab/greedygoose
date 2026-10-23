// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../../src/GooseGuard.sol";
import {GuardForkBase} from "../GuardForkBase.sol";

/// Audit PoC, flipped (GG-06): a runner sends TRADE moves that only sell. Each sale is "toward target", but the sale
/// itself lowers the book's total, so the next move would find the same stock over its (smaller) target again, and
/// within one pacing session the whole free position would go to wallet USDC. Now a move that sells must also buy
/// with the sales' floors, so every sell-only move is refused with SellsToCash and the stock stays put.
contract SellToCashDrainTest is GuardForkBase {
    function setUp() public {
        _setUpGuard();
    }

    function _raw(address a, uint256[] memory args) internal returns (bytes4) {
        vm.recordLogs();
        vm.prank(KEEPERHUB);
        (bool ok,) = address(g).call{gas: KH_GAS}(abi.encodeCall(g.performUpkeep, (_one(a, TRADE, args))));
        assertTrue(ok, "perform reverted");
        return _reason(vm.getRecordedLogs(), a);
    }

    function test_sell_only_moves_are_refused_and_the_mix_stays() public {
        address a = _newJawAccount("drained");
        _rebalanceOn(a);
        uint16[7] memory w;
        w[AAPL] = 5000;
        w[NVDA] = 5000; // a new mix: NVDA not bought yet
        vm.prank(a);
        g.setMix(_pack(w));
        deal(STOCKS[AAPL], a, _sharesFor(AAPL, 2_000e6));
        vm.warp(vm.getBlockTimestamp() + 1);

        uint256 pa = _price(AAPL);
        uint256 usdc0 = _bal(address(USDC), a);
        uint256 shares0 = _bal(STOCKS[AAPL], a);
        uint256 refused;
        for (uint256 i; i < 23; ++i) {
            uint256 value = _bal(STOCKS[AAPL], a) * pa / 1e10;
            uint256 target = value * 5000 / 1e4; // NVDA holds 0, so the book's total is AAPL alone
            uint256 shares = (value - target) * 1e10 / pa;
            vm.warp(vm.getBlockTimestamp() + 60);
            vm.roll(block.number + 30);
            bytes4 reason = _raw(a, _a2(0, _leg(AAPL, shares)));
            assertEq(reason, GooseGuard.SellsToCash.selector, "a sell-only move ran");
            ++refused;
        }
        console2.log("sell-only moves refused", refused);
        console2.log("wallet USDC before / after", usdc0, _bal(address(USDC), a));
        assertEq(_bal(STOCKS[AAPL], a), shares0, "the free AAPLc position moved");
        assertEq(_bal(address(USDC), a), usdc0, "the wallet's cash moved");
        assertEq(_bal(NVDAC, a), 0);
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        assertEq(acc.sessionAt, 0, "a refused move opens no session");

        // The honest move still runs: sell $500 of AAPLc and buy NVDAc with exactly the sale's floor.
        uint256 sell = _sharesFor(AAPL, 500e6);
        uint256 floor = sell * pa * (1e4 - g.SWAP_FLOOR_BPS()) / 1e14;
        uint256[] memory args = new uint256[](3);
        args[1] = _leg(AAPL, sell);
        args[2] = NVDA << 248 | 1 << 247 | floor;
        assertEq(_raw(a, args), bytes4(0), "an honest rebalance was refused");
        assertGt(_bal(NVDAC, a), 0, "NVDAc bought");
        console2.log("honest rebalance: wallet USDC gain over the floors", _bal(address(USDC), a) - usdc0);
    }
}
