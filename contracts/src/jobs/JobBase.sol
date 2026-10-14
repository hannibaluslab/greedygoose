// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IJustanAccount} from "../IProtocols.sol";

/// @title JobBase
/// @notice What the executor and every job share: a permission's status, what is left of its limits, and the stock
///         limits Protect · sell and the Rebalancer pack into a grant's terms.
library JobBase {
    /// Most gas the manager's batch may use for one Cash move (one Protect batch measured at about 404k).
    uint256 internal constant ACCOUNT_GAS = 1_000_000;
    /// aUSDC moves can be off by a unit or two from the amount (Aave's ray rounding).
    uint256 internal constant SAVINGS_ROUNDING = 2;
    /// A stock's limit in a grant is a whole number of these raw units (1e-4 share), so all seven fit in one word: the
    /// grant's `terms` hold the limit of reserve r, in these units, at bits [32r, 32r + 32). 0 = never sell.
    uint256 internal constant STOCK_LIMIT_UNIT = 1e4;
    /// At registration, a stock's limit may be worth at most this many times CAP_MAX at Aave's price (D13).
    uint256 internal constant STOCK_LIMIT_CAPS = 2;
    /// Every stock's Aerodrome Slipstream pool with USDC (checked on a Base fork by DeployExecutor.t.sol).
    int24 internal constant STOCK_TICK_SPACING = 10;
    /// Aave V4's reserve flags: bit 0 is paused (ReserveFlagsMap).
    uint8 internal constant PAUSED = 1;

    /// The permission's on-chain status, past its approval (checked at registration, and never undone).
    function alive(PM manager, PM.Permission memory p) internal view returns (bool, GooseExecutor.OffReason) {
        if (!managerOwns(manager, p.account)) return (false, GooseExecutor.OffReason.NotOwner);
        if (manager.isRevoked(p)) return (false, GooseExecutor.OffReason.Revoked);
        return (true, GooseExecutor.OffReason.Revoked);
    }

    /// The manager runs every batch through the account, so it must be one of its owners (MANAGER-NOTES §6). A failed
    /// or odd answer (an EIP-7702 account that changed its code) counts as no.
    function managerOwns(PM manager, address account) internal view returns (bool owns) {
        bytes memory data = abi.encodeCall(IJustanAccount.isOwnerAddress, (address(manager)));
        assembly ("memory-safe") {
            // Gas-capped, and only the first word of the answer is copied.
            let ok := staticcall(50000, account, add(data, 0x20), mload(data), 0x00, 0x20)
            owns := and(and(ok, eq(returndatasize(), 0x20)), eq(mload(0x00), 1))
        }
    }

    /// Aave's health factor for the account: the largest number when it owes nothing, without the account-data read.
    function health(GooseExecutor.Env memory e, address account) internal view returns (uint256) {
        if (e.spoke.getUserTotalDebt(e.usdcReserveId, account) == 0) return type(uint256).max;
        return e.spoke.getUserAccountData(account).healthFactor;
    }

    /// What's left of the current period's limit on spend `i`.
    function capLeft(PM manager, PM.Permission memory perm, uint256 i) internal view returns (uint256) {
        uint256 cap = perm.spends[i].allowance;
        uint256 spent = manager.getCurrentPeriod(perm, perm.spends[i]).spend;
        return cap > spent ? cap - spent : 0;
    }

    // ================================================================== stock limits in a grant's terms

    /// Reserve r's limit in raw shares, from the grant's terms.
    function stockLimit(uint256 terms, uint256 r) internal pure returns (uint256) {
        return (terms >> (32 * r) & type(uint32).max) * STOCK_LIMIT_UNIT;
    }

    /// The terms a granted permission carries, read from its stock limits, which start at spend `first`; 0 if they
    /// aren't in reserve order, aren't our stocks or aren't whole units. The caller still rebuilds the template and
    /// compares it in full.
    function stockTerms(GooseExecutor.Env memory e, PM.Permission memory p, uint256 first)
        internal
        pure
        returns (uint256 terms)
    {
        if (p.spends.length <= first || p.spends.length > first + 7) return 0;
        uint256 next;
        for (uint256 j = first; j < p.spends.length; ++j) {
            uint256 r = next;
            while (r < 7 && e.stocks[r] != p.spends[j].token) ++r;
            uint256 allowance = p.spends[j].allowance;
            if (r == 7 || allowance % STOCK_LIMIT_UNIT != 0 || allowance / STOCK_LIMIT_UNIT > type(uint32).max) {
                return 0;
            }
            terms |= allowance / STOCK_LIMIT_UNIT << (32 * r);
            next = r + 1;
        }
    }

    /// At least one stock has a limit, and each is worth at most STOCK_LIMIT_CAPS × CAP_MAX at Aave's price now, so a
    /// $5 test deploy (D13) can't be granted a large stock limit.
    function stockTermsOk(GooseExecutor.Env memory e, uint256 terms) internal view returns (bool) {
        if (terms == 0 || terms >> 224 != 0) return false;
        for (uint256 r; r < 7; ++r) {
            uint256 limit = stockLimit(terms, r);
            if (limit == 0) continue;
            if (limit * e.oracle.getReservePrice(r) / 1e10 > STOCK_LIMIT_CAPS * e.capMax) return false;
        }
        return true;
    }

    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
