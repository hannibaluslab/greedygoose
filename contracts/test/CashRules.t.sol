// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Amounts, CashRules, ProtectCase, SaveCase, Thresholds, TopUps} from "../src/CashRules.sol";
import {Vectors} from "./Vectors.sol";

/// The Solidity rules against the TypeScript reference (planProtect and planSave in lib/agents/rules/protect.ts, and
/// the top-ups' counts in lib/agents/rules/topUps.ts), on the vectors scripts/agent-vectors.ts exported, plus
/// properties that hold for any input.
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

    // ================================================================== top-ups (P1, P4, Keep, the day)

    /// What the TypeScript rule decided, per vector (topups.json).
    struct TopUpsWant {
        uint256[] counted;
        uint256[] countReady;
        uint256[] countToday;
        uint256[] countMark;
        uint256[] countOwn;
        uint256[] ready;
        uint256[] investReady;
        uint256[] investToday;
        uint256[] investMark;
    }

    /// Save's count, the check's ready amount and the state after an invest, against topUpCounted, topUpsReady and
    /// topUpInvested on 1,000 vectors.
    function test_top_ups_agree_with_the_typescript_rule() public view {
        string memory json = vm.readFile("test/vectors/topups.json");
        TopUpsWant memory w;
        w.counted = vm.parseJsonUintArray(json, ".counted");
        w.countReady = vm.parseJsonUintArray(json, ".countReady");
        w.countToday = vm.parseJsonUintArray(json, ".countToday");
        w.countMark = vm.parseJsonUintArray(json, ".countMark");
        w.countOwn = vm.parseJsonUintArray(json, ".countOwn");
        w.ready = vm.parseJsonUintArray(json, ".ready");
        w.investReady = vm.parseJsonUintArray(json, ".investReady");
        w.investToday = vm.parseJsonUintArray(json, ".investToday");
        w.investMark = vm.parseJsonUintArray(json, ".investMark");
        assertEq(w.counted.length, 1000);
        uint256 some;
        uint256 trimmed;
        for (uint256 i; i < w.counted.length; ++i) {
            Vectors.TopUpsCase memory v = Vectors.topUpsInput(i);
            _checkTopUps(i, v, w);
            if (w.counted[i] > 0) ++some;
            if (w.counted[i] > 0 && w.counted[i] < v.saved) ++trimmed;
        }
        assertGt(some, 400, "most saves count");
        assertGt(trimmed, 100, "Keep, the agents' change and falls take their share");
    }

    function _checkTopUps(uint256 i, Vectors.TopUpsCase memory v, TopUpsWant memory w) internal pure {
        string memory at = string.concat("vector ", vm.toString(i));
        TopUps memory t = v.t;
        assertEq(CashRules.topUpCounted(t, v.countDay, v.before, v.saved, v.savings), w.counted[i], at);
        assertEq(t.ready, w.countReady[i], at);
        assertEq(t.today, w.countToday[i], at);
        assertEq(t.mark, w.countMark[i], at);
        assertEq(t.own, w.countOwn[i], at);
        uint256 got = CashRules.topUpsReady(t, v.checkDay, v.checkSavings);
        assertEq(got, w.ready[i], at);
        uint256 invest = got * v.investPct / 100;
        uint256 left = v.checkSavings > invest + v.rounding ? v.checkSavings - invest - v.rounding : 0;
        CashRules.topUpInvested(t, invest, left);
        assertEq(t.ready, w.investReady[i], at);
        assertEq(t.today, w.investToday[i], at);
        assertEq(t.mark, w.investMark[i], at);
    }

    /// Keep fills first: $300 in savings, Keep $500, a $400 top-up counts $200. Then a $1,000 one counts it all.
    function test_a_top_up_fills_keep_first() public pure {
        TopUps memory t = _topUps(500e6);
        assertEq(CashRules.topUpCounted(t, DAY, 300e6, 400e6, 700e6), 200e6);
        assertEq(CashRules.topUpCounted(t, DAY, 700e6, 1_000e6, 1_700e6), 1_000e6);
        assertEq(t.today, 1_200e6);
        t = _topUps(0);
        assertEq(CashRules.topUpCounted(t, DAY, 0, 400e6, 400e6), 400e6, "Keep $0: all of it");
    }

    /// P1: the agents' own change in what Save puts away is left out exactly, then counting goes on.
    function test_the_agents_own_change_is_never_a_top_up() public pure {
        TopUps memory t = _topUps(0);
        t.own = 5e6;
        assertEq(CashRules.topUpCounted(t, DAY, 1_000e6, 3e6, 1_003e6), 0, "Protect's $3 of change");
        assertEq(t.own, 2e6);
        assertEq(CashRules.topUpCounted(t, DAY, 1_003e6, 300e6, 1_303e6), 298e6, "the rest of the change, then $298");
        assertEq(t.own, 0);
    }

    /// The day guard: what's counted today isn't ready until the next New York day.
    function test_a_top_up_never_goes_in_the_day_it_arrived() public pure {
        TopUps memory t = _topUps(0);
        CashRules.topUpCounted(t, DAY, 0, 300e6, 300e6);
        TopUps memory same = _copy(t);
        assertEq(CashRules.topUpsReady(same, DAY, 300e6), 0, "the same day: waits");
        assertEq(CashRules.topUpsReady(t, DAY + 3, 300e6), 300e6, "the next market day (Friday to Monday too)");
    }

    /// P4: a fall in savings after a count comes out of what's waiting, what's ready first; a rise never adds to it.
    function test_a_fall_comes_out_of_what_is_waiting_and_a_rise_never_adds() public pure {
        TopUps memory t = _topUps(0);
        CashRules.topUpCounted(t, DAY, 1_000e6, 300e6, 1_300e6); // ready tomorrow
        CashRules.topUpCounted(t, DAY + 1, 1_300e6, 200e6, 1_500e6); // today
        assertEq(abi.encode(t.ready, t.today), abi.encode(uint56(300e6), uint56(200e6)));
        TopUps memory risen = _copy(t);
        assertEq(CashRules.topUpsReady(risen, DAY + 1, 9_000e6), 300e6, "a rise (a sale into savings) adds nothing");
        assertEq(CashRules.topUpsReady(t, DAY + 1, 1_100e6), 0, "a $400 fall: the $300 ready first");
        assertEq(t.today, 100e6, "then $100 of today's");
        assertEq(t.mark, 1_100e6);
    }

    /// The P4 example: top up $300, spend $300 (seen by Save's next look), then a sale's $300 lands in savings: nothing
    /// of the sale goes in.
    function test_spent_then_refilled_by_a_sale_invests_nothing() public pure {
        TopUps memory t = _topUps(0);
        CashRules.topUpCounted(t, DAY, 1_000e6, 300e6, 1_300e6);
        CashRules.topUpCounted(t, DAY, 1_000e6, 5e6, 1_005e6); // the $300 spent, then $5 arrives
        assertEq(uint256(t.today), 5e6);
        assertEq(CashRules.topUpsReady(t, DAY + 1, 1_305e6), 5e6, "the sale's $300 isn't a top-up");
    }

    /// After an invest, what's ready drops by it and the invest's own fall isn't read as one.
    function test_an_invest_comes_out_of_what_is_ready() public pure {
        TopUps memory t = _topUps(500e6);
        CashRules.topUpCounted(t, DAY, 500e6, 1_000e6, 1_500e6);
        assertEq(CashRules.topUpsReady(t, DAY + 1, 1_500e6), 1_000e6);
        CashRules.topUpInvested(t, 700e6, 800e6 - 2); // Aave's rounding
        assertEq(t.ready, 300e6 - 2, "within savings above Keep");
        assertEq(CashRules.topUpsReady(t, DAY + 1, 800e6 - 2), 300e6 - 2, "no fall read from the invest");
    }

    /// Up to $1B a number: USDC's whole supply is under 2^56 units, so the counts never pass their 56 bits.
    function testFuzz_what_waits_never_passes_savings_above_keep(
        uint256 keep,
        uint256 ready,
        uint256 today,
        uint256 mark,
        uint256 before,
        uint256 saved,
        uint256 checkSavings
    ) public pure {
        TopUps memory t = TopUps(
            true,
            uint32(DAY),
            uint48(bound(keep, 0, 1e15)),
            uint56(bound(ready, 0, 1e15)),
            uint56(bound(today, 0, 1e15)),
            uint56(bound(mark, 0, 1e15)),
            0
        );
        before = bound(before, 0, 1e15);
        saved = bound(saved, 0, 1e15);
        checkSavings = bound(checkSavings, 0, 1e15);
        keep = t.keep;
        uint256 savings = before + saved;
        uint256 counted = CashRules.topUpCounted(t, DAY, before, saved, savings);
        assertLe(counted, saved, "never more than Save put away");
        assertLe(uint256(t.ready) + t.today, savings > keep ? savings - keep : 0, "within savings above Keep");
        uint256 got = CashRules.topUpsReady(t, DAY + 1, checkSavings);
        assertLe(got, checkSavings > keep ? checkSavings - keep : 0, "ready within savings above Keep");
        assertLe(uint256(t.ready) + t.today, checkSavings > keep ? checkSavings - keep : 0);
    }

    uint256 constant DAY = 20_400;

    function _topUps(uint48 keep) internal pure returns (TopUps memory t) {
        (t.on, t.day, t.keep) = (true, uint32(DAY), keep);
    }

    function _copy(TopUps memory t) internal pure returns (TopUps memory) {
        return TopUps(t.on, t.day, t.keep, t.ready, t.today, t.mark, t.own);
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
