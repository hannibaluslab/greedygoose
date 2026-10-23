// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {IJustaPermissionManager as PM} from "../../src/IJustaPermissionManager.sol";

/// Throwaway (review): does JAW's real manager revert on a second revoke of the same struct?
contract ReviewLegacyDoubleRevokeFork is Test {
    PM constant M = PM(0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8);
    function test_doubleRevoke() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"), 52_946_000);
        address acct = 0x18dF202F69CBb870B444BBA41F0d35339d7Da20B;
        PM.Permission memory p;
        p.account = acct;
        p.spender = 0x686cd88F248DE3F9FC0835566DB798D93881F02D;
        p.start = uint48(block.timestamp - 300);
        p.end = uint48(block.timestamp + 365 days);
        p.salt = 12345;
        p.calls = new PM.CallPermission[](1);
        p.calls[0] = PM.CallPermission(address(0x1234), bytes4(0x12345678), address(0));
        p.spends = new PM.SpendLimit[](0);
        vm.startPrank(acct);
        (bool okA, bytes memory rA) = address(M).call(abi.encodeCall(PM.approve, (p)));
        emit log_named_string("approve ok", okA ? "yes" : "no"); emit log_bytes(rA);
        (bool ok1, bytes memory r1) = address(M).call(abi.encodeCall(PM.revoke, (p)));
        emit log_named_string("revoke1 ok", ok1 ? "yes" : "no"); emit log_bytes(r1);
        (bool ok2, bytes memory r2) = address(M).call(abi.encodeCall(PM.revoke, (p)));
        emit log_named_string("revoke2 ok", ok2 ? "yes" : "no"); emit log_bytes(r2);
        PM.Permission memory q = p; q.salt = 999;
        (bool ok3, bytes memory r3) = address(M).call(abi.encodeCall(PM.revoke, (q)));
        emit log_named_string("revoke never-approved ok", ok3 ? "yes" : "no"); emit log_bytes(r3);
    }
}
