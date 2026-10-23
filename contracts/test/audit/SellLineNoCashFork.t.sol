// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {PlanBase} from "../../src/planner/PlanBase.sol";
import {PlannerForkBase} from "../PlannerForkBase.sol";

/// GG-19 on a Base fork, real Guard and Planner: an account Protect can't repay with cash is planned a sale between
/// its own line and 1.08 (the Guard's sellLineOf) and the Guard runs it; an account with cash at the same health is
/// left alone, as before.
///   BASE_RPC_URL=https://mainnet.base.org forge test --match-contract SellLineNoCashForkTest -vv
contract SellLineNoCashForkTest is PlannerForkBase {
    uint8 constant SELL = 2;

    function _at107(string memory name, uint256 wallet) internal returns (address a) {
        a = _newJawAccount(name);
        _openCreditAt(a, 10e8, 1.07e18);
        deal(address(USDC), a, wallet);
        _protectOn(a);
        _sellOn(a);
    }

    function test_gg19_a_sale_is_planned_at_1_07_for_a_cashless_account_and_not_for_a_cash_account() public {
        address cashless = _at107("cashless", 1e6); // the keep-back only, no savings
        address withCash = _at107("with cash", 50e6);
        assertEq(g.sellLineOf(cashless), 1.08e18, "cashless: the raised sale line");
        assertEq(g.sellLineOf(withCash), 1.03e18, "with cash: its own line");

        (uint8 need,) = planner.protectCheck(cashless, 0);
        assertEq(need, 1, "the scan keeps the cashless account");
        (need,) = planner.protectCheck(withCash, 0);
        assertEq(need, 0, "the scan leaves the cash account alone");

        PlanBase.Move[] memory m = protect.planProtect(cashless);
        assertEq(m.length, 1, "one move");
        assertEq(m[0].kind, SELL, "a sale, no repay");
        assertEq(protect.planProtect(withCash).length, 0, "nothing for the cash account");
        (uint256 key,) = protect.rankOf(cashless, _hf(cashless));
        assertGt(key, 0, "ranked");
        assertLt(key, protect.AT_RISK(), "after every account under its own line (GG-19)");

        uint256 cashDebt = SPOKE.getUserTotalDebt(7, withCash);
        RoundLog memory log;
        for (uint256 i; i < 3; ++i) {
            if (_round(log) == 0) break;
        }
        assertEq(log.refused, 0, "the Guard refused a planned move");
        (, uint256 target) = g.linesOf(cashless);
        uint256 hf = _hf(cashless);
        console2.log("cashless health after", hf);
        assertGe(hf + 0.001e18, target, "sold back to its own target");
        assertLe(hf, target + 0.01e18, "past the target plus 0.01");
        assertEq(_rescueAt(cashless), 0, "the rescue ended at the target");
        assertGe(SPOKE.getUserTotalDebt(7, withCash), cashDebt, "the cash account was repaid"); // interest only
        assertEq(SPOKE.getUserSuppliedAssets(5, withCash), 10e8, "the cash account's stock was sold");
    }
}
