// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GooseBoard} from "../src/GooseBoard.sol";

contract GooseBoardTest is Test {
    GooseBoard board;
    address sam = makeAddr("sam");
    address kit = makeAddr("kit");
    address leo = makeAddr("leo");

    event Joined(address indexed account, uint256 blockNumber);
    event Left(address indexed account);

    function setUp() public {
        board = new GooseBoard();
    }

    function test_join_listsTheCallerFromThisBlock() public {
        vm.roll(1_000);
        vm.expectEmit(true, false, false, true, address(board));
        emit Joined(sam, 1_000);
        vm.prank(sam);
        board.join();

        assertTrue(board.listed(sam));
        assertEq(board.joinedAt(sam), 1_000);
        assertEq(board.memberCount(), 1);
        assertEq(board.members(0), sam);
        assertFalse(board.listed(kit));
        assertEq(board.joinedAt(kit), 0);
    }

    function test_join_twiceIsANoOp() public {
        vm.roll(10);
        vm.prank(sam);
        board.join();
        vm.roll(20);
        vm.recordLogs();
        vm.prank(sam);
        board.join();

        assertEq(vm.getRecordedLogs().length, 0, "no second Joined");
        assertEq(board.joinedAt(sam), 10, "joinedAt keeps the first join");
        assertEq(board.memberCount(), 1);
    }

    function test_members_keepTheOrderTheyJoinedIn() public {
        vm.prank(kit);
        board.join();
        vm.prank(sam);
        board.join();
        vm.prank(leo);
        board.join();

        assertEq(board.memberCount(), 3);
        assertEq(board.members(0), kit);
        assertEq(board.members(1), sam);
        assertEq(board.members(2), leo);
    }

    function test_leave_takesOnlyTheCallerOff() public {
        vm.roll(5);
        vm.prank(sam);
        board.join();
        vm.prank(kit);
        board.join();

        vm.expectEmit(true, false, false, false, address(board));
        emit Left(sam);
        vm.prank(sam);
        board.leave();

        assertFalse(board.listed(sam));
        assertTrue(board.listed(kit));
        assertEq(board.joinedAt(sam), 5, "joinedAt stays, so the app doesn't put it back");
        assertEq(board.memberCount(), 2, "the list keeps its place");
        assertEq(board.members(0), sam);
    }

    function test_leave_whenNotListedIsANoOp() public {
        vm.recordLogs();
        vm.prank(sam);
        board.leave();
        assertEq(vm.getRecordedLogs().length, 0);
        assertFalse(board.listed(sam));
    }

    function test_rejoin_startsOverWithoutADuplicate() public {
        vm.roll(5);
        vm.prank(sam);
        board.join();
        vm.prank(sam);
        board.leave();
        vm.roll(50);
        vm.prank(sam);
        board.join();

        assertTrue(board.listed(sam));
        assertEq(board.joinedAt(sam), 50);
        assertEq(board.memberCount(), 1);
    }

    function test_nobodyCanAddOrRemoveSomeoneElse() public {
        // The only writes are join() and leave(), and both act on msg.sender. There is no owner to call anything else.
        vm.prank(sam);
        board.join();
        vm.prank(kit);
        board.leave();
        assertTrue(board.listed(sam));
        assertFalse(board.listed(kit));
        assertEq(board.memberCount(), 1);
    }

    function test_holdsNoEth() public {
        vm.deal(sam, 1 ether);
        vm.prank(sam);
        (bool ok,) = address(board).call{value: 1}("");
        assertFalse(ok, "no receive or fallback");
        vm.prank(sam);
        (ok,) = address(board).call{value: 1}(abi.encodeCall(GooseBoard.join, ()));
        assertFalse(ok, "join is not payable");
        assertEq(address(board).balance, 0);
    }

    function test_page_returnsSlicesAndStopsAtTheEnd() public {
        address[5] memory who = [sam, kit, leo, makeAddr("ana"), makeAddr("bo")];
        for (uint256 i; i < who.length; ++i) {
            vm.roll(100 + i);
            vm.prank(who[i]);
            board.join();
        }
        vm.prank(kit);
        board.leave();

        (address[] memory a, bool[] memory on, uint256[] memory at) = board.page(1, 2);
        assertEq(a.length, 2);
        assertEq(a[0], kit);
        assertEq(a[1], leo);
        assertFalse(on[0]);
        assertTrue(on[1]);
        assertEq(at[0], 101);
        assertEq(at[1], 102);

        (a,,) = board.page(3, 10);
        assertEq(a.length, 2, "past the end returns what is there");
        assertEq(a[1], who[4]);

        (a, on, at) = board.page(5, 10);
        assertEq(a.length, 0);
        (a,,) = board.page(type(uint256).max, type(uint256).max);
        assertEq(a.length, 0);
        (a,,) = board.page(0, type(uint256).max);
        assertEq(a.length, 5, "a huge count doesn't overflow");
    }

    function testFuzz_joinOnceEach(address[8] calldata who) public {
        uint256 distinct;
        for (uint256 i; i < who.length; ++i) {
            if (!board.listed(who[i])) ++distinct;
            vm.prank(who[i]);
            board.join();
        }
        assertEq(board.memberCount(), distinct);
        for (uint256 i; i < who.length; ++i) {
            assertTrue(board.listed(who[i]));
        }
    }
}
