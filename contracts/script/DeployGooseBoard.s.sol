// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {GooseBoard} from "../src/GooseBoard.sol";

/// Deploys GooseBoard, the leaderboard's member list (contracts/docs/DEPLOYMENTS.md, "GooseBoard"). It has no owner and
/// no constructor arguments, so the deployer key gets no power over it; it only pays the gas.
///
///   DEPLOYER_PRIVATE_KEY=0x… forge script script/DeployGooseBoard.s.sol --rpc-url <base rpc> --broadcast
///
/// Then set the app's NEXT_PUBLIC_GOOSE_BOARD to the address it prints. Until that is set, the Leaderboard tab says
/// "The leaderboard opens soon." and no move carries join().
contract DeployGooseBoard is Script {
    function run() external returns (GooseBoard board) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(key);
        board = new GooseBoard();
        vm.stopBroadcast();
        console.log("GooseBoard", address(board));
        console.log("chain", block.chainid, "block", block.number);
    }
}
