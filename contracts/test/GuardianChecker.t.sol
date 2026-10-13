// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GuardianChecker} from "../src/GuardianChecker.sol";

/// Pure checker logic — no fork needed.
contract GuardianCheckerUnitTest is Test {
    address constant USDC = address(0xC0);
    address constant POOL = address(0xA0);
    address constant SPOKE = address(0x50);
    address constant ACCOUNT = address(0xAC);
    address constant ATTACKER = address(0xBAD);
    GuardianChecker checker;

    function setUp() public {
        checker = new GuardianChecker(USDC, POOL, SPOKE, 7);
    }

    function _can(address target, uint256 value, bytes memory data) internal view returns (bool) {
        return checker.canExecute(bytes32(0), ACCOUNT, address(0x5E), target, value, data);
    }

    function test_allows_the_three_guardian_calls() public view {
        assertTrue(_can(POOL, 0, abi.encodeWithSelector(0x69328dec, USDC, 1e6, ACCOUNT)));
        assertTrue(_can(USDC, 0, abi.encodeWithSelector(0x095ea7b3, SPOKE, 1e6)));
        assertTrue(_can(SPOKE, 0, abi.encodeWithSelector(0xb1e8f8ef, uint256(7), 1e6, ACCOUNT)));
    }

    function test_rejects_withdraw_to_anyone_else_or_other_asset() public view {
        assertFalse(_can(POOL, 0, abi.encodeWithSelector(0x69328dec, USDC, 1e6, ATTACKER)));
        assertFalse(_can(POOL, 0, abi.encodeWithSelector(0x69328dec, address(0xDEAD), 1e6, ACCOUNT)));
    }

    function test_rejects_approve_to_anyone_but_spoke() public view {
        assertFalse(_can(USDC, 0, abi.encodeWithSelector(0x095ea7b3, ATTACKER, 1e6)));
        assertFalse(_can(USDC, 0, abi.encodeWithSelector(0x095ea7b3, POOL, 1e6)));
    }

    function test_rejects_repay_for_someone_else_or_other_reserve() public view {
        assertFalse(_can(SPOKE, 0, abi.encodeWithSelector(0xb1e8f8ef, uint256(7), 1e6, ATTACKER)));
        assertFalse(_can(SPOKE, 0, abi.encodeWithSelector(0xb1e8f8ef, uint256(5), 1e6, ACCOUNT)));
    }

    function test_rejects_value_wrong_target_wrong_selector_and_malformed_data() public view {
        assertFalse(_can(POOL, 1, abi.encodeWithSelector(0x69328dec, USDC, 1e6, ACCOUNT)));
        assertFalse(_can(SPOKE, 0, abi.encodeWithSelector(0x69328dec, USDC, 1e6, ACCOUNT)));
        assertFalse(_can(USDC, 0, abi.encodeWithSelector(0xa9059cbb, ATTACKER, 1e6))); // transfer
        assertFalse(_can(POOL, 0, hex"69328d"));
        assertFalse(_can(POOL, 0, ""));
        // trailing bytes
        assertFalse(_can(POOL, 0, abi.encodePacked(abi.encodeWithSelector(0x69328dec, USDC, 1e6, ACCOUNT), uint256(1))));
    }

    function testFuzz_withdraw_only_to_account(address to, uint256 amount) public view {
        bool ok = _can(POOL, 0, abi.encodeWithSelector(0x69328dec, USDC, amount, to));
        assertEq(ok, to == ACCOUNT);
    }

    function testFuzz_repay_only_for_account(address who, uint256 reserveId, uint256 amount) public view {
        bool ok = _can(SPOKE, 0, abi.encodeWithSelector(0xb1e8f8ef, reserveId, amount, who));
        assertEq(ok, who == ACCOUNT && reserveId == 7);
    }

    function test_constructor_rejects_zero_addresses() public {
        vm.expectRevert(GuardianChecker.ZeroAddress.selector);
        new GuardianChecker(address(0), POOL, SPOKE, 7);
    }
}
