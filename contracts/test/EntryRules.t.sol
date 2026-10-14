// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Coin, EntryLimits, EntryRules} from "../src/EntryRules.sol";
import {Vectors} from "./Vectors.sol";

/// The Entry rule against the TypeScript reference (planEntry in lib/guardian/entry.ts), on the vectors
/// scripts/agent-vectors.ts exported, plus the plan's cases: the 99.5% floor with decimals adjusted, splitting a large
/// balance, the daily limit, and a coin that is waiting.
contract EntryRulesTest is Test {
    function test_plan_agrees_with_planEntry() public view {
        string memory json = vm.readFile("test/vectors/entry.json");
        bytes memory indexes = vm.parseJsonBytes(json, ".indexes");
        uint256[] memory amountIns = vm.parseJsonUintArray(json, ".amountIns");
        uint256[] memory minOuts = vm.parseJsonUintArray(json, ".minOuts");
        assertEq(indexes.length, 1000);
        uint256[5] memory seen;
        for (uint256 i; i < indexes.length; ++i) {
            Vectors.Entry memory v = Vectors.entryInput(i);
            (bool found, uint256 index, uint256 amountIn, uint256 minOut) =
                EntryRules.plan(v.coins, EntryLimits(v.floorBps, v.minEntry, v.maxSwap));
            string memory at = string.concat("vector ", vm.toString(i));
            assertEq(found ? index : 255, uint8(indexes[i]), at);
            assertEq(amountIn * (found ? 1 : 0), amountIns[i], at);
            assertEq(minOut * (found ? 1 : 0), minOuts[i], at);
            ++seen[found ? index : 4];
        }
        for (uint256 k; k < 5; ++k) {
            assertGt(seen[k], 50, "every coin, and none, covered");
        }
    }

    /// $1,000 of an 18-decimal coin swaps for at least $995 of USDC; of a 6-decimal one the same.
    function test_the_floor_is_99_5_percent_of_face_value_decimals_adjusted() public pure {
        Coin[] memory c = _coins();
        c[1].balance = 1_000e18;
        (bool found, uint256 index, uint256 amountIn, uint256 minOut) = EntryRules.plan(c, _limits());
        assertTrue(found);
        assertEq(index, 1);
        assertEq(amountIn, 1_000e18);
        assertEq(minOut, 995e6);
        c[1].balance = 0;
        c[0].balance = 1_000e6;
        (,, amountIn, minOut) = EntryRules.plan(c, _limits());
        assertEq(minOut, 995e6);
        // Dust rounds the floor up, never down.
        c[0].balance = 0;
        c[3].balance = 1e18 + 1;
        (,,, minOut) = EntryRules.plan(c, _limits());
        assertEq(minOut, 0.995e6 + 1);
    }

    /// A $30,000 USDT balance goes in $10,000 swaps, one a run, within the day's limit.
    function test_a_large_balance_is_split_and_the_daily_limit_holds() public pure {
        Coin[] memory c = _coins();
        c[0].balance = 30_000e6;
        (,, uint256 amountIn,) = EntryRules.plan(c, _limits());
        assertEq(amountIn, 10_000e6, "one capped swap");
        c[0].limitLeft = 4_000e6;
        (,, amountIn,) = EntryRules.plan(c, _limits());
        assertEq(amountIn, 4_000e6, "what today's limit leaves");
        c[0].limitLeft = 0.5e6;
        (bool found,,,) = EntryRules.plan(c, _limits());
        assertFalse(found, "under the minimum once the limit is nearly used");
    }

    function test_a_waiting_coin_is_skipped_for_the_next() public pure {
        Coin[] memory c = _coins();
        c[0].balance = 500e6;
        c[2].balance = 200e6;
        c[0].waiting = true;
        (, uint256 index,,) = EntryRules.plan(c, _limits());
        assertEq(index, 2);
    }

    function test_limit_bounds() public pure {
        assertTrue(EntryRules.limitsOk(_limits()));
        assertFalse(EntryRules.limitsOk(EntryLimits(101, 1e6, 10_000e6)), "never under 99%");
        assertFalse(EntryRules.limitsOk(EntryLimits(50, 1e6, 99e6)));
    }

    /// config/risk.ts ENTRY.
    function _limits() internal pure returns (EntryLimits memory) {
        return EntryLimits({floorBps: 50, minEntry: 1e6, maxSwap: 10_000e6});
    }

    /// USDT, USDe, USDbC, USDS, empty, with limits that never bind.
    function _coins() internal pure returns (Coin[] memory c) {
        c = new Coin[](4);
        uint8[4] memory decimals = [6, 18, 6, 18];
        for (uint256 k; k < 4; ++k) {
            c[k].decimals = decimals[k];
            c[k].limitLeft = 1e30;
        }
    }
}
