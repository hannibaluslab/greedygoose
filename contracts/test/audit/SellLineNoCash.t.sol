// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseGuard} from "../../src/GooseGuard.sol";
import {ISpoke} from "../../src/IProtocols.sol";
import {GooseGuardTest} from "../GooseGuard.t.sol";

/// GG-19 (Mariano, round 2; Adrian's decision 2026-10-23): an account Protect can't repay with cash may be sold from
/// 1.08, not only under its own line. "Can't repay with cash": Protect off, or wallet USDC at most the keep-back and
/// no aUSDC. Repays keep the account's own line, accounts with cash keep it for sales too, a higher user line wins.
contract SellLineNoCash is GooseGuardTest {
    bytes4 constant SOLD = bytes4(keccak256("ProtectSold(address,uint256[7],uint256,uint256,uint256)"));

    /// Protect · repay and Protect · sell on, one stock backing the credit, the given cash, and one reading before the
    /// sale (`hf`) and one after it (`hfAfter`).
    function _setup(uint256 cash, uint256 savings, uint256 hf, uint256 hfAfter) internal {
        _register(account, JOB_PROTECT, _now() - 60);
        _register(account, JOB_SELL, _now() - 60);
        _mockCash(account, cash, savings);
        _mockAave(account, [uint256(100e6), 3e6], [hf, hfAfter]);
        _mockStock(account, 5, 0);
        vm.mockCall(SPOKE, abi.encodeCall(ISpoke.getUserReserveStatus, (5, account)), abi.encode(true, true));
    }

    function test_gg19_a_cashless_account_at_1_07_with_line_1_03_is_sold_but_not_repaid() public {
        _setup(1e6, 0, 1.07e18, 1.1e18); // the $1 keep-back only
        assertEq(g.sellLineOf(account), 1.08e18, "the raised sale line");
        assertEq(_perform(KEEPERHUB, _repay(account, 1e6, 0))[0], GooseGuard.NotNeeded.selector, "repay keeps 1.03");
        _mockAave(account, [uint256(100e6), 3e6], [uint256(1.07e18), 1.1e18]); // the repay read the first reading
        assertEq(_sellOutcome(_one(_sale(5, 1e8))), SOLD, "sale from 1.08");
        uint32 rescueAt = _acct(account).rescueAt;
        assertEq(rescueAt, _now(), "short of its own 1.12 target: the rescue runs on to it");
    }

    function test_gg19_protect_off_counts_as_cashless_even_with_wallet_cash() public {
        _register(account, JOB_SELL, _now() - 60);
        _mockCash(account, 50e6, 0);
        _mockAave(account, [uint256(100e6), 3e6], [uint256(1.07e18), 1.1e18]);
        _mockStock(account, 5, 0);
        vm.mockCall(SPOKE, abi.encodeCall(ISpoke.getUserReserveStatus, (5, account)), abi.encode(true, true));
        assertEq(g.sellLineOf(account), 1.08e18);
        assertEq(_sellOutcome(_one(_sale(5, 1e8))), SOLD);
    }

    function test_gg19_two_dollars_of_wallet_cash_keeps_the_own_line_for_a_sale() public {
        _setup(2e6, 0, 1.07e18, 1.1e18);
        assertEq(g.sellLineOf(account), 1.03e18, "cash above the keep-back: the own line");
        assertEq(_sellOutcome(_one(_sale(5, 1e8))), GooseGuard.NotNeeded.selector, "1.07 is above 1.03");
    }

    function test_r2_one_unit_of_savings_dust_leaves_the_line_at_1_08() public {
        _setup(1e6, 1, 1.07e18, 1.1e18); // one unit of aUSDC: a stranger's dust is no cash
        assertEq(g.sellLineOf(account), 1.08e18, "dust doesn't switch the 1.08 line off");
        assertEq(_sellOutcome(_one(_sale(5, 1e8))), SOLD);
    }

    function test_r2_one_unit_of_wallet_dust_leaves_the_line_at_1_08() public {
        _setup(1e6 + 1, 0, 1.07e18, 1.1e18);
        assertEq(g.sellLineOf(account), 1.08e18);
    }

    function test_r2_a_dollar_of_savings_keeps_the_own_line_for_a_sale() public {
        _setup(1e6, 1e6, 1.07e18, 1.1e18);
        assertEq(g.sellLineOf(account), 1.03e18);
        assertEq(_sellOutcome(_one(_sale(5, 1e8))), GooseGuard.NotNeeded.selector);
    }

    function test_gg19_a_cashless_account_at_1_08_is_not_sold() public {
        _setup(1e6, 0, 1.08e18, 1.1e18);
        assertEq(_sellOutcome(_one(_sale(5, 1e8))), GooseGuard.NotNeeded.selector, "1.08 itself is not under it");
    }

    function test_gg19_a_user_line_of_1_20_still_wins() public {
        _setup(2e6, 0, 1.15e18, 1.25e18);
        vm.prank(account);
        g.setProtect(12_000, 12_500);
        assertEq(g.sellLineOf(account), 1.2e18, "cash account: its own 1.20");
        assertEq(_sellOutcome(_one(_sale(5, 1e8))), SOLD, "1.15 is under 1.20, as before");

        _mockCash(account, 1e6, 0);
        assertEq(g.sellLineOf(account), 1.2e18, "cashless: 1.20 is above 1.08, so it stays");
    }

    function test_gg19_a_hacked_runner_cannot_sell_a_cash_account_above_its_line() public {
        address hacked = makeAddr("hacked runner");
        vm.prank(account);
        g.setRunner(hacked);
        _setup(2e6, 0, 1.07e18, 1.1e18);
        assertEq(_perform(hacked, _args(account, SELL, _one(_sale(5, 1e8))))[0], GooseGuard.NotNeeded.selector);
        assertEq(_perform(KEEPERHUB, _args(account, SELL, _one(_sale(5, 1e8))))[0], GooseGuard.NotNeeded.selector);
        // And with savings only, wallet at the keep-back: still cash, still refused.
        _mockCash(account, 1e6, 5e6);
        assertEq(_perform(hacked, _args(account, SELL, _one(_sale(5, 1e8))))[0], GooseGuard.NotNeeded.selector);
    }
}
