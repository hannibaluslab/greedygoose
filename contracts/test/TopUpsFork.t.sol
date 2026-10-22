// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {GooseExecutor} from "../src/GooseExecutor.sol";
import {IAaveV3Pool, IAeroRouter, IERC20} from "../src/IProtocols.sol";
import {ProtectCase, TopUps} from "../src/CashRules.sol";
import {NyCalendar} from "../src/NyCalendar.sol";
import {RebalanceBook, RebalanceLimits, RebalanceRules, Trade} from "../src/RebalanceRules.sol";
import {EntryJob} from "../src/jobs/EntryJob.sol";
import {RebalanceJob} from "../src/jobs/RebalanceJob.sol";
import {RebalanceForkBase} from "./RebalanceFork.t.sol";
import {IJustaPermissionManager as PM} from "./IJustaPermissionManager.sol";

/// Fixtures for top-ups on a Base fork: the Rebalancer's (every stock a StockDouble with its pool's real balances,
/// Aave's price at each pool's own, Tuesday 10:05 New York), on an executor with no amount limit, CAP_MAX the largest
/// uint160 as a production deploy has it.
abstract contract TopUpsForkBase is RebalanceForkBase {
    uint16[7] fiftyFifty = [uint16(5_000), 0, 0, 0, 0, 5_000, 0]; // Apple and NVIDIA

    function _setUpTopUps() internal {
        _setUpRebalance();
        GooseExecutor.Config memory c = _config();
        c.capMax = type(uint160).max;
        x = _deploy(c);
    }

    /// A fresh JAW account with free stock worth `usd` of each stock in `stocks` (USDC units at Aave's price), the mix
    /// `weights`, `savings` in savings and $1 in the wallet; Save on, the Rebalancer on with top-ups (the app's one grant at
    /// CAP_MAX, each stock it may sell worth $50,000 a week), and its own switch on with Keep `keep`.
    function _investor(
        string memory name,
        uint256[] memory stocks,
        uint256[] memory usd,
        uint16[7] memory weights,
        uint256 savings,
        uint48 keep
    ) internal returns (address a) {
        a = _newJawAccount(name);
        uint256 t;
        for (uint256 i; i < stocks.length; ++i) {
            uint256 r = stocks[i];
            deal(STOCKS[r], a, usd[i] * 1e10 / _price(r));
            t |= 50_000e6 * 1e10 / _price(r) / 1e4 << (32 * r);
        }
        vm.prank(a);
        x.setMix(weights);
        if (savings > 0) _withSavings(a, savings);
        deal(address(USDC), a, 1e6); // Save's keep-back, over the $0.50 fuel tank
        _turnOn(a, GooseExecutor.Job.Save, x.CAP_MAX());
        _rebalanceGrant(a, t, true);
        vm.prank(a);
        x.setTopUps(true, keep);
    }

    /// The Rebalancer's grant at CAP_MAX, with or without top-ups, approved through the account and registered.
    function _rebalanceGrant(address a, uint256 t, bool topUps) internal returns (PM.Permission memory p) {
        uint48 start = uint48(vm.getBlockTimestamp());
        p = x.permissionFor(
            GooseExecutor.Job.Rebalance,
            a,
            GooseExecutor.Grant(start, start + 365 days, x.CAP_MAX()),
            uint256(keccak256(abi.encode(++salts))),
            topUps ? t | RebalanceJob.TOP_UPS : t
        );
        _grantThroughAccount(p);
        x.registerApproved(abi.encode(p));
    }

    /// `amount` of USDC arrives from outside, and the next run's Save puts it into savings.
    function _topUp(address a, uint256 amount) internal {
        deal(address(USDC), a, USDC.balanceOf(a) + amount);
        _run(_one(a));
    }

    /// The account's Rebalancer stock limits, packed as terms, read from its stored grant (after aUSDC with top-ups).
    function _stockTermsOf(address a) internal view returns (uint256 t) {
        PM.Permission memory p = x.permissionOf(a, GooseExecutor.Job.Rebalance);
        uint256 first = p.spends.length > 1 && p.spends[1].token == address(AUSDC) ? 2 : 1;
        for (uint256 j = first; j < p.spends.length; ++j) {
            for (uint256 r; r < 7; ++r) {
                if (STOCKS[r] == p.spends[j].token) t |= uint256(p.spends[j].allowance) / 1e4 << (32 * r);
            }
        }
    }

    function _topUpsOf(address a) internal view returns (TopUps memory t) {
        (t.on, t.day, t.keep, t.ready, t.today, t.mark, t.own) = x.topUps(a);
    }

    /// `days_` New York days on from today, at `nyTime` seconds past midnight New York time.
    function _warpNy(uint256 days_, uint256 nyTime) internal {
        uint256 d = NyCalendar.day(vm.getBlockTimestamp()) + days_;
        vm.warp(d * 1 days + nyTime + NyCalendar.offset(d * 1 days + nyTime + 5 hours));
    }

    function _one(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _invested(Vm.Log[] memory logs) internal view returns (uint256 amount, uint256[7] memory bought) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(x) && logs[i].topics[0] == GooseExecutor.TopUpInvested.selector) {
                return abi.decode(logs[i].data, (uint256, uint256[7]));
            }
        }
    }

    function _counted(Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(x) && logs[i].topics[0] == GooseExecutor.TopUpCounted.selector) return true;
        }
        return false;
    }

    function _holdsNoStock() internal view {
        for (uint256 r; r < 7; ++r) {
            assertEq(IERC20(STOCKS[r]).balanceOf(address(x)), 0, "the executor holds no stock");
        }
    }
}

