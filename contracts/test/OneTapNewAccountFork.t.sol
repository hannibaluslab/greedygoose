// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {DeployExecutor} from "../script/DeployExecutor.s.sol";
import {OneTapGrantForkBase} from "./OneTapGrantFork.t.sol";
import {IJustaPermissionManager as PM, IJustanAccount} from "./IJustaPermissionManager.sol";

/// EntryPoint v0.8's user operation (eth-infinitism account-abstraction v0.8, verified on Base at ENTRY_POINT).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPointV8 {
    event UserOperationEvent(
        bytes32 indexed userOpHash,
        address indexed sender,
        address indexed paymaster,
        uint256 nonce,
        bool success,
        uint256 actualGasCost,
        uint256 actualGasUsed
    );
    event AccountDeployed(bytes32 indexed userOpHash, address indexed sender, address factory, address paymaster);
    event UserOperationRevertReason(
        bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason
    );

    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata op) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
}

/// JAW's factory, the parts that place and deploy an account.
interface IJawFactoryV1 {
    function createAccount(bytes[] calldata owners, uint256 nonce) external payable returns (address);
    function getAddress(bytes[] calldata owners, uint256 nonce) external view returns (address);
}

/// JustanAccount's owner list (MultiOwnable): an owner is an abi-encoded address or a 64-byte passkey.
interface IJawOwners {
    function ownerAtIndex(uint256 index) external view returns (bytes memory);
}

/// What JustanAccount's validateUserOp takes (its SignatureWrapper, and Solady's WebAuthnAuth for a passkey owner); the
/// SDK builds the same (core account/toJustanAccount.js wrapSignature, toWebAuthnSignature).
struct SignatureWrapper {
    uint256 ownerIndex;
    bytes signatureData;
}

struct WebAuthnAuth {
    bytes authenticatorData;
    bytes clientDataJSON;
    uint256 challengeIndex;
    uint256 typeIndex;
    bytes32 r;
    bytes32 s;
}

