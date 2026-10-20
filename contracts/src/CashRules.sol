// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Protect's health factors, all WAD (1e18 = 1.0). GooseExecutor holds them within hard bounds (D18). `stressDrop` and
/// `stressFloorHf` are the app's weekend card's numbers: the executor moves nothing on them, and keeps them here so the
/// card reads the live ones.
struct Thresholds {
    uint64 triggerHf;
    uint64 targetHf;
    uint64 stressDrop;
    uint64 stressFloorHf;
}

/// Amounts in USDC units (1e6 = $1), the weekend heads-up card's window before a freeze in seconds (the app's; the
/// executor moves nothing in it), and Save's daily number.
struct Amounts {
    uint64 minRepay;
    uint64 minSave;
    uint64 keepBack;
    uint32 weekendWindow;
    uint8 maxSavesPerDay;
}

/// What Protect decides for one account. Only `Act` repays: below Protect's line, or during a rescue below the target.
/// (Executors deployed before 2026-10-15 also had a 6, WeekendShield, which repaid outside Act.)
enum ProtectCase {
    NoDebt,
    Healthy,
    NoSavings,
    NoCap,
    TooSmall,
    Act
}

/// What Save decides for one account. Only `Save` moves money.
enum SaveCase {
    TooSmall,
    NoCap,
    Rate,
    Save
}

/// Top-ups go into my mix (GooseExecutor.topUps): the account's own switch and Keep, and what Save counted that
/// Rebalance hasn't put in yet. USDC units; every amount is under USDC's total supply, far below 2^56. Two slots.
struct TopUps {
    bool on; // the account's own switch (GooseExecutor.setTopUps)
    uint32 day; // the New York day `today` was counted on
    uint48 keep; // Keep $X as cash: savings up to it never go into the mix
    uint56 ready; // counted on an earlier day: goes in at the next market morning's check
    uint56 today; // counted on `day`: never goes in the day it arrived
    uint56 mark; // savings when the executor last looked: a fall under it comes out of what's waiting
    uint256 own; // wallet cash that isn't a top-up (the agents' change, the wallet when switched on): Save leaves it out
}

