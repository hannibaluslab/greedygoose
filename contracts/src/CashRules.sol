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