/// Top-ups go into my mix against the real JAW manager, Aave V3 savings and Aerodrome's stock pools on a Base fork, with
/// fresh JAW accounts granted the way the app grants: Save counts what arrives (Keep first, the agents' own change left
/// out), Rebalance puts it into the mix from savings at the next market morning's check, buying what's furthest below
/// its target; never the day it arrived, never in Act, never with a pool off Aave's price; and the post-checks and the
/// manager catch a withdraw to someone else, a second withdraw and buys past the amount.
contract TopUpsForkTest is TopUpsForkBase {
    function setUp() public {
        _setUpTopUps();
    }

    /// 46/54 NVIDIA/Apple, inside its band, $1,000 in savings and Keep $500: a $300 top-up on Tuesday afternoon waits
    /// through Wednesday 9:59 and goes into NVIDIA, the stock furthest below its target, at 10:00, from savings.
    function test_a_top_up_goes_into_the_mix_the_next_market_morning() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 500e6);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "in its band: nothing to trade");
        _warpNy(0, 15 hours);
        vm.expectEmit(true, false, false, true, address(x));
        emit GooseExecutor.TopUpCounted(a, 300e6, 300e6);
        _topUp(a, 300e6);
        assertEq(_topUpsOf(a).today, 300e6, "counted today");

        _warpNy(1, 10 hours - 1);
        assertEq(_check().length, 0, "Wednesday 9:59:59");
        _warpNy(0, 10 hours);
        GooseExecutor.Plan memory plan = x.planOf(a);
        assertEq(uint8(plan.action), uint8(GooseExecutor.Action.Rebalance), "Wednesday 10:00");
        assertEq(plan.reason, RebalanceJob.INVEST, "puts top-ups in");
        assertEq(plan.amount, 300e6);

        uint256 savings = AUSDC.balanceOf(a);
        uint256 cash = USDC.balanceOf(a);
        uint256 apple = IERC20(STOCKS[AAPL]).balanceOf(a);
        uint256 nvda = IERC20(STOCKS[NVDA]).balanceOf(a);
        vm.recordLogs();
        uint256 gas = gasleft();
        _run(_check());
        console.log("a $300 top-up into one stock: run gas", gas - gasleft());
        (uint256 amount, uint256[7] memory bought) = _invested(vm.getRecordedLogs());
        assertEq(amount, 300e6, "the invest is the buys' sum");
        assertApproxEqAbs(
            savings - AUSDC.balanceOf(a), 300e6, 2, "savings fall by the invest, give or take Aave's rounding"
        );
        assertLe(savings - AUSDC.balanceOf(a), 300e6 + 2);
        assertEq(USDC.balanceOf(a), cash, "the wallet's cash doesn't move");
        assertEq(IERC20(STOCKS[NVDA]).balanceOf(a), nvda + bought[NVDA]);
        assertGe(bought[NVDA], 300e6 * 1e10 * 9_950 / (_price(NVDA) * 1e4), "at least Aave's price less the floor");
        assertEq(IERC20(STOCKS[AAPL]).balanceOf(a), apple, "Apple, over its target, untouched");
        _assertHoldsNothing();
        _holdsNoStock();
        TopUps memory t = _topUpsOf(a);
        assertEq(uint256(t.ready) + t.today, 0, "nothing waits");
        assertEq(t.mark, AUSDC.balanceOf(a), "the invest isn't read as a fall");
        assertEq(_check().length, 0, "one batch a day");
    }

    /// Keep $500 and nothing in savings: a $400 top-up fills Keep and counts nothing. Then $1,000 of USDT arrives, Entry
    /// turns it into cash and Save puts it away: what passes Keep counts.
    function test_counting_fills_keep_first_and_counts_what_entry_converted() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 0, 500e6);
        _turnOn(a, GooseExecutor.Job.Entry, 10_000e6);
        _warpNy(0, 15 hours);
        vm.recordLogs();
        _topUp(a, 400e6);
        assertFalse(_counted(vm.getRecordedLogs()), "it fills Keep");
        assertEq(uint256(_topUpsOf(a).today), 0);

        deal(EntryJob.USDT, a, 1_000e6);
        _run(_one(a)); // Entry turns it into cash
        uint256 converted = USDC.balanceOf(a) - 1e6;
        assertGe(converted, 995e6);
        _run(_one(a)); // Save puts it into savings
        assertApproxEqAbs(_topUpsOf(a).today, 400e6 + converted - 500e6, 2, "all that passes Keep");
    }

    /// The cash already in the wallet when top-ups go on stays as it is: Save puts it away and counts none of it, then
    /// counts the next top-up in full.
    function test_the_cash_already_there_when_top_ups_go_on_stays_cash() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        vm.prank(a);
        x.setTopUps(false, 0);
        deal(address(USDC), a, 501e6); // $500 arrived while Save was off, and the $1 keep-back
        vm.prank(a);
        x.setTopUps(true, 0);
        assertEq(_topUpsOf(a).own, 500e6);
        _warpNy(0, 15 hours);
        vm.recordLogs();
        _run(_one(a));
        assertFalse(_counted(vm.getRecordedLogs()), "the $500 was there before");
        assertEq(USDC.balanceOf(a), 1e6, "and is in savings now");
        _topUp(a, 300e6);
        assertEq(_topUpsOf(a).today, 300e6, "the next top-up counts in full");
    }

    /// A top-up counted at 9:59 waits for the next market day, not the check a minute later; one counted on Friday
    /// waits for Monday.
    function test_a_top_up_never_goes_in_the_day_it_arrived_and_friday_waits_for_monday() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        _warpNy(1, 10 hours - 1 minutes); // Wednesday 9:59
        _topUp(a, 300e6);
        _warpNy(0, 10 hours);
        assertEq(_check().length, 0, "Wednesday 10:00: arrived today");
        _warpNy(1, 10 hours);
        assertEq(x.planOf(a).amount, 300e6, "Thursday 10:00");
        _run(_check());
        assertEq(_topUpsOf(a).ready, 0);

        _warpNy(1, 15 hours); // Friday 15:00
        _topUp(a, 200e6);
        _warpNy(1, 10 hours);
        assertEq(_check().length, 0, "Saturday: prices are held");
        _warpNy(1, 10 hours);
        assertEq(_check().length, 0, "Sunday");
        _warpNy(1, 10 hours);
        assertEq(x.planOf(a).amount, 200e6, "Monday 10:00");
    }

    /// Investing needs both: the account's own switch and the grant's top-ups. Switched off, Save counts nothing; with a
    /// grant without them, what's counted stays cash. And anyone may register a grant: an older one with top-ups can't
    /// come back over the newer one without.
    function test_investing_needs_the_switch_and_the_grant() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        PM.Permission memory withTopUps = x.permissionOf(a, GooseExecutor.Job.Rebalance);
        vm.prank(a);
        x.setTopUps(false, 0);
        _warpNy(0, 15 hours);
        _topUp(a, 300e6);
        assertEq(uint256(_topUpsOf(a).today), 0, "switched off: nothing counted");
        _warpNy(1, 10 hours);
        assertEq(_check().length, 0, "and nothing goes in");

        vm.prank(a);
        x.setTopUps(true, 0);
        _rebalanceGrant(a, _stockTermsOf(a), false);
        _warpNy(0, 15 hours);
        _topUp(a, 300e6);
        assertEq(uint256(_topUpsOf(a).today), 300e6, "counted");
        _warpNy(1, 10 hours);
        assertEq(_check().length, 0, "the grant has no savings withdraw: it stays cash");
        uint256 savings = AUSDC.balanceOf(a);

        vm.prank(attacker);
        vm.expectRevert(GooseExecutor.StaleGrant.selector);
        x.registerApproved(abi.encode(withTopUps));
        assertEq(_check().length, 0);
        assertGe(AUSDC.balanceOf(a), savings);
    }

    /// The check waits while the credit is in Act and while a pool it would buy from is off Aave's price; a batch that
    /// can't meet its floor moves nothing, keeps what's waiting and goes in on the next market day.
    function test_it_waits_in_act_or_with_a_pool_off_and_a_skipped_batch_keeps_its_count() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        _backWith(a, TSLA, 5e8);
        _drawTo(a, 1.05e18); // Act, above Protect's line
        _save(a, USDC.balanceOf(a) - 1e6); // the app puts credit taken as cash into savings in the same signature
        _warpNy(0, 15 hours);
        _topUp(a, 300e6);
        _warpNy(1, 10 hours);
        assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "in Act: waits");
        _backWith(a, TSLA, 1e8); // out of Act
        assertEq(x.planOf(a).amount, 300e6);

        _priceAt(NVDA, 10_060);
        assertEq(_check().length, 0, "NVIDIA's pool 0.6% off Aave's price: waits");
        _priceAt(NVDA, 9_952); // in line, but a buy there can't get Aave's price less 0.5%
        uint256 savings = AUSDC.balanceOf(a);
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.RebalanceSkipped(a);
        _run(_check());
        assertGe(AUSDC.balanceOf(a), savings, "nothing moved");
        TopUps memory t = _topUpsOf(a);
        assertEq(uint256(t.ready) + t.today, 300e6, "the count is kept");
        assertEq(_check().length, 0, "done for the day");

        _priceAt(NVDA, 10_000);
        _warpNy(1, 10 hours);
        assertEq(x.planOf(a).amount, 300e6, "the next market day");
    }

    /// Protect repays from savings after a top-up is counted: the fall comes out of what's waiting first.
    function test_a_protect_repay_shrinks_what_is_waiting() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        _turnOn(a, GooseExecutor.Job.Protect, x.CAP_MAX());
        _backWith(a, TSLA, 5e8);
        _drawTo(a, 1.2e18);
        _save(a, USDC.balanceOf(a) - 1e6);
        _warpNy(0, 15 hours);
        _topUp(a, 300e6);
        uint256 mark = _topUpsOf(a).mark;

        _priceAt(TSLA, 8_400); // Tesla 16% down: under Protect's line
        assertLt(SPOKE.getUserAccountData(a).healthFactor, 1.03e18);
        vm.expectEmit(true, false, false, false, address(x));
        emit GooseExecutor.ProtectRepaid(a, 0, 0, 0, ProtectCase(0));
        _run(_check());
        uint256 repaid = mark - AUSDC.balanceOf(a);
        assertGt(repaid, 0);

        _warpNy(1, 10 hours);
        uint256 waiting = repaid >= 300e6 ? 0 : 300e6 - repaid;
        // Savings earn overnight, which offsets the fall a little: rises never add, but they do net.
        if (waiting >= 20e6) assertApproxEqAbs(x.planOf(a).amount, waiting, 1e6, "the top-up less Protect's repay");
        else assertEq(uint8(x.planOf(a).action), uint8(GooseExecutor.Action.None), "all of it went to Protect");
        console.log("Protect repaid from savings, waiting after", repaid, waiting);
    }

    /// The fuel tank (lib/fuelTank.ts): Fill up brings the wallet back from savings, never past Save's keep-back
    /// (tests/unit/top-ups.test.ts holds the app to that). Filled right up to it, the most the app may: Save leaves the
    /// fill in the wallet, the fill is a fall in savings that comes out of what's waiting (P4), and the next top-up
    /// counts only what arrived.
    function test_a_fill_up_is_never_counted_and_comes_out_of_what_is_waiting() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        (,, uint64 keepBack,,) = x.amounts();
        _warpNy(0, 15 hours);
        _topUp(a, 300e6);
        assertEq(_topUpsOf(a).today, 300e6);

        uint256 fill = _drainAndFill(a, keepBack);
        vm.recordLogs();
        _run(_one(a));
        assertFalse(_counted(vm.getRecordedLogs()), "nothing to save");
        assertEq(USDC.balanceOf(a), keepBack, "the fill stays in the wallet");

        _topUp(a, 100e6);
        uint256 today = _topUpsOf(a).today;
        assertApproxEqAbs(today, 400e6 - fill, 2, "the fill came out of what's waiting");
        assertLt(today, 400e6, "never more than arrived");
        assertEq(USDC.balanceOf(a), keepBack);
        console.log("$300 counted, a fill of", fill, "then $100: waiting", today);
    }

    /// With nothing waiting, P4 has nothing to take a fill out of: the next top-up counts exactly what arrived, as long
    /// as the fill stops at the keep-back. One unit past it, the executor can't tell that unit from a top-up and counts
    /// it with the next one, savings bought into the mix: why the app's tank stays under Save's keep-back.
    function test_a_fill_up_past_the_keep_back_is_counted_with_the_next_top_up() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        address b = _investor("b", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        (,, uint64 keepBack,,) = x.amounts();
        _warpNy(0, 15 hours);
        _drainAndFill(a, keepBack);
        _drainAndFill(b, keepBack + 1);
        _topUp(a, 100e6);
        _topUp(b, 100e6);
        assertEq(_topUpsOf(a).today, 100e6, "exactly what arrived");
        assertEq(_topUpsOf(b).today, 100e6 + 1, "and the unit of savings past the keep-back");
    }

    /// Network fees drain the wallet to $0.10, then Fill up, the user's own batch (lib/fuelTank.ts), withdraws savings
    /// into it up to `to`. Returns the fill.
    function _drainAndFill(address a, uint256 to) internal returns (uint256 fill) {
        deal(address(USDC), a, 0.1e6);
        fill = to - 0.1e6;
        vm.prank(a);
        POOL.withdraw(address(USDC), fill, a);
        assertEq(USDC.balanceOf(a), to);
    }

    /// The change a band trade leaves in the wallet is the agents' own: Save puts it away and counts none of it.
    function test_the_agents_own_change_is_never_counted() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(5_600e6, 4_400e6), fiftyFifty, 1_000e6, 0);
        uint256 cash = USDC.balanceOf(a);
        _run(_check()); // 56/44: a band trade
        uint256 change = USDC.balanceOf(a) - cash;
        assertGt(change, 0, "the sale got more than its floor");
        assertEq(_topUpsOf(a).own, change);

        _warpNy(0, 15 hours);
        vm.recordLogs();
        _run(_one(a)); // Save puts the change into savings
        assertFalse(_counted(vm.getRecordedLogs()), "not a top-up");
        TopUps memory t = _topUpsOf(a);
        assertEq(uint256(t.ready) + t.today, 0);
        assertEq(t.own, 0);
    }

    /// A new Rebalance grant starts with nothing waiting: what was counted before it stays cash.
    function test_a_new_rebalance_grant_drops_what_was_counted_before() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        PM.Permission memory p = x.permissionOf(a, GooseExecutor.Job.Rebalance);
        _warpNy(0, 15 hours);
        _topUp(a, 300e6);
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(p.spends.length, 4, "with top-ups");
        _rebalanceGrant(a, _stockTermsOf(a), true);
        assertEq(uint256(_topUpsOf(a).today), 0, "renewed: nothing waits");
        _warpNy(1, 10 hours);
        assertEq(_check().length, 0);
    }

    // ================================================================== the attacks

    /// The planned batch, built by hand: $300 out of savings, approve it, buy NVIDIA with it.
    function _plannedInvest(address a) internal view returns (Trade[] memory t, PM.Call[] memory calls) {
        t = new Trade[](1);
        t[0] = Trade(uint8(NVDA), true, 300e6, 300e6 * 1e10 * 9_950 / (_price(NVDA) * 1e4));
        calls = new PM.Call[](3);
        calls[0] = _withdrawSavings(a, 300e6);
        calls[1] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(ROUTER), 300e6)));
        calls[2] = _buyWith(NVDA, 300e6, a);
    }

    function test_a_withdraw_to_someone_else_reverts() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        deal(address(USDC), a, 1_000e6); // cash the buy could take instead
        (Trade[] memory t, PM.Call[] memory calls) = _plannedInvest(a);
        calls[0] = _withdrawSavings(attacker, 300e6);
        vm.expectRevert(GooseExecutor.CashLower.selector);
        this.investWith(a, t, 300e6, calls);
    }

    function test_a_second_withdraw_or_all_of_savings_reverts() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        (Trade[] memory t, PM.Call[] memory calls) = _plannedInvest(a);
        PM.Call[] memory twice = new PM.Call[](4);
        (twice[0], twice[1], twice[2], twice[3]) = (calls[0], calls[0], calls[1], calls[2]);
        vm.expectRevert(GooseExecutor.SavingsMoved.selector);
        this.investWith(a, t, 300e6, twice);

        calls[0] = _withdrawSavings(a, type(uint256).max);
        vm.expectRevert(GooseExecutor.SavingsMoved.selector);
        this.investWith(a, t, 300e6, calls);
    }

    function test_buys_past_the_amount_revert() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        deal(address(USDC), a, 1_000e6);
        (Trade[] memory t, PM.Call[] memory calls) = _plannedInvest(a);
        calls[1] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(ROUTER), 600e6)));
        calls[2] = _buyWith(NVDA, 600e6, a); // $300 of savings and $300 of the wallet's cash
        vm.expectRevert(GooseExecutor.CashLower.selector);
        this.investWith(a, t, 300e6, calls);

        (t, calls) = _plannedInvest(a);
        vm.expectRevert(GooseExecutor.WrongAmount.selector);
        this.investWith(a, t, 400e6, calls); // an invest that isn't the buys' sum

        // A batch that sells while putting top-ups in is refused too.
        Trade[] memory withSale = new Trade[](2);
        (withSale[0], withSale[1]) = (Trade(uint8(AAPL), false, 1e6, 1), t[0]);
        vm.expectRevert(GooseExecutor.WrongAmount.selector);
        this.investWith(a, withSale, 300e6, calls);
    }

    /// Without top-ups the grant has no savings withdraw: the manager refuses one.
    function test_a_grant_without_top_ups_cannot_touch_savings() public {
        address a = _investor("a", _list(NVDA, AAPL), _list(4_600e6, 5_400e6), fiftyFifty, 1_000e6, 0);
        _rebalanceGrant(a, _stockTermsOf(a), false);
        PM.Call[] memory calls = new PM.Call[](1);
        calls[0] = _withdrawSavings(a, 300e6);
        vm.expectPartialRevert(UNAUTHORIZED_CALL);
        this.investWith(a, new Trade[](0), 0, calls);
    }

    /// Runs `calls` through the manager as the executor, with `account`'s Rebalancer permission, under the post-checks of
    /// an invest of `invest` with `trades`.
    function investWith(address account, Trade[] calldata trades, uint256 invest, PM.Call[] calldata calls) external {
        PM.Permission memory p = x.permissionOf(account, GooseExecutor.Job.Rebalance);
        RebalanceJob.Before memory b = RebalanceJob.snapshot(x.env(), account, trades, invest);
        vm.prank(address(x));
        MANAGER.executeBatch(p, calls);
        RebalanceJob.check(x.env(), account, b);
    }

    function _withdrawSavings(address to, uint256 amount) internal pure returns (PM.Call memory) {
        return PM.Call(address(POOL), 0, abi.encodeCall(IAaveV3Pool.withdraw, (address(USDC), amount, to)));
    }

    function _buyWith(uint256 r, uint256 usdcIn, address to) internal view returns (PM.Call memory) {
        return PM.Call(
            address(ROUTER),
            0,
            abi.encodeCall(
                IAeroRouter.exactInputSingle,
                (IAeroRouter.ExactInputSingleParams(address(USDC), STOCKS[r], 10, to, block.timestamp, usdcIn, 0, 0))
            )
        );
    }
}

