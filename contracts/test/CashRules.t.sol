// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Amounts, CashRules, ProtectCase, SaveCase, Thresholds} from "../src/CashRules.sol";
import {Vectors} from "./Vectors.sol";

/// The Solidity rules against the TypeScript reference (planGuardian and planSave in lib/guardian/plan.ts), on the
/// vectors scripts/agent-vectors.ts exported, plus properties that hold for any input.
contract CashRulesTest is Test {
    uint256 constant CENT = 10_000; // USDC units

    function test_protect_agrees_with_planGuardian() public view {
        string memory json = vm.readFile("test/vectors/protect.json");
        bytes memory kinds = vm.parseJsonBytes(json, ".kinds");
        bytes memory checkKind = vm.parseJsonBytes(json, ".checkKind");
        uint256[] memory amounts = vm.parseJsonUintArray(json, ".amounts");
        assertEq(kinds.length, 1000);
        uint256 repays;
        for (uint256 i; i < kinds.length; ++i) {
            (ProtectCase got, uint256 amount) = _protect(Vectors.protectInput(i));
            ProtectCase want = ProtectCase(uint8(kinds[i]));
            string memory at = string.concat("vector ", vm.toString(i));
            // Within 1e-4 of a threshold float and integer maths may disagree: there only the amount is compared.
            if (checkKind[i] != 0) assertEq(uint8(got), uint8(want), at);
            if (got == ProtectCase.Act && want == ProtectCase.Act) {
                assertApproxEqAbs(amount, amounts[i], CENT, at);
                ++repays;
            }
        }
        assertGt(repays, 250, "repays are well covered");
    }

    function test_save_agrees_with_planSave() public view {
        string memory json = vm.readFile("test/vectors/save.json");
        bytes memory kinds = vm.parseJsonBytes(json, ".kinds");
        uint256[] memory amounts = vm.parseJsonUintArray(json, ".amounts");
        assertEq(kinds.length, 1000);
        for (uint256 i; i < kinds.length; ++i) {
            Vectors.Save memory v = Vectors.saveInput(i);
            (SaveCase got, uint256 amount) = CashRules.planSave(v.cash, v.capLeft, v.savesToday, _amounts(v));
            string memory at = string.concat("vector ", vm.toString(i));
            assertEq(uint8(got), uint8(kinds[i]), at);
            assertEq(amount, amounts[i], at);
        }
    }

    function testFuzz_save_never_sweeps_below_the_keep_back(
        uint256 cash,
        uint256 capLeft,
        uint256 savesToday,
        uint64 keepBack,
        uint64 minSave,
        uint8 maxSaves
    ) public pure {
        cash = bound(cash, 0, 1e15);
        capLeft = bound(capLeft, 0, 1e15);
        Amounts memory a = Amounts(
            0.05e6,
            uint64(bound(minSave, 0.1e6, 100e6)),
            uint64(bound(keepBack, 0, 5e6)),
            6 hours,
            uint8(bound(maxSaves, 1, 24))
        );
        (SaveCase c, uint256 amount) = CashRules.planSave(cash, capLeft, savesToday, a);
        if (c != SaveCase.Save) return assertEq(amount, 0);
        assertLe(amount, cash - a.keepBack, "keep-back stays");
        assertLe(amount, capLeft, "within the limit");
        assertGe(amount, a.minSave, "worth a run");
        assertLt(savesToday, a.maxSavesPerDay, "within the daily number");
    }

    function testFuzz_protect_repays_within_savings_limit_and_debt(
        uint256 collateral,
        uint256 avgCf,
        uint256 debtRay,
        uint256 savings,
        uint256 capLeft
    ) public pure {
        collateral = bound(collateral, 0, 1e35); // up to $1B
        avgCf = bound(avgCf, 0, 1e18);
        debtRay = bound(debtRay, 0, 1e62);
        savings = bound(savings, 0, 1e15);
        capLeft = bound(capLeft, 0, 1e15);
        Thresholds memory t = Thresholds(1.1e18, 1.2e18, 0.15e18, 1.1e18);
        (ProtectCase why, uint256 need, uint256 debt) = CashRules.protectNeed(collateral, avgCf, debtRay, t);
        if (why != ProtectCase.Act) return assertEq(need, 0);
        (ProtectCase c, uint256 amount) = CashRules.protectAmount(why, need, debt, savings, capLeft, 0.05e6);
        if (c != ProtectCase.Act) return assertEq(amount, 0);
        assertEq(uint8(c), uint8(why));
        assertLe(amount, savings, "within savings");
        assertLe(amount, capLeft, "within today's limit");
        assertLe(amount, (debt - 1) / 1e20 + 1, "never more than the debt");
        assertGe(amount, 0.05e6, "worth a run");
    }

    /// An unlimited repay in Act brings the health factor back to the target in Watch (1.2), give or take a unit of
    /// rounding, and no further: Protect brings the credit back to Watch, not to Safe.
    function testFuzz_act_repay_reaches_the_target_in_watch(uint256 collateral, uint256 avgCf, uint256 hf) public pure {
        collateral = bound(collateral, 1e28, 1e35); // $100 to $1B
        avgCf = bound(avgCf, 0.3e18, 0.9e18);
        hf = bound(hf, 1.01e18, 1.09e18);
        uint256 power = collateral * avgCf / 1e18;
        uint256 debtRay = power * 1e18 / hf * 1e27;
        Thresholds memory t = Thresholds(1.1e18, 1.2e18, 0.15e18, 1.1e18);
        (ProtectCase why, uint256 need, uint256 debt) = CashRules.protectNeed(collateral, avgCf, debtRay, t);
        assertEq(uint8(why), uint8(ProtectCase.Act));
        (, uint256 amount) = CashRules.protectAmount(why, need, debt, type(uint128).max, type(uint128).max, 0.05e6);
        uint256 left = debt - amount * 1e20;
        assertGe(power * 1e18 / left, 1.2e18 - 1e9, "back to the target");
        assertLt(power * 1e18 / left, 1.21e18, "and no further: Watch, not Safe");
    }

    /// Watch is fine, and Safe too: from 1.10 up, Protect has nothing to repay, however much savings and limit there are.
    function testFuzz_nothing_in_safe_or_watch(uint256 collateral, uint256 avgCf, uint256 hf) public pure {
        collateral = bound(collateral, 1e28, 1e35);
        avgCf = bound(avgCf, 0.3e18, 0.9e18);
        hf = bound(hf, 1.1e18 + 1e9, 5e18); // a hair over the line, for the rounding of the debt
        uint256 power = collateral * avgCf / 1e18;
        uint256 debtRay = power * 1e18 / hf * 1e27;
        (ProtectCase why, uint256 need,) =
            CashRules.protectNeed(collateral, avgCf, debtRay, Thresholds(1.1e18, 1.2e18, 0.15e18, 1.1e18));
        assertEq(uint8(why), uint8(ProtectCase.Healthy));
        assertEq(need, 0);
    }

    /// Adrian's examples (2026-10-15): $1,300 of backing power against $1,000 owed (1.30, Watch): nothing. Against
    /// $1,238.10 (1.05, Act): repay $154.76, back to 1.20.
    function test_watch_is_fine_and_act_is_repaid_back_to_watch() public pure {
        Thresholds memory t = Thresholds(1.1e18, 1.2e18, 0.15e18, 1.1e18);
        uint256 power = 1_300e26;
        (ProtectCase why,,) = CashRules.protectNeed(power, 1e18, 1_000e26 * 1e27, t);
        assertEq(uint8(why), uint8(ProtectCase.Healthy), "1.30: Watch is fine");
        uint256 debt = power * 1e18 / 1.05e18;
        uint256 need;
        (why, need, debt) = CashRules.protectNeed(power, 1e18, debt * 1e27, t);
        assertEq(uint8(why), uint8(ProtectCase.Act), "1.05: Act");
        (, uint256 amount) = CashRules.protectAmount(why, need, debt, 1_000e6, 1_000e6, 0.05e6);
        assertApproxEqAbs(amount, 154.761905e6, 1, "$154.76");
        assertApproxEqAbs(power * 1e18 / (debt - amount * 1e20), 1.2e18, 1e9, "back to 1.20");
    }

    function _protect(Vectors.Protect memory v) internal pure returns (ProtectCase, uint256) {
        (ProtectCase why, uint256 need, uint256 debt) = CashRules.protectNeed(v.collateral, v.avgCf, v.debtRay, v.t);
        if (why != ProtectCase.Act) return (why, 0);
        return CashRules.protectAmount(why, need, debt, v.savings, v.capLeft, v.minRepay);
    }

    function _amounts(Vectors.Save memory v) internal pure returns (Amounts memory) {
        return Amounts(0.05e6, uint64(v.minSave), uint64(v.keepBack), 6 hours, uint8(v.maxSavesPerDay));
    }
}
