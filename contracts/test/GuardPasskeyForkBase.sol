// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {GuardForkBase} from "./GuardForkBase.sol";
import {IJustaPermissionManager as PM, IJustanAccount} from "./IJustaPermissionManager.sol";
import {
    PackedUserOperation,
    IEntryPointV8,
    IJawFactoryV1,
    SignatureWrapper,
    WebAuthnAuth
} from "./OneTapNewAccountFork.t.sol";

/// GuardForkBase plus OneTapNewAccountFork's user-operation harness: a real P-256 passkey signs, in WebAuthn form, a
/// user operation that the real EntryPoint v0.8 hands to a JAW account. Gas price 0, so nothing is prefunded.
abstract contract GuardPasskeyForkBase is GuardForkBase {
    IEntryPointV8 constant EP = IEntryPointV8(ENTRY_POINT);
    IJawFactoryV1 constant FACTORY = IJawFactoryV1(0x5803c076563C85799989d42Fc00292A8aE52fa9E);
    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    /// forge's EVM lacks Base's P-256 precompile, so the account falls back to Solady's verifier contract.
    uint256 constant VERIFICATION_GAS = 2_000_000;
    uint256 constant CALL_GAS = 8_000_000;

    uint256 passkey = uint256(keccak256("the user's own passkey")) % P256_N;
    address bundler = makeAddr("bundler");

    /// The passkey's owners as JAW's SDK sets them: [passkey, manager].
    function _passkeyOwners() internal view returns (bytes[] memory owners) {
        (uint256 px, uint256 py) = vm.publicKeyP256(passkey);
        owners = new bytes[](2);
        owners[0] = abi.encode(px, py);
        owners[1] = abi.encode(address(MANAGER));
    }

    /// The user operation as JAW's bundler gets it: `initCode` (empty for a deployed account), the batch, the
    /// passkey's signature over the EntryPoint's hash.
    function _userOp(address a, bytes memory initCode, PM.Call[] memory calls)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op.sender = a;
        op.nonce = EP.getNonce(a, 0);
        op.initCode = initCode;
        op.callData = abi.encodeCall(IJustanAccount.executeBatch, (calls));
        op.accountGasLimits = bytes32((VERIFICATION_GAS << 128) | CALL_GAS);
        op.preVerificationGas = 100_000;
        op.signature = _passkeySignature(EP.getUserOpHash(op));
    }

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

    function _base64Url(bytes memory data) internal pure returns (string memory) {
        bytes memory s = bytes(vm.toBase64URL(data));
        uint256 n = s.length;
        while (n > 0 && s[n - 1] == "=") --n;
        assembly ("memory-safe") {
            mstore(s, n)
        }
        return string(s);
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        EP.handleOps(ops, payable(bundler));
    }

    /// Whether the EntryPoint logged the user operation, whether its batch went through, and the gas it used.
    function _outcome(Vm.Log[] memory logs, bytes32 hash) internal pure returns (bool found, bool success) {
        (found, success,) = _outcomeGas(logs, hash);
    }

    function _outcomeGas(Vm.Log[] memory logs, bytes32 hash)
        internal
        pure
        returns (bool found, bool success, uint256 gasUsed)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != ENTRY_POINT || logs[i].topics[0] != IEntryPointV8.UserOperationEvent.selector) {
                continue;
            }
            if (logs[i].topics[1] != hash) continue;
            (, success,, gasUsed) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            return (true, success, gasUsed);
        }
    }
}
