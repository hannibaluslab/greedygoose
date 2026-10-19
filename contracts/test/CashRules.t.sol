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

    /// The hard bounds sit on config/risk.ts (defaults.json carries RISK and CASH_AGENT), so moving a line without the
    /// contract fails here: Protect's line is the app's, under the Act line (a warning only) and above Aave's, and the
    /// target stays in Watch, under the Safe line (Adrian, 2026-10-19).
    function test_the_bounds_sit_on_the_apps_bands() public view {
        string memory json = vm.readFile("test/vectors/defaults.json");
        uint256 actLine = vm.parseJsonUint(json, ".risk.watchMin");
        uint256 safeLine = vm.parseJsonUint(json, ".risk.safeMin");
        assertEq(CashRules.TRIGGER_HF, vm.parseJsonUint(json, ".triggerHf"), "Protect's line is the app's");
        assertLt(CashRules.TRIGGER_HF, actLine, "Protect acts under the Act line, which only warns");
        assertGt(CashRules.TRIGGER_HF, 1e18, "and above Aave's own line");
        assertLt(CashRules.TARGET_HF_MAX, safeLine, "a rescue stops in Watch");
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
        Thresholds memory t = Thresholds(1.03e18, 1.12e18, 0.15e18, 1e18);
        (ProtectCase why, uint256 need, uint256 debt) =
            CashRules.protectNeed(collateral, avgCf, debtRay, t, savings % 2 == 0);
        if (why != ProtectCase.Act) return assertEq(need, 0);
        (ProtectCase c, uint256 amount) = CashRules.protectAmount(why, need, debt, savings, capLeft, 0.05e6);
        if (c != ProtectCase.Act) return assertEq(amount, 0);
        assertEq(uint8(c), uint8(why));
        assertLe(amount, savings, "within savings");
        assertLe(amount, capLeft, "within today's limit");
        assertLe(amount, (debt - 1) / 1e20 + 1, "never more than the debt");
        assertGe(amount, 0.05e6, "worth a run");
    }

    /// An unlimited repay under the line brings the health factor back to the target (1.12), give or take a unit of
    /// rounding, and no further than the executor's overshoot allows: there is no amount limit, the target is the limit.
    function testFuzz_repay_reaches_the_target_and_no_further(uint256 collateral, uint256 avgCf, uint256 hf)
        public
        pure
    {
        collateral = bound(collateral, 1e28, 1e35); // $100 to $1B
        avgCf = bound(avgCf, 0.3e18, 0.9e18);
        hf = bound(hf, 1e18, 1.029e18);
        uint256 power = collateral * avgCf / 1e18;
        uint256 debtRay = power * 1e18 / hf * 1e27;
        Thresholds memory t = Thresholds(1.03e18, 1.12e18, 0.15e18, 1e18);
        (ProtectCase why, uint256 need, uint256 debt) = CashRules.protectNeed(collateral, avgCf, debtRay, t, false);
        assertEq(uint8(why), uint8(ProtectCase.Act));
        (, uint256 amount) = CashRules.protectAmount(why, need, debt, type(uint128).max, type(uint128).max, 0.05e6);
        uint256 left = debt - amount * 1e20;
        assertGe(power * 1e18 / left, 1.12e18 - 1e9, "back to the target");
        assertLe(power * 1e18 / left, 1.12e18 + CashRules.OVERSHOOT_HF, "and within the overshoot");
    }

    /// Above Protect's line it does nothing, Act (a warning) and Watch and Safe alike, however much savings and limit
    /// there are, unless a rescue is under way.
    function testFuzz_nothing_above_the_line(uint256 collateral, uint256 avgCf, uint256 hf) public pure {
        collateral = bound(collateral, 1e28, 1e35);
        avgCf = bound(avgCf, 0.3e18, 0.9e18);
        hf = bound(hf, 1.03e18 + 1e9, 5e18); // a hair over the line, for the rounding of the debt
        uint256 power = collateral * avgCf / 1e18;
        uint256 debtRay = power * 1e18 / hf * 1e27;
        (ProtectCase why, uint256 need,) =
            CashRules.protectNeed(collateral, avgCf, debtRay, Thresholds(1.03e18, 1.12e18, 0.15e18, 1e18), false);
        assertEq(uint8(why), uint8(ProtectCase.Healthy));
        assertEq(need, 0);
    }

    /// During a rescue, Protect goes on under the target and stops at it.
    function testFuzz_a_rescue_goes_on_until_the_target(uint256 collateral, uint256 avgCf, uint256 hf) public pure {
        collateral = bound(collateral, 1e28, 1e35);
        avgCf = bound(avgCf, 0.3e18, 0.9e18);
        hf = bound(hf, 1e18, 2e18);
        uint256 power = collateral * avgCf / 1e18;
        uint256 debtRay = power * 1e18 / hf * 1e27;
        (ProtectCase why,,) =
            CashRules.protectNeed(collateral, avgCf, debtRay, Thresholds(1.03e18, 1.12e18, 0.15e18, 1e18), true);
        if (hf < 1.12e18 - 1e9) assertEq(uint8(why), uint8(ProtectCase.Act), "under the target");
        if (hf > 1.12e18 + 1e9) assertEq(uint8(why), uint8(ProtectCase.Healthy), "at or over it");
    }

    /// Adrian's lines (2026-10-19): $1,300 of backing power against $1,000 owed (1.30, Watch) and against $1,203.70
    /// (1.08, Act): nothing, Act only warns. Against $1,274.51 (1.02, under Protect's line): repay $113.80, back to 1.12.
    function test_act_only_warns_and_under_the_line_is_repaid_back_to_1_12() public pure {
        Thresholds memory t = Thresholds(1.03e18, 1.12e18, 0.15e18, 1e18);
        uint256 power = 1_300e26;
        (ProtectCase why,,) = CashRules.protectNeed(power, 1e18, 1_000e26 * 1e27, t, false);
        assertEq(uint8(why), uint8(ProtectCase.Healthy), "1.30: Watch is fine");
        (why,,) = CashRules.protectNeed(power, 1e18, power * 1e18 / 1.08e18 * 1e27, t, false);
        assertEq(uint8(why), uint8(ProtectCase.Healthy), "1.08: Act only warns");
        uint256 debt = power * 1e18 / 1.02e18;
        uint256 need;
        (why, need, debt) = CashRules.protectNeed(power, 1e18, debt * 1e27, t, false);
        assertEq(uint8(why), uint8(ProtectCase.Act), "1.02: under Protect's line");
        (, uint256 amount) = CashRules.protectAmount(why, need, debt, 1_000e6, type(uint128).max, 0.05e6);
        assertApproxEqAbs(amount, 113.795519e6, 1, "$113.80");
        assertApproxEqAbs(power * 1e18 / (debt - amount * 1e20), 1.12e18, 1e9, "back to 1.12");
    }

    function _protect(Vectors.Protect memory v) internal pure returns (ProtectCase, uint256) {
        (ProtectCase why, uint256 need, uint256 debt) =
            CashRules.protectNeed(v.collateral, v.avgCf, v.debtRay, v.t, v.rescuing);
        if (why != ProtectCase.Act) return (why, 0);
        return CashRules.protectAmount(why, need, debt, v.savings, v.capLeft, v.minRepay);
    }

    function _amounts(Vectors.Save memory v) internal pure returns (Amounts memory) {
        return Amounts(0.05e6, uint64(v.minSave), uint64(v.keepBack), 6 hours, uint8(v.maxSavesPerDay));
    }
}
