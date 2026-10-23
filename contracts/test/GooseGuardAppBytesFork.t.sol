// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GuardPasskeyForkBase} from "./GuardPasskeyForkBase.sol";
import {IJustaPermissionManager as PM, IJustanAccount} from "./IJustaPermissionManager.sol";
import {PackedUserOperation, IJawFactoryV1} from "./OneTapNewAccountFork.t.sol";

/// Build step 8 (spec-final-v2.md §14, item 14), on the app's own bytes (Mariano's review, GG-13): registration in the
/// app's one batch, with the Guard as the spender. The batch is test/vectors/app-bytes.json, which
/// scripts/app-bytes-vectors.ts writes from the app's TypeScript (lib/agents/permissions.ts `jobGrant`,
/// lib/agents/oneTapGrant.ts `jawPermission` and `oneTapGrantCalls`): five approves in JAW's manager, then five
/// `register(job, abi.encode(p))`, for all five agents (all seven stocks for Protect · sell and Rebalance, the five Turn
/// into cash coins). Nothing here builds a permission: the test sends the app's calls as they are.
///
/// The file is built for this suite's passkey account and for a Guard at a fixed address, where setUp deploys one
/// (`npm run contracts:vectors` after changing a grant). A passkey account JAW hasn't deployed yet is deployed by the
/// user operation's initCode, as in OneTapNewAccountFork: one Face ID.
///
/// Logged per agent: the permission's bytes, the calldata bytes the batch carries for it (approve + register: the
/// bytes go twice, so twice the L1 data fee), and the gas of its pair run cold as its own transaction.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardAppBytesForkTest -vv
contract GooseGuardAppBytesForkTest is GuardPasskeyForkBase {
    string[5] NAMES = ["Save", "Protect", "Protect sell", "Rebalance", "Turn into cash"];

    address account;
    bytes[] permissions;
    PM.Call[] batch;

    function setUp() public {
        _setUpGuard();
        string memory json = vm.readFile("test/vectors/app-bytes.json");
        account = vm.parseJsonAddress(json, ".account");
        address guard = vm.parseJsonAddress(json, ".guard");
        permissions = vm.parseJsonBytesArray(json, ".permissions");
        address[] memory to = vm.parseJsonAddressArray(json, ".to");
        bytes[] memory data = vm.parseJsonBytesArray(json, ".data");
        assertEq(permissions.length, 5, "one permission per agent");
        assertEq(to.length, 10, "one approve and one register per agent");
        assertEq(data.length, to.length);
        for (uint256 i; i < to.length; ++i) {
            batch.push(PM.Call(to[i], 0, data[i]));
        }

        // The vectors' account is this suite's passkey account.
        assertEq(FACTORY.getAddress(_passkeyOwners(), 0), account, "app-bytes.json: another account, regenerate it");
        // The Guard _setUpGuard deploys, with the same settings, at the address the app's bytes name as the spender.
        assertEq(guard.code.length, 0, "something already lives at the vectors' Guard address");
        bytes32 clone = _newJawAccount("app bytes probe").codehash;
        deployCodeTo(
            "GooseGuard.sol:GooseGuard", abi.encode(address(this), KEEPERHUB, clone, 300, 50, 100, 1e6, 1e6), guard
        );
        g = GooseGuard(guard);
        vm.label(guard, "GooseGuard");
    }

    function _decoded(uint8 job) internal view returns (PM.Permission memory) {
        return abi.decode(permissions[job], (PM.Permission));
    }

    /// The app's registrations took: each job on, each permission approved in the manager and stored byte for byte.
    function _assertRegistered() internal view {
        (GooseGuard.Account memory acc,) = g.accountOf(account);
        assertEq(acc.jobs, 0x1f, "not all five agents on");
        assertEq(g.membersLength(), 1);
        for (uint8 job; job < 5; ++job) {
            assertTrue(MANAGER.isApproved(_decoded(job)), "not approved in the manager");
            assertEq(
                keccak256(g.permissionOf(account, job)), keccak256(permissions[job]), "permissionOf isn't the grant"
            );
        }
    }

    /// A never-used passkey account: deployed, then all five agents approved and registered, in one user operation.
    function test_a_new_account_is_deployed_and_registers_all_five_agents_in_one_user_operation() public {
        bytes[] memory owners = _passkeyOwners();
        address a = account;
        assertEq(a.code.length, 0, "already deployed");
        deal(address(USDC), a, 10e6);

        bytes memory initCode =
            abi.encodePacked(address(FACTORY), abi.encodeCall(IJawFactoryV1.createAccount, (owners, 0)));
        PackedUserOperation memory op = _userOp(a, initCode, batch);
        bytes32 hash = EP.getUserOpHash(op);

        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bool found, bool success, uint256 gasUsed) = _outcomeGas(logs, hash);
        assertTrue(found && success, "the user operation or its batch failed");
        assertEq(a.codehash, _newJawAccount("clone").codehash, "not JAW's clone");
        _assertRegistered();
        console2.log("one user operation: deploy + 5 approvals + 5 registrations, gas used (EntryPoint)", gasUsed);
        console2.log("  its callData bytes", op.callData.length, "initCode bytes", op.initCode.length);

        // The registered agents work: a Save through the Guard right away.
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](1);
        moves[0] = GooseGuard.Move(a, SAVE, _a1(5e6));
        (, logs) = _perform(abi.encode(moves));
        assertEq(_reason(logs, a), bytes4(0), "the first Save was refused");
    }

    /// Each agent's approve + register pair from the app's batch, cold, on the deployed account: gas and bytes.
    function test_gas_and_bytes_per_agent() public {
        _assertIsolated();
        address a = FACTORY.createAccount(_passkeyOwners(), 0);
        assertEq(a, account);
        console2.log("agent             | permission bytes | batch calldata bytes (approve + register) | gas, cold");
        uint256 totalGas;
        uint256 totalBytes;
        for (uint8 job; job < 5; ++job) {
            PM.Call[] memory calls = new PM.Call[](2);
            (calls[0], calls[1]) = (batch[job], batch[5 + job]);
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
                    vm.toString(permissions[job].length),
                    " | ",
                    vm.toString(pairBytes),
                    " | ",
                    vm.toString(used)
                )
            );
        }
        console2.log("all five: gas", totalGas, "bytes", totalBytes);
        _assertRegistered();
    }
}
