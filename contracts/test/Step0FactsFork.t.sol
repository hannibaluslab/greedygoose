// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {ForkBase} from "./ForkBase.sol";
import {ISpoke} from "./IJustaPermissionManager.sol";

/// Build step 0 of the GooseGuard spec: Aave V4 facts the Guard's frozen constants depend on, measured on a Base fork.
/// Each test logs what it measured and asserts it, so a later Aave upgrade that changes a fact fails here first.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract Step0FactsForkTest -vv
contract Step0FactsForkTest is ForkBase {
    uint256 constant SHARES = 10e8; // 10 NVDAc, about $2,200 of backing
    uint256 constant CREDIT = 500e6;

    address acct;

    function setUp() public {
        _fork();
        acct = _newJawAccount("step0");
    }

    function _withCredit() internal {
        _openCredit(acct, SHARES, CREDIT);
        deal(address(USDC), acct, 10_000e6);
        vm.prank(acct);
        USDC.approve(address(SPOKE), type(uint256).max);
    }

    function _repay(uint256 amount) internal returns (bool ok, bytes4 reason) {
        vm.prank(acct);
        bytes memory r;
        (ok, r) = address(SPOKE).call(abi.encodeWithSignature("repay(uint256,uint256,address)", USDC_RESERVE, amount, acct));
        if (!ok && r.length >= 4) reason = bytes4(r);
    }

    /// The Spoke's MustNotLeaveDust is a liquidation rule only. Does the unverified Hub refuse a repay that leaves a
    /// crumb of credit? Leaves 1 unit (a millionth of a dollar), then half a dollar.
    function test_a_repay_may_leave_a_crumb_of_credit() public {
        _withCredit();
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, acct);
        (bool ok, bytes4 reason) = _repay(debt - 1);
        uint256 left = SPOKE.getUserTotalDebt(USDC_RESERVE, acct);
        console2.log("repay leaving 1 unit: ok", ok);
        console2.logBytes4(reason);
        console2.log("credit left (USDC units)", left);
        assertTrue(ok, "a repay leaving 1 unit was refused");
        assertLe(left, 2, "more than a crumb left");

        _withCredit();
        debt = SPOKE.getUserTotalDebt(USDC_RESERVE, acct);
        (ok, reason) = _repay(debt - 0.5e6);
        console2.log("repay leaving $0.50: ok", ok);
        assertTrue(ok, "a repay leaving $0.50 was refused");
    }

    /// A repay above the debt pays the debt exactly and takes no more USDC than owed.
    function test_a_repay_above_the_debt_pays_exactly_the_debt() public {
        _withCredit();
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, acct);
        uint256 cashBefore = USDC.balanceOf(acct);
        (bool ok,) = _repay(debt + 100e6);
        uint256 paid = cashBefore - USDC.balanceOf(acct);
        console2.log("over-repay ok", ok);
        console2.log("debt before", debt);
        console2.log("USDC taken", paid);
        assertTrue(ok, "an over-repay was refused");
        assertEq(SPOKE.getUserTotalDebt(USDC_RESERVE, acct), 0, "credit left after an over-repay");
        assertEq(paid, debt, "an over-repay took more than the debt");
    }

    /// A withdraw above what's supplied withdraws what's there and doesn't revert (no credit, so no health check bites).
    function test_a_withdraw_above_the_supply_withdraws_what_is_there() public {
        _backWithNvda(acct, SHARES);
        uint256 walletBefore = IERC20Like(NVDAC).balanceOf(acct);
        vm.prank(acct);
        (bool ok,) = address(SPOKE).call(
            abi.encodeWithSignature("withdraw(uint256,uint256,address)", NVDAC_RESERVE, SHARES * 2, acct)
        );
        uint256 got = IERC20Like(NVDAC).balanceOf(acct) - walletBefore;
        console2.log("over-withdraw ok", ok);
        console2.log("shares asked", SHARES * 2);
        console2.log("shares received", got);
        assertTrue(ok, "an over-withdraw was refused");
        assertEq(got, SHARES, "an over-withdraw didn't return exactly what was supplied");
        assertEq(SPOKE.getUserSuppliedAssets(NVDAC_RESERVE, acct), 0, "supply left after an over-withdraw");
    }

    /// updateUserDynamicConfig: the account itself may call it; a stranger (the Guard, without being made a position
    /// manager) may not. So REFRESH must go through the manager, under a permission that lists the call.
    function test_only_the_account_may_refresh_its_config() public {
        _withCredit();
        bytes memory refresh = abi.encodeWithSignature("updateUserDynamicConfig(address)", acct);
        vm.prank(makeAddr("guard"));
        (bool strangerOk, bytes memory r) = address(SPOKE).call(refresh);
        console2.log("stranger refresh ok", strangerOk);
        if (r.length >= 4) console2.logBytes4(bytes4(r));
        vm.prank(acct);
        (bool selfOk,) = address(SPOKE).call(refresh);
        console2.log("account refresh ok", selfOk);
        assertFalse(strangerOk, "a stranger could refresh the account's config");
        assertTrue(selfOk, "the account couldn't refresh its own config");
    }

    /// getUserAccountData reads the stored config: it matches across a refresh when no key changed.
    function test_account_data_is_stable_across_a_no_op_refresh() public {
        _withCredit();
        ISpoke.UserAccountData memory a = SPOKE.getUserAccountData(acct);
        vm.prank(acct);
        (bool ok,) = address(SPOKE).call(abi.encodeWithSignature("updateUserDynamicConfig(address)", acct));
        ISpoke.UserAccountData memory b = SPOKE.getUserAccountData(acct);
        console2.log("health before", a.healthFactor);
        console2.log("health after", b.healthFactor);
        assertTrue(ok);
        assertEq(a.healthFactor, b.healthFactor, "a refresh with no new key moved health");
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}
