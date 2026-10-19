// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {GooseReceiver, IERC165, IReceiver} from "../src/GooseReceiver.sol";
import {IJustaPermissionManager as PM} from "../src/IJustaPermissionManager.sol";

/// Stands in for the executor: records the call it gets, or reverts with the executor's own error.
contract ExecutorStub {
    bytes public last;
    bool public fail;

    function setFail(bool on) external {
        fail = on;
    }

    function performUpkeep(bytes calldata performData) external {
        if (fail) revert GooseExecutor.RunsPaused();
        last = abi.encodeCall(GooseExecutor.performUpkeep, (performData));
    }

    function registerApproved(PM.Permission calldata permission) external {
        last = abi.encodeCall(GooseExecutor.registerApproved, (permission));
    }

    function pause() external {
        last = "pause";
    }
}

/// GooseReceiver (runner switch plan, C3): only Base's forwarder, only our workflow, only a run or a registration.
contract GooseReceiverTest is Test {
    ExecutorStub executor = new ExecutorStub();
    address forwarder = makeAddr("forwarder");
    address author = makeAddr("workflow owner");
    bytes10 name = bytes10(sha256("greedygoose-runner"));
    GooseReceiver r = new GooseReceiver(address(executor), forwarder, author, name);

    function test_a_report_from_our_workflow_runs_the_executor() public {
        bytes memory report = abi.encodeCall(GooseExecutor.performUpkeep, (abi.encode(new address[](2))));
        vm.prank(forwarder);
        r.onReport(_metadata(author, name), report);
        assertEq(executor.last(), report);
    }

    function test_a_registration_goes_through_too() public {
        PM.Permission memory p;
        p.account = makeAddr("alice");
        bytes memory report = abi.encodeCall(GooseExecutor.registerApproved, (p));
        vm.prank(forwarder);
        r.onReport(_metadata(author, name), report);
        assertEq(executor.last(), report);
    }

    function test_only_the_forwarder() public {
        bytes memory report = abi.encodeCall(GooseExecutor.performUpkeep, (""));
        vm.expectRevert(abi.encodeWithSelector(GooseReceiver.NotForwarder.selector, address(this)));
        r.onReport(_metadata(author, name), report);
    }

    function test_only_our_workflow() public {
        bytes memory report = abi.encodeCall(GooseExecutor.performUpkeep, (""));
        address other = makeAddr("someone else");
        vm.startPrank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(GooseReceiver.WrongOwner.selector, other));
        r.onReport(_metadata(other, name), report);
        vm.expectRevert(abi.encodeWithSelector(GooseReceiver.WrongName.selector, bytes10("other one")));
        r.onReport(_metadata(author, bytes10("other one")), report);
        vm.expectRevert(GooseReceiver.BadMetadata.selector);
        r.onReport(new bytes(61), report);
        vm.stopPrank();
    }

    function test_only_a_run_or_a_registration() public {
        vm.startPrank(forwarder);
        bytes memory pause = abi.encodeCall(GooseExecutor.pause, ());
        vm.expectRevert(abi.encodeWithSelector(GooseReceiver.CallNotAllowed.selector, GooseExecutor.pause.selector));
        r.onReport(_metadata(author, name), pause);
        vm.expectRevert(abi.encodeWithSelector(GooseReceiver.CallNotAllowed.selector, bytes4(0)));
        r.onReport(_metadata(author, name), hex"4585e3");
        vm.stopPrank();
    }

    function test_the_executors_error_comes_back() public {
        executor.setFail(true);
        vm.prank(forwarder);
        vm.expectRevert(GooseExecutor.RunsPaused.selector);
        r.onReport(_metadata(author, name), abi.encodeCall(GooseExecutor.performUpkeep, ("")));
    }

    /// The simulator's mock forwarder sends no identity: a receiver deployed without one skips the check.
    function test_a_simulation_receiver_checks_only_the_forwarder() public {
        GooseReceiver sim = new GooseReceiver(address(executor), forwarder, address(0), bytes10(0));
        vm.prank(forwarder);
        sim.onReport("", abi.encodeCall(GooseExecutor.performUpkeep, ("")));
    }

    function test_on_base_the_owner_is_required() public {
        vm.chainId(8453);
        vm.expectRevert(GooseReceiver.OwnerNeededOnBase.selector);
        new GooseReceiver(address(executor), forwarder, address(0), bytes10(0));
        new GooseReceiver(address(executor), forwarder, author, bytes10(0)); // the owner alone is enough
    }

    function test_constructor_rules() public {
        vm.expectRevert(GooseReceiver.ZeroAddress.selector);
        new GooseReceiver(address(0), forwarder, author, name);
        vm.expectRevert(GooseReceiver.ZeroAddress.selector);
        new GooseReceiver(address(executor), address(0), author, name);
        vm.expectRevert(GooseReceiver.NameNeedsOwner.selector);
        new GooseReceiver(address(executor), forwarder, address(0), name);
    }

    function test_it_says_it_is_a_receiver() public view {
        assertTrue(r.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(r.supportsInterface(type(IERC165).interfaceId));
        assertFalse(r.supportsInterface(0xffffffff));
    }

    /// CRE's layout: 32 bytes of workflow id, 10 of name, 20 of owner, then the production forwarder's 2-byte report id.
    function _metadata(address owner, bytes10 workflowName) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256("workflow id"), workflowName, owner, bytes2(0x0001));
    }
}