/// One Face ID for an account JAW hasn't deployed yet (Adrian, 2026-10-20: JUSTALAB-DECISIONS.md, "One Face ID for a
/// never-used account too"). Money arrived at the passkey's counterfactual address and nothing was ever sent, so the
/// app's Start earning batch rides in the user operation whose initCode makes JAW's factory deploy the account:
///
///   initCode  JAW's factory.createAccount([passkey, manager], 0)       the SDK's v1 recipe; the manager owns it at once
///   callData  executeBatch([USDC.approve(pool, x), pool.supply(USDC, x, account, 0),
///                           manager.approve(save), executor.registerApproved(abi.encode(save))])
///
/// The app can't simulate the registration from a bare address (lib/tx/plans/agents.ts `simulated`); this proves it on
/// a Base fork, through the real EntryPoint v0.8 `handleOps`, the real factory, the real manager and Aave V3, and this
/// branch's GooseExecutor and jobs deployed with DeployExecutor's Base config. The user operation is signed by a real
/// P-256 passkey (forge's signP256) in WebAuthn form, checked by the account's own validateUserOp; nothing is mocked or
/// pranked inside the user operation, and another passkey's signature is refused. Its gas price is 0, so nobody
/// prefunds it: JAW's paymaster and its USDC fee are left out (the fee buffer stays in the wallet for it). And the other
/// way: an executor that doesn't allow JAW's clone fails the registration, and the whole batch rolls back.
///
/// The app-bytes test runs the batch the app's TypeScript builds (scripts/fork/start-earning-batch.ts), so it needs the
/// app's node_modules, Node 22 on the PATH, `--ffi` and APP_BYTES=1; a plain `forge test` skips it:
///   APP_BYTES=1 BASE_RPC_URL=https://mainnet.base.org forge test --ffi --match-contract OneTapNewAccountForkTest
contract OneTapNewAccountForkTest is OneTapGrantForkBase {
    IEntryPointV8 constant EP = IEntryPointV8(ENTRY_POINT);
    IJawFactoryV1 constant FACTORY = IJawFactoryV1(0x5803c076563C85799989d42Fc00292A8aE52fa9E);
    /// The runtime codehash of JAW's account clone (DeployExecutor.JAW_CLONE_CODEHASH, read on Base 2026-10-20).
    bytes32 constant CLONE = 0xc79e2c8f7a03b38abd65a7e073fc3410849544bba74f53360c127775bc891848;
    /// ACCOUNT_RECIPE_V1.initCodeHash in JAW's core SDK 1.6.3: the address the app shows before the account exists.
    bytes32 constant RECIPE_INIT_CODE_HASH = 0x66e5c494c913cf25a974791c8b932da3b3e54d43bb638e7a6421c64db20696e4;
    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    /// Room for the factory's deploy and a WebAuthn check (forge's EVM lacks the P-256 precompile Base has, so the
    /// account's Solady P256 falls back to Solady's verifier contract, deployed on Base), and for the batch.
    uint256 constant VERIFICATION_GAS = 2_000_000;
    uint256 constant CALL_GAS = 3_000_000;

    uint256 passkey = uint256(keccak256("a never-used passkey")) % P256_N;
    address bundler = makeAddr("bundler");

    function setUp() public {
        _setUpExecutor();
    }

    // ================================================================== the one user operation

    function test_a_never_used_account_is_deployed_and_starts_earning_in_one_user_operation() public {
        assertTrue(x.allowedCodehash(CLONE), "the executor allows JAW's clone");
        (address a, bytes[] memory owners) = _neverUsed();
        uint256 supplied = WALLET - FEE_BUFFER;
        PM.Permission memory p = _saveGrant(a, uint48(vm.getBlockTimestamp()));
        PM.Call[] memory calls = _oneTap(a, p, supplied, false, false);
        assertEq(calls.length, 4, "approve, supply, manager.approve, registerApproved: no owner call");
        _assertEarnsInOneUserOperation(a, owners, calls, p, supplied);
    }

    /// The batch the app's TypeScript builds for this account (getCode "0x"), run unchanged: the same four calls as
    /// above, byte for byte, and the app simulates all of them but the registration this suite proves.
    function test_the_apps_own_batch_for_a_never_used_account_runs_in_one_user_operation() public {
        vm.skip(!vm.envOr("APP_BYTES", false), "needs APP_BYTES=1 and --ffi");
        vm.setEnv("NEXT_PUBLIC_GOOSE_EXECUTOR", vm.toString(address(x)));
        (address a, bytes[] memory owners) = _neverUsed();
        (PM.Call[] memory calls, bytes[] memory grants, PM.Call[] memory simulated) = _app(a);
        assertEq(grants.length, 1, "earning's grant");
        PM.Permission memory p = abi.decode(grants[0], (PM.Permission));
        uint256 supplied = WALLET - FEE_BUFFER;
        assertEq(abi.encode(calls), abi.encode(_oneTap(a, p, supplied, false, false)), "this suite's batch");
        assertEq(simulated.length, 3, "all but the registration are simulated");
        for (uint256 i; i < 3; ++i) {
            assertEq(abi.encode(simulated[i]), abi.encode(calls[i]));
        }
        _assertEarnsInOneUserOperation(a, owners, calls, p, supplied);
    }

    /// The passkey's signature is really checked: the same user operation signed by another passkey is refused in
    /// validation (AA24), so the bundle doesn't land and nothing is deployed or moved.
    function test_another_passkeys_signature_is_refused() public {
        (address a, bytes[] memory owners) = _neverUsed();
        PM.Permission memory p = _saveGrant(a, uint48(vm.getBlockTimestamp()));
        PackedUserOperation memory op = _userOp(a, owners, _oneTap(a, p, WALLET - FEE_BUFFER, false, false));
        passkey = uint256(keccak256("someone else's passkey")) % P256_N;
        op.signature = _passkeySignature(EP.getUserOpHash(op));

        vm.expectRevert(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA24 signature error"));
        _handle(op);
        assertEq(a.code.length, 0, "not deployed");
        assertEq(USDC.balanceOf(a), WALLET, "USDC unchanged");
    }

    // ================================================================== an executor without JAW's clone

    /// The account is deployed in validation, before the batch, so that part stands; the registration refuses the
    /// account (AccountNotAllowed) and executeBatch rolls the whole batch back: no supply, no approve, no grant, no
    /// registration. On Base the user would still pay the network fee.
    function test_an_executor_without_jaws_clone_reverts_the_whole_batch_and_no_money_moves() public {
        x = _executorWithoutTheClone();
        assertFalse(x.allowedCodehash(CLONE));
        (address a, bytes[] memory owners) = _neverUsed();
        PM.Permission memory p = _saveGrant(a, uint48(vm.getBlockTimestamp()));
        PackedUserOperation memory op = _userOp(a, owners, _oneTap(a, p, WALLET - FEE_BUFFER, false, false));
        bytes32 hash = EP.getUserOpHash(op);

        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (bool found, bool success) = _outcome(logs, hash);
        assertTrue(found, "the user operation ran");
        assertFalse(success, "its batch reverted");
        assertEq(
            _revertReason(logs, hash),
            _failedAt(3, GooseExecutor.AccountNotAllowed.selector),
            "the registration, fourth"
        );
        assertEq(a.codehash, CLONE, "the factory's deploy stands: it ran in validation");
        assertEq(USDC.balanceOf(a), WALLET, "USDC unchanged");
        assertEq(AUSDC.balanceOf(a), 0, "nothing in savings");
        assertEq(USDC.allowance(a, address(POOL)), 0, "no approve left");
        assertFalse(MANAGER.isApproved(p), "the permission isn't approved");
        (uint8 jobs,,,,,,,,,) = x.accounts(a);
        assertEq(jobs, 0, "nothing registered");
        assertEq(x.memberCount(), 0);
    }

    // ================================================================== helpers

    /// The passkey's account as the SDK places it before it exists (owners [passkey, manager], nonce 0), with the
    /// wallet's USDC already there.
    function _neverUsed() internal returns (address a, bytes[] memory owners) {
        (uint256 px, uint256 py) = vm.publicKeyP256(passkey);
        owners = new bytes[](2);
        owners[0] = abi.encode(px, py);
        owners[1] = abi.encode(address(MANAGER));
        a = FACTORY.getAddress(owners, 0);
        bytes32 salt = keccak256(abi.encode(owners, uint256(0)));
        assertEq(a, vm.computeCreate2Address(salt, RECIPE_INIT_CODE_HASH, address(FACTORY)), "the SDK's v1 address");
        assertEq(a.code.length, 0, "never used: no code yet");
        deal(address(USDC), a, WALLET);
    }

    function _assertEarnsInOneUserOperation(
        address a,
        bytes[] memory owners,
        PM.Call[] memory calls,
        PM.Permission memory p,
        uint256 supplied
    ) internal {
        PackedUserOperation memory op = _userOp(a, owners, calls);
        bytes32 hash = EP.getUserOpHash(op);

        vm.recordLogs();
        _handle(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (bool found, bool success) = _outcome(logs, hash);
        assertTrue(found && success, "the user operation and its batch went through");
        assertTrue(_deployedBy(logs, hash, a), "AccountDeployed by JAW's factory");
        assertEq(a.codehash, CLONE, "JAW's clone");
        assertEq(IJawOwners(a).ownerAtIndex(0), owners[0], "the passkey");
        assertTrue(IJustanAccount(a).isOwnerAddress(address(MANAGER)), "the manager, from the factory");
        _assertSaveOn(a, p);
        assertEq(x.memberCount(), 1);
        assertApproxEqAbs(AUSDC.balanceOf(a), supplied, 2, "savings up by the supply");
        assertEq(USDC.balanceOf(a), WALLET - supplied, "USDC down by the supply; the fee buffer stays");
        assertEq(USDC.allowance(a, address(POOL)), 0, "the exact approve is used up");
    }

    /// The user operation as JAW's bundler gets it: the factory's initCode, the batch, the passkey's signature over
    /// the EntryPoint's hash. Gas price 0, so there's nothing to prefund and no paymaster.
    function _userOp(address a, bytes[] memory owners, PM.Call[] memory calls)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = a;
        op.nonce = EP.getNonce(a, 0);
        op.initCode = abi.encodePacked(address(FACTORY), abi.encodeCall(IJawFactoryV1.createAccount, (owners, 0)));
        op.callData = abi.encodeCall(IJustanAccount.executeBatch, (calls));
        op.accountGasLimits = bytes32((VERIFICATION_GAS << 128) | CALL_GAS);
        op.preVerificationGas = 100_000;
        op.signature = _passkeySignature(EP.getUserOpHash(op));
    }

    /// A WebAuthn assertion over `hash` by the passkey, wrapped for owner 0, as an iPhone's Face ID gives it to the
    /// SDK: the challenge is the hash in base64url, the type at index 1 and the challenge at 23 (the SDK's defaults),
    /// user present and verified, and a low-s signature (Solady's P256 refuses a high one).
    function _passkeySignature(bytes32 hash) internal view returns (bytes memory) {
        bytes memory clientDataJSON = abi.encodePacked(
            '{"type":"webauthn.get","challenge":"',
            _base64Url(abi.encode(hash)),
            '","origin":"https://keys.jaw.id","crossOrigin":false}'
        );
        bytes memory authenticatorData = abi.encodePacked(sha256(bytes("keys.jaw.id")), uint8(0x05), uint32(0));
        bytes32 digest = sha256(abi.encodePacked(authenticatorData, sha256(clientDataJSON)));
        (bytes32 r, bytes32 s) = vm.signP256(passkey, digest);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        return abi.encode(SignatureWrapper(0, abi.encode(WebAuthnAuth(authenticatorData, clientDataJSON, 23, 1, r, s))));
    }

    /// Base64url without padding, as WebAuthn puts a challenge in clientDataJSON.
    function _base64Url(bytes memory data) internal pure returns (string memory) {
        bytes memory s = bytes(vm.toBase64URL(data));
        uint256 n = s.length;
        while (n > 0 && s[n - 1] == "=") --n;
        assembly ("memory-safe") {
            mstore(s, n)
        }
        return string(s);
    }

    /// The bundler's transaction: handleOps from an EOA, one user operation.
    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        EP.handleOps(ops, payable(bundler));
    }

    /// Whether the EntryPoint logged the user operation, and whether its batch went through.
    function _outcome(Vm.Log[] memory logs, bytes32 hash) internal pure returns (bool found, bool success) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != ENTRY_POINT || logs[i].topics[0] != IEntryPointV8.UserOperationEvent.selector) {
                continue;
            }
            if (logs[i].topics[1] != hash) continue;
            (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            return (true, success);
        }
    }

    function _deployedBy(Vm.Log[] memory logs, bytes32 hash, address a) internal pure returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != ENTRY_POINT || logs[i].topics[0] != IEntryPointV8.AccountDeployed.selector) {
                continue;
            }
            if (logs[i].topics[1] != hash || address(uint160(uint256(logs[i].topics[2]))) != a) continue;
            (address factory,) = abi.decode(logs[i].data, (address, address));
            return factory == address(FACTORY);
        }
        return false;
    }

    function _revertReason(Vm.Log[] memory logs, bytes32 hash) internal pure returns (bytes memory reason) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != ENTRY_POINT) continue;
            if (logs[i].topics[0] != IEntryPointV8.UserOperationRevertReason.selector || logs[i].topics[1] != hash) {
                continue;
            }
            (, reason) = abi.decode(logs[i].data, (uint256, bytes));
        }
    }

    /// The next executor's Base config with only the EIP-7702 delegation allowed, not JAW's factory clone.
    function _executorWithoutTheClone() internal returns (GooseExecutor) {
        GooseExecutor.Config memory c = new DeployExecutor().config(8453, owner);
        assertEq(c.codehashes[0], CLONE);
        bytes32[] memory only7702 = new bytes32[](1);
        only7702[0] = c.codehashes[1];
        c.codehashes = only7702;
        return new GooseExecutor(c);
    }

    /// The app's batch from its own TypeScript (scripts/fork/start-earning-batch.ts), with the start and salt picked as
    /// lib/agents/picks.ts picks them: five minutes behind the earlier of the device's clock and the fork's.
    function _app(address a)
        internal
        returns (PM.Call[] memory calls, bytes[] memory grants, PM.Call[] memory simulated)
    {
        uint256 wall = vm.unixTime() / 1000;
        uint256 forkNow = vm.getBlockTimestamp();
        uint256 start = (wall < forkNow ? wall : forkNow) - 5 minutes;
        string[] memory cmd = new string[](9);
        cmd[0] = "../node_modules/.bin/tsx";
        cmd[1] = "--tsconfig";
        cmd[2] = "../tsconfig.json";
        cmd[3] = "../scripts/fork/start-earning-batch.ts";
        cmd[4] = vm.toString(a);
        cmd[5] = vm.toString(start);
        cmd[6] = vm.toString(uint256(keccak256(abi.encode("app bytes", a))) >> 8);
        cmd[7] = vm.toString(uint256(x.CAP_MAX()));
        cmd[8] = vm.toString(WALLET);
        (calls, grants, simulated) = abi.decode(vm.ffi(cmd), (PM.Call[], bytes[], PM.Call[]));
    }
}
