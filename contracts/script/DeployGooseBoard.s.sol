// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {GooseBoard} from "../src/GooseBoard.sol";

/// Deploys GooseBoard, the leaderboard's member list (contracts/docs/DEPLOYMENTS.md, "GooseBoard"). It has no owner and
/// no constructor arguments, so the deployer key gets no power over it; it only pays the gas.
///
/// The signer comes from forge's own wallet flags, so the key never sits in the shell's history:
///   forge script script/DeployGooseBoard.s.sol --rpc-url <base rpc> --broadcast --account <keystore name>
///   (or --ledger, or --interactives 1 to paste the key at a hidden prompt)
/// DEPLOYER_PRIVATE_KEY in the environment is still read when it is set (the fork rehearsals use it).
///
/// Then set the app's NEXT_PUBLIC_GOOSE_BOARD to the address it prints. Until that is set, the Leaderboard tab says
/// "The leaderboard opens soon." and no move carries join().
contract DeployGooseBoard is Script {
    function run() external returns (GooseBoard board) {
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        board = new GooseBoard();
        vm.stopBroadcast();
        console.log("GooseBoard", address(board));
        console.log("chain", block.chainid, "block", block.number);
    }
}