/// @title CashRules
/// @notice The Cash Agent's rules, ported line for line from Leo's `planGuardian` and our `planSave`
///         (lib/guardian/plan.ts). The TypeScript versions stay the reference: test/CashRules.t.sol runs both on the
///         same vectors (scripts/agent-vectors.ts).
/// @dev Integer maths only. Units: Aave Value (1e26 = $1), WAD (1e18), RAY (1e27), USDC units (1e6 = $1 = 1e20 Value).
library CashRules {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant VALUE_PER_USDC_UNIT = 1e20;

    // Hard bounds (D18). Nothing can change them.
    /// Protect's line (Adrian, 2026-10-19): Protect acts only below 1.03, as late as is safe before Aave's line at 1.0
    /// (a 2.9% fall). Act (1.10) is a warning only. The line is pinned, and no threshold change can move it.
    uint64 internal constant TRIGGER_HF = 1.03e18;
    uint64 internal constant TARGET_GAP_MIN = 0.05e18;
    /// A rescue brings the credit back to Watch, never past it: the target stays under the Safe line (1.50).
    uint64 internal constant TARGET_HF_MAX = 1.4e18;
    /// The most a move may land above the target, for rounding: Protect is limited by what it does (back to the
    /// target), not by how much it moves (Adrian, 2026-10-19: no amount limit, as at DeFi Saver).
    uint64 internal constant OVERSHOOT_HF = 0.01e18;
    /// A rescue counts as done within this of the target: Aave's rounding can leave a repay or a sale a hair short.
    uint64 internal constant RESCUE_DONE_GAP = 0.001e18;
    uint64 internal constant STRESS_DROP_MIN = 0.05e18;
    uint64 internal constant STRESS_DROP_MAX = 0.3e18;
    /// The weekend card warns about Aave's own line (1.0).
    uint64 internal constant STRESS_FLOOR_HF_MIN = 1e18;
    uint64 internal constant MIN_REPAY_MIN = 0.05e6;
    uint64 internal constant MIN_REPAY_MAX = 50e6;
    uint64 internal constant MIN_SAVE_MIN = 0.1e6;
    uint64 internal constant MIN_SAVE_MAX = 100e6;
    uint64 internal constant KEEP_BACK_MAX = 5e6;
    uint32 internal constant WEEKEND_WINDOW_MIN = 1 hours;
    uint32 internal constant WEEKEND_WINDOW_MAX = 12 hours;
    uint8 internal constant MAX_SAVES_MIN = 1;
    uint8 internal constant MAX_SAVES_MAX = 24;

    function thresholdsOk(Thresholds memory t) internal pure returns (bool) {
        return t.triggerHf == TRIGGER_HF && t.targetHf >= TRIGGER_HF + TARGET_GAP_MIN && t.targetHf <= TARGET_HF_MAX
            && t.stressDrop >= STRESS_DROP_MIN && t.stressDrop <= STRESS_DROP_MAX
            && t.stressFloorHf >= STRESS_FLOOR_HF_MIN && t.stressFloorHf <= t.triggerHf;
    }

    function amountsOk(Amounts memory a) internal pure returns (bool) {
        return a.minRepay >= MIN_REPAY_MIN && a.minRepay <= MIN_REPAY_MAX && a.minSave >= MIN_SAVE_MIN
            && a.minSave <= MIN_SAVE_MAX && a.keepBack <= KEEP_BACK_MAX && a.weekendWindow >= WEEKEND_WINDOW_MIN
            && a.weekendWindow <= WEEKEND_WINDOW_MAX && a.maxSavesPerDay >= MAX_SAVES_MIN
            && a.maxSavesPerDay <= MAX_SAVES_MAX;
    }

    /// Protect, first half (plan.ts `planGuardian`): how much debt, in Value, should go. Needs only the account data,
    /// so the executor reads savings and limits only when there is something to repay. Only below Protect's line, or
    /// below the target while a rescue is under way (`rescuing`): savings first, then selling, back to the target.
    /// @param collateral `totalCollateralValue`; @param avgCf `avgCollateralFactor`; @param debtRay `totalDebtValueRay`.
    /// @return why `NoDebt`, `Healthy` or `Act`. @return need Value to repay. @return debt Value owed.
    function protectNeed(uint256 collateral, uint256 avgCf, uint256 debtRay, Thresholds memory t, bool rescuing)
        internal
        pure
        returns (ProtectCase why, uint256 need, uint256 debt)
    {
        if (debtRay == 0) return (ProtectCase.NoDebt, 0, 0);
        uint256 power = collateral * avgCf / WAD;
        debt = _ceilDiv(debtRay, RAY); // rounds up, like summarize() (lib/aave/math.ts:22)
        if (power * WAD / debt >= (rescuing ? t.targetHf : t.triggerHf)) return (ProtectCase.Healthy, 0, debt);
        need = _sub(debt, power * WAD / t.targetHf);
        if (need == 0) return (ProtectCase.Healthy, 0, debt);
        why = ProtectCase.Act;
    }

    /// Protect, second half (plan.ts `planGuardian`): the repay in USDC units, within savings and what's left of
    /// today's limit. `why` is the first half's `Act`, returned unchanged when there is a repay.
    function protectAmount(
        ProtectCase why,
        uint256 need,
        uint256 debt,
        uint256 savings,
        uint256 capLeft,
        uint256 minRepay
    ) internal pure returns (ProtectCase, uint256 amount) {
        if (savings == 0) return (ProtectCase.NoSavings, 0);
        if (capLeft == 0) return (ProtectCase.NoCap, 0);
        amount = _ceilDiv(_min(need, debt), VALUE_PER_USDC_UNIT);
        amount = _min(_min(amount, savings), capLeft);
        if (amount < minRepay) return (ProtectCase.TooSmall, 0);
        return (why, amount);
    }

    /// Save (planSave): wallet USDC above the keep-back goes into savings, within today's limit and the daily number
    /// of saves. Never leaves the wallet below the keep-back.
    function planSave(uint256 cash, uint256 capLeft, uint256 savesToday, Amounts memory a)
        internal
        pure
        returns (SaveCase, uint256 amount)
    {
        uint256 idle = _sub(cash, a.keepBack);
        if (idle < a.minSave) return (SaveCase.TooSmall, 0);
        if (capLeft == 0) return (SaveCase.NoCap, 0);
        if (savesToday >= a.maxSavesPerDay) return (SaveCase.Rate, 0);
        amount = _min(idle, capLeft);
        if (amount < a.minSave) return (SaveCase.TooSmall, 0);
        return (SaveCase.Save, amount);
    }

    // ================================================================== top-ups (lib/agents/rules/topUps.ts)

    /// Save's count: `saved` went from the wallet into savings, which held `before` and now hold `savings`. The agents'
    /// own change in it is left out (P1); the rest is a top-up, counted today after any fall since the executor last
    /// looked (P4) and within savings above Keep, so it fills Keep first. Returns what was counted.
    function topUpCounted(TopUps memory t, uint256 day, uint256 before, uint256 saved, uint256 savings)
        internal
        pure
        returns (uint256 counted)
    {
        roll(t, day);
        fall(t, before);
        uint256 mine = _min(saved, t.own);
        t.own -= mine;
        uint256 waiting = uint256(t.ready) + t.today;
        t.today += uint56(saved - mine);
        clamp(t, savings);
        t.mark = uint56(savings);
        counted = _sub(uint256(t.ready) + t.today, waiting);
    }

    /// What Rebalance may put into the mix at today's check, with `savings` now: what was counted on an earlier New York
    /// day, less any fall since the executor last looked, within savings above Keep.
    function topUpsReady(TopUps memory t, uint256 day, uint256 savings) internal pure returns (uint256) {
        roll(t, day);
        fall(t, savings);
        clamp(t, savings);
        return t.ready;
    }

    /// After `invest` went from savings into the mix, savings hold `savings`: it comes out of what's ready, and the mark
    /// moves to the savings after, so the invest itself isn't read as a fall.
    function topUpInvested(TopUps memory t, uint256 invest, uint256 savings) internal pure {
        t.ready -= uint56(invest);
        clamp(t, savings);
        t.mark = uint56(savings);
    }

    /// Today's count joins what's ready once its New York day is over.
    function roll(TopUps memory t, uint256 day) internal pure {
        if (t.day == day) return;
        t.ready += t.today;
        t.today = 0;
        t.day = uint32(day);
    }

    /// P4: a fall in savings since the executor last looked comes out of what's waiting, what's ready first. Rises never
    /// add to it. The mark moves to `savings` either way.
    function fall(TopUps memory t, uint256 savings) internal pure {
        uint256 f = _sub(t.mark, savings);
        uint256 r = _min(f, t.ready);
        t.ready -= uint56(r);
        t.today -= uint56(_min(f - r, t.today));
        t.mark = uint56(savings);
    }

    /// What's waiting is never more than savings above Keep, so putting it all in leaves Keep as cash. Today's count is
    /// trimmed first.
    function clamp(TopUps memory t, uint256 savings) internal pure {
        uint256 room = _sub(savings, t.keep);
        if (t.ready > room) t.ready = uint56(room);
        if (t.today > room - t.ready) t.today = uint56(room - t.ready);
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    /// a − b, floored at 0.
    function _sub(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
