// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GuardForkBase} from "./GuardForkBase.sol";
import {ISpoke} from "./IJustaPermissionManager.sol";

/// Build step 7 (spec-final-v2.md §14, items 5-7): Aave's own edges on a Base fork.
///
/// H6, a collateral factor changed under a new dynamic config key: the Spoke's AccessManager (its `authority()`, an
/// AccessManagerEnumerable) names the role allowed to call `addDynamicReserveConfig`, and that role's one member is
/// pranked to add the config, exactly as Aave governance would (GuardForkBase._setCollateralFactor). No storage is
/// written by hand. Stored positions keep their key until a withdraw, a borrow or `updateUserDynamicConfig` moves them
/// to the latest one; `getUserAccountData` (the Guard's reading, and liquidation's) reads the stored key.
///
/// Dust (decision 6, DUST = $1): a full payoff is allowed only when power / (T + 0.01) ≤ $1, tested on both sides. H3:
/// dust savings someone supplies for the user don't block Protect: a repay of it and a sale run in one perform.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardAaveEdgesForkTest -vv
contract GooseGuardAaveEdgesForkTest is GuardForkBase {
    function setUp() public {
        _setUpGuard();
    }

    /// An NVDAc-backed account drawn to `hf`, the credit's cash moved out of the wallet, Protect and Protect · sell on.
    function _owing(string memory name, uint256 usd, uint256 hf) internal returns (address a) {
        a = _newJawAccount(name);
        _backUsd(a, NVDA, usd);
        _drawTo(a, hf);
        deal(address(USDC), a, 0);
        _protectOn(a);
        _sellOn(a);
    }

    /// Health on the latest config, as a withdraw would see it: what `updateUserDynamicConfig` would make stored.
    function _latestHf(address a) internal returns (uint256 hf) {
        uint256 snap = vm.snapshotState();
        vm.prank(a);
        SPOKE.updateUserDynamicConfig(a);
        hf = _hf(a);
        vm.revertToState(snap);
    }

    /// Sale legs of NVDAc that climb from health `hf` (on collateral factor `cf`, WAD) toward `total` shares, each slice
    /// small enough that its withdraw keeps health above 1: slice ≤ 0.9 × (hf − 1) × debt / cf.
    function _climb(address a, uint256 hf, uint256 cf, uint256 total) internal view returns (uint256[] memory legs) {
        uint256 debt = _debt(a); // USDC units
        uint256 px = _price(NVDA);
        uint256[] memory tmp = new uint256[](16);
        uint256 n;
        uint256 sold;
        while (sold < total && n < 16) {
            uint256 value = (hf - 1e18) * debt / cf * 9 / 10; // USDC units
            uint256 shares = value * 1e10 / px;
            if (shares > total - sold) shares = total - sold;
            tmp[n++] = _leg(NVDA, shares);
            sold += shares;
            uint256 v = shares * px / 1e10;
            // hf' = (hf·debt − cf·v) / (debt − 0.97·v)
            hf = (hf * debt - cf * v) / (debt - v * 97 / 100);
            debt -= v * 97 / 100;
        }
        legs = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            legs[i] = tmp[i];
        }
    }

    // ================================================================== H6: a factor cut

    /// NVDAc's factor is cut from 70% to 69.5% under a new key. The stored reading (1.025, under the line) lets Protect
    /// act, but any withdraw moves the account to the cut (≈ 1.018). A tiny "refresh" sale leaves it weaker on Aave's
    /// own reading than before: refused (HealthLower). A sale sized to climb past the old reading runs, and so does a
    /// cash repay (no withdraw, no refresh).
    function test_h6_after_a_factor_cut_a_tiny_sale_is_refused_and_a_proper_one_runs() public {
        address a = _owing("cut", 4_000e6, 1.025e18);
        uint16 cf = _latestConfig(NVDA).collateralFactor;
        _setCollateralFactor(NVDA, cf - 50);
        uint256 stored = _hf(a);
        uint256 latest = _latestHf(a);
        console2.log("health stored / on the cut config", stored, latest);
        assertLt(latest, stored, "the cut didn't lower the latest reading");

        Holdings memory h = _holdings(a);
        assertEq(_send(a, SELL, _a1(_leg(NVDA, 0.01e8))), GooseGuard.HealthLower.selector, "the tiny sale ran");
        _assertUnchanged(a, h);

        uint256 snap = vm.snapshotState();
        uint256[] memory legs = _climb(a, latest, uint256(cf - 50) * 1e14, _slice(a, NVDA, 800));
        console2.log("proper sale: legs", legs.length);
        assertEq(_send(a, SELL, legs), bytes4(0), "the properly sized sale was refused");
        console2.log("health after the proper sale", _hf(a));
        assertGe(_hf(a), stored, "a sale left it weaker");

        vm.revertToState(snap);
        deal(address(USDC), a, 1_000e6);
        assertEq(_send(a, REPAY, _a2(_repayTo(a, 1.10e18), 0)), bytes4(0), "the cash repay was refused");
        assertApproxEqAbs(_hf(a), 1.10e18, 0.002e18, "the repay didn't land on the stored reading");
    }

    // ================================================================== H6: a factor raise

    /// NVDAc's factor is raised from 70% to 70.5%. A sale the Planner sized on the stored reading to land at 1.128
    /// refreshes the config on its first withdraw and lands past 1.13: refused (Overshoot). REFRESH moves the account
    /// to the raise on its own (ConfigRefreshed, health up, still under the line), and the sale sized on the new
    /// reading then runs.
    function test_h6_after_a_factor_raise_refresh_unblocks_the_sale() public {
        address a = _owing("raise", 4_000e6, 1.02e18);
        uint16 cf = _latestConfig(NVDA).collateralFactor;
        _setCollateralFactor(NVDA, cf + 50);
        uint256 stored = _hf(a);
        uint256 latest = _latestHf(a);
        console2.log("health stored / on the raised config", stored, latest);
        assertLt(latest, 1.03e18, "the raise lifts it past the line: pick a smaller one");

        // Sized on the stored reading (factor 70%) to land at 1.128: V = (T·D − P) / (T × 0.97 − cf).
        uint256 cfOld = uint256(cf) * 1e14;
        uint256 debt = _debt(a);
        uint256 value = (1.128e18 - stored) * debt / (1.128e18 * 97 / 100 - cfOld);
        uint256 total = _sharesFor(NVDA, value);
        uint256[] memory legs = _climb(a, latest, uint256(cf + 50) * 1e14, total);
        Holdings memory h = _holdings(a);
        assertEq(_send(a, SELL, legs), GooseGuard.Overshoot.selector, "the sale sized on the old reading ran");
        _assertUnchanged(a, h);

        (, Vm.Log[] memory logs) = _perform(_one(a, REFRESH, _a0()));
        assertEq(_reason(logs, a), bytes4(0), "the refresh was refused");
        assertTrue(_logged(logs, GooseGuard.ConfigRefreshed.selector, a), "no ConfigRefreshed");
        assertEq(_hf(a), latest, "the refresh didn't apply the raise");
        assertGt(_hf(a), stored, "health didn't rise");
        assertEq(_send(a, REFRESH, _a0()), GooseGuard.NoGain.selector, "a second refresh wasn't refused");

        // Re-planned on the new reading to land at 1.11.
        debt = _debt(a);
        value = (1.11e18 - latest) * debt / (1.11e18 * 97 / 100 - uint256(cf + 50) * 1e14);
        legs = _climb(a, latest, uint256(cf + 50) * 1e14, _sharesFor(NVDA, value));
        assertEq(_send(a, SELL, legs), bytes4(0), "the sale on the new reading was refused");
        assertGe(_hf(a), 1.10e18, "short of 1.10");
        assertLe(_hf(a), 1.13e18, "past the target plus 0.01");
    }

    // ================================================================== dust and payoff

    /// A tiny account whose power at the ceiling is just under $1: paying it all off from savings runs. One just over
    /// $1: refused (PaidOff), and a partial repay to the target runs instead, so a small account always has a move.
    function test_a_full_payoff_runs_just_under_dust_and_is_refused_just_over() public {
        uint256 cf = uint256(_latestConfig(NVDA).collateralFactor) * 1e14;
        // power / 1.13 = $0.99 and $1.01: collateral = 0.99 × 1.13 / cf dollars.
        uint256[2] memory atCeiling = [uint256(0.99e6), 1.01e6];
        for (uint256 i; i < 2; ++i) {
            address a = _newJawAccount(i == 0 ? "under" : "over");
            _backWith(a, NVDA, _sharesFor(NVDA, atCeiling[i] * 1.13e18 / cf));
            _drawTo(a, 1.02e18);
            _save(a, _bal(address(USDC), a));
            deal(address(USDC), a, 0);
            _protectOn(a);
            ISpoke.UserAccountData memory d = SPOKE.getUserAccountData(a);
            uint256 power = d.totalCollateralValue * d.avgCollateralFactor / 1e18;
            bool ok = power * 1e18 / 1.13e18 <= 1e26;
            console2.log("left at the ceiling (1e26 = $1), debt", power * 1e18 / 1.13e18, _debt(a));
            assertEq(ok, i == 0, "the position isn't on the side of $1 this case needs");
            // Top savings up to cover the debt (the credit's cash is a crumb short of it).
            deal(address(USDC), a, 1e6);
            _save(a, 1e6);
            uint256 debt = _debt(a);
            bytes4 reason = _send(a, REPAY, _a2(0, debt + 1e6));
            if (i == 0) {
                assertEq(reason, bytes4(0), "a payoff under dust was refused");
                assertEq(_debt(a), 0, "not paid off");
            } else {
                assertEq(reason, GooseGuard.PaidOff.selector, "a payoff over dust wasn't refused");
                assertEq(_send(a, REPAY, _a2(0, _repayTo(a, 1.10e18))), bytes4(0), "the partial repay was refused");
                assertGt(_debt(a), 0);
            }
        }
    }

    /// A repay may leave less than DUST owed (step0-facts.md, fact 1: Aave has no repay minimum): a $1.20 position
    /// repaid to the target leaves cents of credit, and Protect still acts on it.
    function test_a_repay_may_leave_less_than_dust_owed() public {
        address a = _owing("crumb", 1.2e6, 1.02e18);
        deal(address(USDC), a, 10e6);
        uint256 repay = _repayTo(a, 1.12e18);
        assertEq(_send(a, REPAY, _a2(repay, 0)), bytes4(0), "the repay leaving cents was refused");
        console2.log("credit left (USDC units)", _debt(a));
        assertGt(_debt(a), 0);
    }

    // ================================================================== H3: dust savings

    /// Someone supplies 0.05 USDC to Aave V3 on the user's behalf. The account has no wallet cash, so the Planner sends
    /// a repay of the 0.05 aUSDC and a sale in one perform: both run, neither blocks the other.
    function test_h3_dust_savings_and_a_sale_run_in_one_perform() public {
        address a = _owing("h3", 4_000e6, 1.025e18);
        address stranger = makeAddr("stranger");
        deal(address(USDC), stranger, 0.05e6);
        vm.startPrank(stranger);
        USDC.approve(address(POOL), 0.05e6);
        POOL.supply(address(USDC), 0.05e6, a, 0);
        vm.stopPrank();
        uint256 dust = _bal(address(AUSDC), a);
        console2.log("dust savings (aUSDC units)", dust);

        GooseGuard.Move[] memory moves = new GooseGuard.Move[](2);
        moves[0] = _move(a, REPAY, _a2(0, dust));
        uint256[] memory legs = new uint256[](2);
        legs[0] = _leg(NVDA, _slice(a, NVDA, 250));
        legs[1] = legs[0];
        moves[1] = _move(a, SELL, legs);
        uint256 debt = _debt(a);
        uint256 hf = _hf(a);
        (uint256 used, Vm.Log[] memory logs) = _perform(abi.encode(moves));
        assertEq(_reasons(logs).length, 0, "a move was refused");
        assertTrue(_logged(logs, GooseGuard.ProtectRepaid.selector, a), "the dust repay didn't run");
        assertTrue(_logged(logs, GooseGuard.ProtectSold.selector, a), "the sale didn't run");
        assertLt(_debt(a), debt);
        assertGt(_hf(a), hf);
        assertLe(_bal(address(AUSDC), a), 1, "dust left in savings");
        console2.log("perform gas", used);
    }
}
