// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {GuardForkBase} from "../GuardForkBase.sol";

/// Audit PoC: a runner sends TRADE moves that only sell. Each sale is "toward target", but the sale itself lowers the
/// book's total, so the next move finds the same stock over its (smaller) target again. Within one pacing session the
/// whole free position goes to wallet USDC, though the Planner's rule is "the Rebalancer never sells to cash".
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

    function test_sell_only_moves_drain_the_mix_to_cash() public {
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
        uint256 value0 = _bal(STOCKS[AAPL], a) * pa / 1e10;
        uint256 ran;
        for (uint256 i; i < 14; ++i) {
            uint256 value = _bal(STOCKS[AAPL], a) * pa / 1e10;
            uint256 target = value * 5000 / 1e4; // NVDA holds 0, so the book's total is AAPL alone
            uint256 shares = (value - target) * 1e10 / pa;
            if (shares * pa * 9950 / 1e14 == 0) break;
            vm.warp(vm.getBlockTimestamp() + 60);
            vm.roll(block.number + 30);
            bytes4 reason = _raw(a, _a2(0, _leg(AAPL, shares)));
            assertEq(reason, bytes4(0), "a sell-only move was refused");
            ++ran;
        }
        uint256 value1 = _bal(STOCKS[AAPL], a) * pa / 1e10;
        uint256 usdc1 = _bal(address(USDC), a);
        console2.log("moves that ran", ran);
        console2.log("AAPLc value before / after (USDC units)", value0, value1);
        console2.log("wallet USDC before / after", usdc0, usdc1);
        console2.log("NVDAc bought", _bal(NVDAC, a));
        assertLt(value1, 1e6, "the free AAPLc position was not drained");
        assertEq(_bal(NVDAC, a), 0);
    }
}