/// No amount limit: the Rebalance grant at CAP_MAX registers and runs, and a $60,000 top-up into a 50/50 mix of $10,000
/// each goes in a $25,000 slice a stock a day: $50,000 on the first market morning, the $10,000 left on the next.
contract TopUpsNoLimitForkTest is TopUpsForkBase {
    function setUp() public {
        _setUpTopUps();
    }

    function test_no_limit_a_25k_slice_a_stock_a_day() public {
        // Retired: GooseExecutor's $25,000 buys need that much depth in the live pools at the latest block (this suite
        // isn't pinned), so it fails when the market is thin. GooseGuard's top-ups are tested on a pinned block.
        vm.skip(true);
        address a = _investor("a", _list(NVDA, AAPL), _list(10_000e6, 10_000e6), fiftyFifty, 0, 0);
        assertEq(x.permissionOf(a, GooseExecutor.Job.Rebalance).spends[0].allowance, type(uint160).max);
        assertEq(x.permissionOf(a, GooseExecutor.Job.Rebalance).spends[1].allowance, type(uint160).max, "aUSDC too");
        _warpNy(0, 15 hours);
        _topUp(a, 60_000e6);
        assertApproxEqAbs(_topUpsOf(a).today, 60_000e6, 2, "all of it, less Aave's rounding");

        _warpNy(1, 10 hours);
        vm.recordLogs();
        uint256 gas = gasleft();
        _run(_check());
        console.log("two $25,000 buys from savings: run gas", gas - gasleft());
        (uint256 amount,) = _invested(vm.getRecordedLogs());
        assertEq(amount, 50_000e6, "a slice a stock");
        assertApproxEqAbs(_topUpsOf(a).ready, 10_000e6, 4, "the rest waits");

        _warpNy(1, 10 hours);
        vm.recordLogs();
        _run(_check());
        (amount,) = _invested(vm.getRecordedLogs());
        assertApproxEqAbs(amount, 10_000e6, 2, "the next market day");
        _assertHoldsNothing();
        _holdsNoStock();
    }
}

