// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GuardPasskeyForkBase} from "./GuardPasskeyForkBase.sol";
import {IJustaPermissionManager as PM, IJustanAccount} from "./IJustaPermissionManager.sol";
import {PackedUserOperation, IJawFactoryV1} from "./OneTapNewAccountFork.t.sol";

/// Build step 8 (spec-final-v2.md §14, item 14): registration in the app's one batch, with the Guard as the spender.
/// Following OneTapNewAccountFork, a passkey account JAW hasn't deployed yet is deployed by the user operation's
/// initCode, and the same user operation approves each agent's permission in JAW's manager and registers it with
/// `register(job, abi.encode(p))`, for all five agents: one Face ID. The permissions are the §5 templates this suite
/// builds (all seven stocks for Protect · sell and Rebalance, the five Turn into cash coins), not yet the app's own
/// TypeScript, which doesn't build Guard registrations until build step 13.
///
/// Logged per agent: the permission's bytes, the calldata bytes the batch carries for it (approve + register: the
/// bytes go twice, so twice the L1 data fee), and the gas of its pair run cold as its own transaction.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardAppBytesForkTest -vv
contract GooseGuardAppBytesForkTest is GuardPasskeyForkBase {
    string[5] NAMES = ["Save", "Protect", "Protect sell", "Rebalance", "Turn into cash"];

    function setUp() public {
        _setUpGuard();
    }

    function _template(address a, uint8 job) internal returns (PM.Permission memory) {
        if (job == JOB_SAVE) return _saveP(a);
        if (job == JOB_PROTECT) return _protectP(a);
        if (job == JOB_SELL) return _sellP(a, ALL_STOCKS);
        if (job == JOB_REBALANCE) return _rebalanceP(a, ALL_STOCKS);
        return _entryP(a);
    }

    /// The agent's two calls in the batch: what JAW's grant sends, then the registration.
    function _pair(PM.Permission memory p, uint8 job) internal view returns (PM.Call memory approve, PM.Call memory reg) {
        approve = PM.Call(address(MANAGER), 0, abi.encodeCall(PM.approve, (p)));
        reg = PM.Call(address(g), 0, abi.encodeCall(GooseGuard.register, (job, abi.encode(p))));
    }

    /// A never-used passkey account: deployed, then all five agents approved and registered, in one user operation.
    function test_a_new_account_is_deployed_and_registers_all_five_agents_in_one_user_operation() public {
        bytes[] memory owners = _passkeyOwners();
        address a = FACTORY.getAddress(owners, 0);
        assertEq(a.code.length, 0, "already deployed");
        deal(address(USDC), a, 10e6);

        PM.Permission[5] memory ps;
        PM.Call[] memory calls = new PM.Call[](10);
        for (uint8 job; job < 5; ++job) {
            ps[job] = _template(a, job);
            (calls[2 * job], calls[2 * job + 1]) = _pair(ps[job], job);
        }
        bytes memory initCode = abi.encodePacked(address(FACTORY), abi.encodeCall(IJawFactoryV1.createAccount, (owners, 0)));
        PackedUserOperation memory op = _userOp(a, initCode, calls);
        bytes32 hash = EP.getUserOpHash(op);

        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bool found, bool success, uint256 gasUsed) = _outcomeGas(logs, hash);
        assertTrue(found && success, "the user operation or its batch failed");
        assertEq(a.codehash, _newJawAccount("clone").codehash, "not JAW's clone");
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        assertEq(acc.jobs, 0x1f, "not all five agents on");
        assertEq(g.membersLength(), 1);
        for (uint8 job; job < 5; ++job) {
            assertTrue(MANAGER.isApproved(ps[job]), "not approved in the manager");
            assertEq(keccak256(g.permissionOf(a, job)), keccak256(abi.encode(ps[job])), "permissionOf isn't the grant");
        }
        console2.log("one user operation: deploy + 5 approvals + 5 registrations, gas used (EntryPoint)", gasUsed);
        console2.log("  its callData bytes", op.callData.length, "initCode bytes", op.initCode.length);

        // The registered agents work: a Save through the Guard right away.
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](1);
        moves[0] = GooseGuard.Move(a, SAVE, _a1(5e6));
        (, logs) = _perform(abi.encode(moves));
        assertEq(_reason(logs, a), bytes4(0), "the first Save was refused");
    }

    /// Each agent's approve + register pair, cold, on a deployed JAW account: gas and bytes.
    function test_gas_and_bytes_per_agent() public {
        _assertIsolated();
        address a = _newJawAccount("per agent");
        console2.log("agent             | permission bytes | batch calldata bytes (approve + register) | gas, cold");
        uint256 totalGas;
        uint256 totalBytes;
        for (uint8 job; job < 5; ++job) {
            PM.Permission memory p = _template(a, job);
            PM.Call[] memory calls = new PM.Call[](2);
            (calls[0], calls[1]) = _pair(p, job);
            bytes memory callData = abi.encodeCall(IJustanAccount.executeBatch, (calls));
            vm.prank(ENTRY_POINT);
            (bool ok,) = a.call(callData);
            uint256 used = _execGas(callData);
            assertTrue(ok, "the pair failed");
            uint256 pairBytes = abi.encode(calls[0]).length + abi.encode(calls[1]).length;
            totalGas += used;
            totalBytes += pairBytes;
            console2.log(
                string.concat(
                    NAMES[job],
                    " | ",
                    vm.toString(abi.encode(p).length),
                    " | ",
                    vm.toString(pairBytes),
                    " | ",
                    vm.toString(used)
                )
            );
        }
        console2.log("all five: gas", totalGas, "bytes", totalBytes);
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        assertEq(acc.jobs, 0x1f);
    }
}
