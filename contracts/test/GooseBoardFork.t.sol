// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseBoard} from "../src/GooseBoard.sol";
import {DeployGooseBoard} from "../script/DeployGooseBoard.s.sol";
import {ForkBase} from "./ForkBase.sol";
import {IJustaPermissionManager as PM, IJustanAccount} from "./IJustaPermissionManager.sol";

/// EFP on Base (lib/efp/efp.ts, verified against the deployed contracts by the booth app and NYM).
interface IEfpListMinter {
    function easyMint(bytes calldata listStorageLocation) external payable;
}

interface IEfpListRecords {
    function applyListOps(uint256 slot, bytes[] calldata ops) external;
    function getListOpCount(uint256 slot) external view returns (uint256);
    function getAllListOps(uint256 slot) external view returns (bytes[] memory);
    function getMetadataValue(uint256 slot, string calldata key) external view returns (bytes memory);
}

interface IEfpAccountMetadata {
    function getValue(address addr, string calldata key) external view returns (bytes memory);
}

interface IEfpListRegistry {
    function getListStorageLocation(uint256 tokenId) external view returns (bytes memory);
}

/// The leaderboard's first move on a Base fork, the way the app sends it: a JAW account's one batch (EntryPoint →
/// account.executeBatch) carries the move (here adding a contact on EFP, minting the list first) and GooseBoard.join().
/// Needs BASE_RPC_URL.
contract GooseBoardForkTest is ForkBase {
    IEfpListMinter constant MINTER = IEfpListMinter(0xDb17Bfc64aBf7B7F080a49f0Bbbf799dDbb48Ce5);
    IEfpListRecords constant RECORDS = IEfpListRecords(0x41Aa48Ef3c0446b46a5b1cc6337FF3d3716E2A33);
    IEfpAccountMetadata constant META = IEfpAccountMetadata(0x5289fE5daBC021D02FDDf23d4a4DF96F4E0F17EF);
    IEfpListRegistry constant REGISTRY = IEfpListRegistry(0x0E688f5DCa4a0a4729946ACbC44C792341714e08);

    GooseBoard board;
    address sam;
    address kit;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        // The deploy script, with a throwaway key (forge's first default account; this fork only).
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        board = new DeployGooseBoard().run();
        sam = _newJawAccount("sam");
        kit = _newJawAccount("kit");
    }

    function test_deployScript_deploysAnEmptyBoard() public view {
        assertGt(address(board).code.length, 0);
        assertEq(board.memberCount(), 0);
    }

    function test_firstMove_joinsAndAddsAContactInOneBatch() public {
        uint256 slot = uint256(keccak256("sam's list"));
        PM.Call[] memory calls = new PM.Call[](3);
        calls[0] = PM.Call(address(MINTER), 0, abi.encodeCall(IEfpListMinter.easyMint, (_location(slot))));
        calls[1] = PM.Call(address(RECORDS), 0, abi.encodeCall(IEfpListRecords.applyListOps, (slot, _ops(0x01, kit))));
        calls[2] = PM.Call(address(board), 0, abi.encodeCall(GooseBoard.join, ()));
        _batch(sam, calls);

        assertTrue(board.listed(sam));
        assertEq(board.joinedAt(sam), block.number);
        assertEq(board.members(0), sam);

        // The list is sam's own, primary, on Base, and holds one follow of kit.
        uint256 tokenId = uint256(bytes32(META.getValue(sam, "primary-list")));
        assertEq(keccak256(REGISTRY.getListStorageLocation(tokenId)), keccak256(_location(slot)));
        assertEq(address(bytes20(RECORDS.getMetadataValue(slot, "user"))), sam);
        assertEq(address(bytes20(RECORDS.getMetadataValue(slot, "manager"))), sam);
        bytes[] memory ops = RECORDS.getAllListOps(slot);
        assertEq(ops.length, 1);
        assertEq(keccak256(ops[0]), keccak256(_ops(0x01, kit)[0]));
    }

    function test_laterMoves_addSeveralAndRemove_withoutJoiningAgain() public {
        uint256 slot = uint256(keccak256("kit's list"));
        PM.Call[] memory first = new PM.Call[](2);
        first[0] = PM.Call(address(MINTER), 0, abi.encodeCall(IEfpListMinter.easyMint, (_location(slot))));
        first[1] = PM.Call(address(board), 0, abi.encodeCall(GooseBoard.join, ()));
        _batch(kit, first);
        uint256 joined = board.joinedAt(kit);

        // Several in one call: one op each.
        bytes[] memory many = new bytes[](2);
        many[0] = _ops(0x01, sam)[0];
        many[1] = _ops(0x01, makeAddr("leo"))[0];
        vm.roll(block.number + 5);
        PM.Call[] memory add = new PM.Call[](1);
        add[0] = PM.Call(address(RECORDS), 0, abi.encodeCall(IEfpListRecords.applyListOps, (slot, many)));
        _batch(kit, add);

        // Remove writes EFP's remove op.
        PM.Call[] memory remove = new PM.Call[](1);
        remove[0] = PM.Call(address(RECORDS), 0, abi.encodeCall(IEfpListRecords.applyListOps, (slot, _ops(0x02, sam))));
        _batch(kit, remove);

        assertEq(RECORDS.getListOpCount(slot), 3);
        assertEq(board.joinedAt(kit), joined, "still counted from the first move");
        assertEq(board.memberCount(), 1);
    }

    function test_onlyTheListsManagerCanWriteIt() public {
        uint256 slot = uint256(keccak256("sam's list"));
        PM.Call[] memory mint = new PM.Call[](1);
        mint[0] = PM.Call(address(MINTER), 0, abi.encodeCall(IEfpListMinter.easyMint, (_location(slot))));
        _batch(sam, mint);

        PM.Call[] memory hijack = new PM.Call[](1);
        hijack[0] = PM.Call(address(RECORDS), 0, abi.encodeCall(IEfpListRecords.applyListOps, (slot, _ops(0x01, kit))));
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        IJustanAccount(kit).executeBatch(hijack);
    }

    /// One JAW user operation's execution: the EntryPoint calls account.executeBatch.
    function _batch(address account, PM.Call[] memory calls) internal {
        vm.prank(ENTRY_POINT);
        IJustanAccount(account).executeBatch(calls);
    }

    /// `0x01 | opcode | 0x01 | 0x01 | address`: one EFP list op (lib/efp/efp.ts encodeListOp).
    function _ops(uint8 opcode, address target) internal pure returns (bytes[] memory ops) {
        ops = new bytes[](1);
        ops[0] = abi.encodePacked(uint8(1), opcode, uint8(1), uint8(1), target);
    }

    /// The 86-byte location easyMint takes: version, type, chain, records contract, slot (encodeListStorageLocation).
    function _location(uint256 slot) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(1), uint8(1), uint256(8453), address(RECORDS), slot);
    }
}
