// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "./GooseExecutor.sol";

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// Chainlink CRE's consumer interface: the KeystoneForwarder checks it through ERC-165, then calls `onReport`.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title GooseReceiver
/// @notice Where Chainlink CRE delivers the GreedyGoose workflow's reports (runner switch plan, C3). CRE doesn't call
///         contracts directly: its network signs a report, and Base's KeystoneForwarder hands it to a receiver. This one
///         is one of GooseExecutor's runners (`isForwarder`), and it does exactly two things with a report: a run
///         (`performUpkeep`) or a registration (`registerApproved`, with the PermissionApproved data). The report is that
///         call's calldata. The executor
///         still re-checks everything, as it does for any runner.
/// @dev Narrower than Chainlink's generic AutomationReceiver: the target and the two functions are fixed here, and the
///      workflow's owner and name are checked on every report. Both may be 0 only for `cre workflow simulate`, whose
///      mock forwarder sends no identity; the deploy script requires them on Base.
contract GooseReceiver is IReceiver {
    /// The executor this receiver runs.
    address public immutable EXECUTOR;
    /// The only caller: Base's KeystoneForwarder (0xF8344CFd5c43616a4366C34E3EEE75af79a74482), or the simulator's.
    address public immutable FORWARDER;
    /// The workflow's owner, as CRE stamps it in the report's metadata; 0 = not checked (simulation only).
    address public immutable WORKFLOW_OWNER;
    /// The workflow's name, as the 10 bytes CRE stamps in the metadata; 0 = not checked. Chainlink derives them from the
    /// name's SHA-256: check the exact bytes against a real report before relying on them, or leave this 0 and rely on
    /// the owner, which alone keeps out every other workflow. Needs an owner, as in Chainlink's ReceiverTemplate.
    bytes10 public immutable WORKFLOW_NAME;

    error ZeroAddress();
    error NameNeedsOwner();
    error OwnerNeededOnBase();
    error NotForwarder(address sender);
    error BadMetadata();
    error WrongOwner(address owner);
    error WrongName(bytes10 name);
    error CallNotAllowed(bytes4 selector);

    constructor(address executor, address forwarder, address workflowOwner, bytes10 workflowName) {
        if (executor == address(0) || forwarder == address(0)) revert ZeroAddress();
        if (workflowName != bytes10(0) && workflowOwner == address(0)) revert NameNeedsOwner();
        if (block.chainid == 8453 && workflowOwner == address(0)) revert OwnerNeededOnBase(); // simulation only elsewhere
        EXECUTOR = executor;
        FORWARDER = forwarder;
        WORKFLOW_OWNER = workflowOwner;
        WORKFLOW_NAME = workflowName;
    }

    /// Checks who sent the report, then makes its one call on the executor. A call that fails reverts the report with
    /// the executor's own error, so CRE records it as failed.
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != FORWARDER) revert NotForwarder(msg.sender);
        if (WORKFLOW_OWNER != address(0)) {
            (bytes10 name, address owner) = _identity(metadata);
            if (owner != WORKFLOW_OWNER) revert WrongOwner(owner);
            if (WORKFLOW_NAME != bytes10(0) && name != WORKFLOW_NAME) revert WrongName(name);
        }
        bytes4 selector = report.length >= 4 ? bytes4(report[:4]) : bytes4(0);
        if (selector != GooseExecutor.performUpkeep.selector && selector != GooseExecutor.registerApproved.selector) {
            revert CallNotAllowed(selector);
        }
        (bool ok, bytes memory reason) = EXECUTOR.call(report);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// The workflow's name and owner from CRE's metadata: 32 bytes of workflow id, 10 of name, 20 of owner, then (from
    /// the production forwarder) a 2-byte report id, as Chainlink's ReceiverTemplate reads it. Longer is fine.
    function _identity(bytes calldata metadata) internal pure returns (bytes10 name, address owner) {
        if (metadata.length < 62) revert BadMetadata();
        name = bytes10(metadata[32:42]);
        owner = address(bytes20(metadata[42:62]));
    }
}