/// The costliest top-up, measured cold: the position and the count are built in setUp, which forge runs as its own
/// transaction. A seven-stock mix at $1,000 each takes a $7,000 top-up: a withdraw from savings and seven buys, whose
/// batch must fit RebalanceJob's cap, inside MAX_RUN_GAS and Base's 5M.
contract TopUpsGasForkTest is TopUpsForkBase {
    address a;

    function setUp() public {
        _setUpTopUps();
        uint256[] memory stocks = new uint256[](7);
        uint256[] memory usd = new uint256[](7);
        uint16[7] memory weights;
        for (uint256 r; r < 7; ++r) {
            stocks[r] = r;
            weights[r] = r < 6 ? 1_430 : 1_420;
            usd[r] = 1_000e6 * uint256(weights[r]) / 1_430;
        }
        a = _investor("cold", stocks, usd, weights, 1_000e6, 0);
        _warpNy(0, 15 hours);
        _topUp(a, 7_000e6);
        _warpNy(1, 10 hours);
    }

    function test_a_cold_check_with_seven_buys() public view {
        uint256 before = gasleft();
        address[] memory work = _check();
        console.log("top-ups into seven stocks, cold check gas", before - gasleft());
        assertEq(work.length, 1);
    }

    function test_a_cold_withdraw_and_seven_buys_fit() public {
        vm.recordLogs();
        uint256 before = gasleft();
        _run(_one(a));
        console.log("withdraw and seven buys, cold run gas", before - gasleft());
        (uint256 amount, uint256[7] memory bought) = _invested(vm.getRecordedLogs());
        assertGt(amount, 6_900e6, "not deferred, not skipped");
        for (uint256 r; r < 7; ++r) {
            assertGt(bought[r], 0, "seven buys");
        }
    }

    /// The manager's batch alone, cold: what REBALANCE_GAS caps.
    function test_the_batch_alone() public {
        PM.Permission memory p = x.permissionOf(a, GooseExecutor.Job.Rebalance);
        RebalanceBook memory book;
        uint256 mix = x.mixes(a);
        for (uint256 r; r < 7; ++r) {
            book.stocks[r].weight = RebalanceRules.weight(mix, r);
            book.stocks[r].shares = IERC20(STOCKS[r]).balanceOf(a);
            book.stocks[r].price = _price(r);
        }
        RebalanceLimits memory l;
        (l.bandBps, l.bandMaxBps, l.poolGapBps, l.floorBps, l.minTrade, l.maxSlice) = x.rebalanceLimits();
        Trade[] memory t = RebalanceRules.invest(book, _topUpsOf(a).today, l);
        PM.Call[] memory calls = new PM.Call[](t.length + 2);
        uint256 invest;
        for (uint256 i; i < t.length; ++i) {
            invest += t[i].amountIn;
            calls[i + 2] = PM.Call(
                address(ROUTER),
                0,
                abi.encodeCall(
                    IAeroRouter.exactInputSingle,
                    (IAeroRouter.ExactInputSingleParams(
                            address(USDC), STOCKS[t[i].reserveId], 10, a, block.timestamp, t[i].amountIn, t[i].minOut, 0
                        ))
                )
            );
        }
        calls[0] = PM.Call(address(POOL), 0, abi.encodeCall(IAaveV3Pool.withdraw, (address(USDC), invest, a)));
        calls[1] = PM.Call(address(USDC), 0, abi.encodeCall(IERC20.approve, (address(ROUTER), invest)));
        vm.prank(address(x));
        uint256 before = gasleft();
        MANAGER.executeBatch(p, calls);
        uint256 used = before - gasleft();
        console.log("withdraw and seven buys, the manager's batch, cold", used);
        assertEq(t.length, 7);
        assertLt(used, RebalanceJob.REBALANCE_GAS, "within REBALANCE_GAS");
    }
}
