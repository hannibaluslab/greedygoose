// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GuardForkBase} from "./GuardForkBase.sol";
import {FakeAccount} from "./FakeAccount.sol";
import {IJustaPermissionManager as PM, IERC20Lite} from "./IJustaPermissionManager.sol";

/// Build step 7 (spec-final-v2.md §14, items 11-12).
///
/// Isolation, the ExecutorSpike ports (:176, :203, :227) on the real Guard: a refused move rolls back only itself; a
/// failed post-check rolls back the manager's spend metering too; an account that burns gas only burns its own frame's
/// cap, and the next account's move runs. The FakeAccounts are let in the way any new code would be: the owner queues
/// ALLOW_CODEHASH and applies it after 48 hours.
///
/// The invariant fuzz: after any perform of random moves (random kinds, accounts and amounts, junk bits included) by
/// KeeperHub, the Guard holds no token, no allowance from the Guard exists, and no account is left with an allowance
/// to any venue.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardIsolationForkTest -vv
contract GooseGuardIsolationForkTest is GuardForkBase {
    bytes4 constant UNAUTHORIZED_PERMISSION = bytes4(keccak256("JustaPermissionManager_UnauthorizedPermission()"));

    address alice;

    function setUp() public {
        _setUpGuard();
        alice = _owing("alice");
        _setUpFuzz();
    }

    /// An NVDAc-backed account at 1.02 with the credit's cash in savings and $50 in the wallet, every agent on.
    function _owing(string memory name) internal returns (address a) {
        a = _newJawAccount(name);
        _backUsd(a, NVDA, 4_000e6);
        _drawTo(a, 1.02e18);
        _save(a, _bal(address(USDC), a) - 50e6);
        _allOn(a);
    }

    function _aliceRepay() internal view returns (GooseGuard.Move memory) {
        return _move(alice, REPAY, _a2(0, _repayTo(alice, 1.10e18)));
    }

    /// The owner lets `codehash` register: queued, then applied by anyone 48 hours later.
    function _allow(bytes32 codehash) internal {
        g.queueChange(2, codehash);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        g.applyChange(2, codehash);
    }

    /// A FakeAccount backing credit at 1.02 with savings, its Protect permission (finite limits, so metering shows)
    /// approved in the manager and registered with the Guard.
    function _fake(bool burn) internal returns (FakeAccount fake, PM.Permission memory p) {
        fake = new FakeAccount(burn);
        if (!g.codehashOk(address(fake).codehash)) _allow(address(fake).codehash);
        address f = address(fake);
        _backUsd(f, NVDA, 4_000e6);
        _drawTo(f, 1.02e18);
        _save(f, _bal(address(USDC), f) - 50e6);
        p = _protectP(f);
        p.spends[0].allowance = 5_000e6;
        p.spends[1].allowance = 5_000e6;
        vm.startPrank(f);
        MANAGER.approve(p);
        g.register(JOB_PROTECT, abi.encode(p));
        vm.stopPrank();
    }

    // ================================================================== ExecutorSpike :176

    /// Bob revokes his Protect grant in JAW's manager but never unregisters. In one perform Bob's repay is refused by
    /// the manager and rolls back alone; Alice's runs.
    function test_one_refusal_rolls_back_only_that_move() public {
        address bob = _newJawAccount("bob");
        _backUsd(bob, NVDA, 4_000e6);
        _drawTo(bob, 1.02e18);
        _save(bob, _bal(address(USDC), bob) - 50e6);
        PM.Permission memory p = _protectOn(bob);
        _revokeThroughAccount(p);
        Holdings memory h = _holdings(bob);

        GooseGuard.Move[] memory moves = new GooseGuard.Move[](2);
        moves[0] = _move(bob, REPAY, _a2(0, _repayTo(bob, 1.10e18)));
        moves[1] = _aliceRepay();
        uint256 debt = _debt(alice);
        (, Vm.Log[] memory logs) = _perform(abi.encode(moves));
        assertEq(_reason(logs, bob), UNAUTHORIZED_PERMISSION, "bob's move wasn't refused by the manager");
        assertEq(_reason(logs, alice), bytes4(0), "alice's move was refused");
        assertLt(_debt(alice), debt, "alice wasn't repaid");
        _assertUnchanged(bob, h);
    }

    // ================================================================== ExecutorSpike :203

    /// A FakeAccount answers the manager's executeBatch without running the calls. The manager meters the batch's
    /// USDC approve, then the Guard's post-check finds the debt not lower (DebtNotLower) and the whole frame, the
    /// metering included, rolls back. The same batch without the Guard's post-check uses up the limit.
    function test_a_failed_post_check_rolls_back_the_managers_metering() public {
        (FakeAccount fake, PM.Permission memory p) = _fake(false);
        address f = address(fake);
        uint256 repay = 100e6;
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](2);
        moves[0] = _move(f, REPAY, _a2(0, repay));
        moves[1] = _aliceRepay();
        (, Vm.Log[] memory logs) = _perform(abi.encode(moves));
        assertEq(_reason(logs, f), GooseGuard.DebtNotLower.selector, "the fake's move wasn't refused");
        assertEq(_reason(logs, alice), bytes4(0), "alice's move was refused");
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[0]).spend, 0, "the fake's metering wasn't rolled back");

        // The Guard's own calls for that repay, run through the manager with no post-check: metered.
        PM.Call[] memory calls = new PM.Call[](3);
        calls[0] = PM.Call(address(POOL), 0, abi.encodeWithSelector(V3_WITHDRAW, address(USDC), repay, f));
        calls[1] = PM.Call(address(USDC), 0, abi.encodeWithSelector(APPROVE, address(SPOKE), repay));
        calls[2] = PM.Call(address(SPOKE), 0, abi.encodeWithSelector(V4_REPAY, USDC_RESERVE, repay, f));
        vm.prank(address(g));
        MANAGER.executeBatch(p, calls);
        assertEq(MANAGER.getCurrentPeriod(p, p.spends[0]).spend, repay, "metered without the post-check");
    }

    // ================================================================== ExecutorSpike :227

    /// A FakeAccount that burns every unit of gas it's given: its move burns its own frame's cap (REPAY, 0.9M) and is
    /// refused with no reason; Alice's repay after it runs in the same 5.4M perform.
    function test_an_account_that_burns_gas_burns_only_its_own_cap() public {
        (FakeAccount fake,) = _fake(true);
        address f = address(fake);
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](2);
        moves[0] = _move(f, REPAY, _a2(0, 100e6));
        moves[1] = _aliceRepay();
        uint256 debt = _debt(alice);
        (uint256 used, Vm.Log[] memory logs) = _perform(abi.encode(moves));
        console2.log("perform gas with the burner first", used);
        assertEq(_reason(logs, f), OUT_OF_GAS, "the burner wasn't refused for gas");
        assertEq(_reason(logs, alice), bytes4(0), "alice's move was refused");
        assertLt(_debt(alice), debt, "alice wasn't repaid");
        assertLt(used, g.capOf(REPAY, new uint256[](2)) + 1_000_000, "the burner cost more than its cap");
    }

    /// Eight burners ahead of Alice: each costs its cap until the gas gate refuses the rest cheaply (NoGas), and the
    /// perform still doesn't revert. Alice is reached only if gas is left, so the Planner must put Protect first.
    function test_burners_are_refused_for_gas_and_the_perform_never_reverts() public {
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](9);
        for (uint256 i; i < 8; ++i) {
            (FakeAccount fake,) = _fake(true);
            moves[i] = _move(address(fake), REPAY, _a2(0, 100e6));
        }
        moves[8] = _aliceRepay();
        (uint256 used, Vm.Log[] memory logs) = _perform(abi.encode(moves));
        bytes4[] memory r = _reasons(logs);
        uint256 burnt;
        uint256 noGas;
        for (uint256 i; i < r.length; ++i) {
            if (r[i] == OUT_OF_GAS) ++burnt;
            if (r[i] == GooseGuard.NoGas.selector) ++noGas;
        }
        console2.log("burnt their cap", burnt, "refused NoGas", noGas);
        console2.log("perform gas", used);
        assertEq(r.length, 9, "every move was refused, Alice's for gas too");
        assertEq(_reason(logs, alice), GooseGuard.NoGas.selector);
        assertLe(used, KH_GAS);
    }

    // ================================================================== the invariant fuzz

    address[4] fuzzers;

    /// Four accounts with every agent on: one owing with savings and two stocks backing it, one with a drifted mix and
    /// top-ups on, one holding every Turn into cash coin, one with idle cash.
    function _setUpFuzz() internal {
        fuzzers[0] = _newJawAccount("f-owing");
        _backUsd(fuzzers[0], AAPL, 2_000e6);
        _backUsd(fuzzers[0], NVDA, 2_000e6);
        _drawTo(fuzzers[0], 1.02e18);
        _save(fuzzers[0], _bal(address(USDC), fuzzers[0]) - 100e6);

        fuzzers[1] = _newJawAccount("f-mix");
        uint16[7] memory w = [uint16(2000), 0, 0, 3000, 0, 5000, 0];
        deal(STOCKS[AAPL], fuzzers[1], _sharesFor(AAPL, 1_500e6));
        deal(STOCKS[3], fuzzers[1], _sharesFor(3, 300e6));
        deal(NVDAC, fuzzers[1], _sharesFor(NVDA, 800e6));
        deal(address(USDC), fuzzers[1], 2_000e6);
        vm.startPrank(fuzzers[1]);
        g.setMix(_pack(w));
        g.setTopUps(true, 200e6);
        vm.stopPrank();

        fuzzers[2] = _newJawAccount("f-coins");
        deal(USDT, fuzzers[2], 500e6);
        deal(USDE, fuzzers[2], 500e18);
        deal(USDS, fuzzers[2], 500e18);
        deal(DAI, fuzzers[2], 500e18);
        deal(EURC, fuzzers[2], 500e6);

        fuzzers[3] = _newJawAccount("f-cash");
        deal(address(USDC), fuzzers[3], 1_000e6);
        for (uint256 i; i < 4; ++i) {
            _allOn(fuzzers[i]);
        }
    }

    /// A move for an account from a seed. Three in four are shaped like an honest Planner's (the kind's own account,
    /// legs in the right direction, fuzzed sizes); the rest pick any account and any sizes, and now and then put junk
    /// in a leg's unused bits.
    function _fuzzMove(uint256 seed) internal view returns (GooseGuard.Move memory m) {
        uint8 kind = uint8((seed >> 8) % 8); // 7 is not a kind
        bool honest = (seed >> 80) % 4 != 0;
        address a = honest ? fuzzers[_home(kind)] : fuzzers[seed % 4];
        uint256 frac = 1 + (seed >> 16) % 3000; // up to 30%, in BPS
        uint256 r = honest ? (kind == SELL ? ((seed >> 32) % 2 == 0 ? AAPL : NVDA) : AAPL) : (seed >> 32) % 7;
        uint256 junk = (seed >> 40) % 16 == 0 ? uint256(uint160(seed)) << 128 & ((1 << 247) - 1) : 0;
        uint256[] memory args;
        if (kind == SAVE) {
            args = _a1(_bal(address(USDC), a) * frac / 1e4 * 5);
        } else if (kind == REPAY) {
            args = _a2(_bal(address(USDC), a) * frac / 1e4, _debt(a) * frac / 1e4);
        } else if (kind == SELL) {
            // Honest slices stay under 2% of the debt, so each withdraw keeps health above 1.
            uint256 n = 1 + (seed >> 48) % 3;
            args = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                uint256 rr = honest ? r : (r + i * 5) % 7;
                uint256 usd = honest ? _debt(a) * frac / 1.5e5 + 1e5 : (_debt(a) + 100e6) * frac / 1e5 + 1e6;
                args[i] = _leg(rr, _sharesFor(rr, usd)) | junk;
            }
        } else if (kind == TRADE && honest) {
            // The mix account: AAPLc is over its target, METAc and NVDAc under. Sell some AAPLc, buy with its floor.
            // The buy spends exactly the sale's floor, as the Planner's does (GG-06).
            uint256 shares = _sharesFor(AAPL, 1e6 + 400e6 * frac / 3e3);
            uint256 floor = shares * _price(AAPL) * 9950 / 1e14;
            args = _a3(0, _leg(AAPL, shares), _buy((seed >> 48) % 2 == 0 ? 3 : NVDA, floor));
        } else if (kind == TRADE) {
            uint256 n = 1 + (seed >> 48) % 3;
            args = new uint256[](n + 1);
            args[0] = (seed >> 56) % 2 == 0 ? 0 : _bal(address(USDC), a) * frac / 1e4;
            for (uint256 i; i < n; ++i) {
                uint256 rr = (r + i * 3) % 7;
                bool buy = (seed >> (60 + i)) % 2 == 1;
                args[i + 1] = buy
                    ? _buy(rr, 1e6 + 500e6 * frac / 1e4)
                    : _leg(rr, _sharesFor(rr, 1e6 + 500e6 * frac / 1e4)) | junk;
            }
        } else if (kind == CONVERT) {
            args = _a2((seed >> 48) % 5, (seed >> 64) % 2 == 0 ? type(uint128).max : 1e6 + frac * 1e14);
        } else {
            args = _a0();
        }
        m = _move(a, kind, args);
    }

    /// The account each kind's honest move is for.
    function _home(uint8 kind) internal pure returns (uint256) {
        if (kind == TRADE) return 1;
        if (kind == CONVERT) return 2;
        if (kind == SAVE) return 3;
        return 0;
    }

    /// The Guard holds no token and grants no allowance; no account is left with an allowance to a venue.
    function _assertHoldsNothing() internal view {
        address[6] memory spenders = [address(SPOKE), address(POOL), ROUTER, AERODROME_V1_ROUTER, UNISWAP_ROUTER, PSM3];
        address[14] memory tokens = [
            address(USDC), address(AUSDC), USDT, USDE, USDS, DAI, EURC,
            STOCKS[0], STOCKS[1], STOCKS[2], STOCKS[3], STOCKS[4], STOCKS[5], STOCKS[6]
        ];
        for (uint256 t; t < 14; ++t) {
            assertEq(_bal(tokens[t], address(g)), 0, "the Guard holds a token");
        }
        assertEq(address(g).balance, 0, "the Guard holds ETH");
        for (uint256 s; s < 6; ++s) {
            for (uint256 t; t < 14; ++t) {
                if (t == 1) continue; // aUSDC is never approved
                assertEq(IERC20Lite(tokens[t]).allowance(address(g), spenders[s]), 0, "the Guard granted an allowance");
                for (uint256 i; i < 4; ++i) {
                    assertEq(IERC20Lite(tokens[t]).allowance(fuzzers[i], spenders[s]), 0, "an allowance was left");
                }
            }
        }
    }

    /// forge-config: default.fuzz.runs = 48
    function testFuzz_the_guard_holds_nothing_after_any_perform(uint256[3] memory seeds) public {
        for (uint256 round; round < 3; ++round) {
            uint256 n = 1 + seeds[round] % 3;
            GooseGuard.Move[] memory moves = new GooseGuard.Move[](n);
            for (uint256 i; i < n; ++i) {
                moves[i] = _fuzzMove(uint256(keccak256(abi.encode(seeds[round], i))));
            }
            _perform(abi.encode(moves));
            _assertHoldsNothing();
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
            vm.roll(block.number + 300);
        }
    }

    /// The fuzz's move generator reaches the moves themselves, not only their refusals: over 60 fixed seeds, every
    /// kind that moves money runs at least once, and the invariant holds after each perform.
    function test_the_fuzzed_moves_run_as_well_as_refuse() public {
        uint256[8] memory ran;
        uint256[8] memory refused;
        for (uint256 i; i < 60; ++i) {
            GooseGuard.Move memory m = _fuzzMove(uint256(keccak256(abi.encode("seed", i))));
            (, Vm.Log[] memory logs) = _perform(_oneMove(m));
            if (_reason(logs, m.account) == bytes4(0)) ++ran[m.kind];
            else ++refused[m.kind];
            _assertHoldsNothing();
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
        }
        for (uint256 k; k < 8; ++k) {
            console2.log("kind", k, "ran", ran[k]);
            console2.log("  refused", refused[k]);
        }
        for (uint256 k; k < 5; ++k) {
            assertGt(ran[k], 0, "a kind never ran");
        }
    }
}
