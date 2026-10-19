// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {GooseReceiver} from "../src/GooseReceiver.sol";

/// Deploys GooseReceiver, the CRE workflow's way into GooseExecutor (runner switch plan, C3). The executor's owner then
/// adds it as a runner: in `bootstrap` with the deploy, or later through the 7-day delay (AddForwarder).
///
///   EXECUTOR=<executor> CRE_WORKFLOW_OWNER=<address> CRE_WORKFLOW_NAME=<bytes10> \
///     forge script script/DeployReceiver.s.sol --rpc-url <base> --broadcast
///
/// CRE_FORWARDER defaults to Base's KeystoneForwarder. On Base the workflow's owner and name are required: without
/// them any CRE workflow could run the executor through this receiver. Elsewhere (a fork for `cre workflow simulate`)
/// they may be left out, since the simulator's mock forwarder sends no identity.
contract DeployReceiver is Script {
    uint256 internal constant BASE = 8453;
    /// Chainlink CRE's KeystoneForwarder on Base (docs.chain.link, CRE supported networks, read 2026-10-19).
    address internal constant BASE_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;

    function run() external returns (GooseReceiver receiver) {
        (address executor, address forwarder, address owner, bytes10 name) = settings(block.chainid);
        vm.startBroadcast();
        receiver = new GooseReceiver(executor, forwarder, owner, name);
        vm.stopBroadcast();
    }

    function settings(uint256 chainId)
        public
        view
        returns (address executor, address forwarder, address owner, bytes10 name)
    {
        executor = vm.envAddress("EXECUTOR");
        forwarder = vm.envOr("CRE_FORWARDER", BASE_FORWARDER);
        owner = vm.envOr("CRE_WORKFLOW_OWNER", address(0));
        name = bytes10(vm.envOr("CRE_WORKFLOW_NAME", bytes(""))); // the 10 bytes CRE stamps, as 0x + 20 hex digits
        require(executor.code.length > 0, "no executor at EXECUTOR");
        require(forwarder.code.length > 0, "no forwarder at CRE_FORWARDER");
        if (chainId == BASE) {
            require(forwarder == BASE_FORWARDER, "Base takes Chainlink's KeystoneForwarder");
            require(owner != address(0) && name != bytes10(0), "Base needs CRE_WORKFLOW_OWNER and CRE_WORKFLOW_NAME");
        }
    }
}
