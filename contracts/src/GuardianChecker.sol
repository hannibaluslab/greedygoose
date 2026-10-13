// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICallChecker} from "./ICallChecker.sol";

/// @title GuardianChecker
/// @notice Argument-level guard for GreedyGoose "Guardian" permissions on JAW's JustaPermissionManager.
///         The manager only whitelists (target, selector); it asks this checker about every matching call.
///         Guardian may do exactly three things, all to the benefit of the account that granted it:
///
///           1. Aave V3 Pool.withdraw(USDC, amount, to)        — only if `to == account`
///           2. USDC.approve(spender, amount)                  — only if `spender == Aave V4 Spoke`
///           3. Aave V4 Spoke.repay(reserveId, amount, who)    — only if `reserveId == USDC reserve` and `who == account`
///
///         Anything else returns false. No ETH value is ever allowed. Calldata must be exactly the
///         ABI-encoded length so no trailing or malformed data can slip through.
///
///         Stateless and immutable: one deployment serves every account (the manager passes `account`).
///         Amount limits are enforced by the permission's USDC spend limit; the manager also resets any
///         approval made during the batch back to zero.
contract GuardianChecker is ICallChecker {
    bytes4 internal constant WITHDRAW = 0x69328dec; // withdraw(address,uint256,address)
    bytes4 internal constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant REPAY = 0xb1e8f8ef; // repay(uint256,uint256,address)

    address public immutable USDC;
    address public immutable AAVE_V3_POOL;
    address public immutable SPOKE;
    uint256 public immutable USDC_RESERVE_ID;

    error ZeroAddress();

    constructor(address usdc, address aaveV3Pool, address spoke, uint256 usdcReserveId) {
        if (usdc == address(0) || aaveV3Pool == address(0) || spoke == address(0)) revert ZeroAddress();
        USDC = usdc;
        AAVE_V3_POOL = aaveV3Pool;
        SPOKE = spoke;
        USDC_RESERVE_ID = usdcReserveId;
    }

    /// @inheritdoc ICallChecker
    function canExecute(bytes32, address account, address, address target, uint256 value, bytes calldata data)
        external
        view
        returns (bool)
    {
        if (value != 0 || data.length < 4) return false;
        bytes4 sel = bytes4(data[:4]);

        if (target == AAVE_V3_POOL && sel == WITHDRAW) {
            if (data.length != 4 + 32 * 3) return false;
            (address asset,, address to) = abi.decode(data[4:], (address, uint256, address));
            return asset == USDC && to == account;
        }

        if (target == USDC && sel == APPROVE) {
            if (data.length != 4 + 32 * 2) return false;
            (address spender,) = abi.decode(data[4:], (address, uint256));
            return spender == SPOKE;
        }

        if (target == SPOKE && sel == REPAY) {
            if (data.length != 4 + 32 * 3) return false;
            (uint256 reserveId,, address onBehalfOf) = abi.decode(data[4:], (uint256, uint256, address));
            return reserveId == USDC_RESERVE_ID && onBehalfOf == account;
        }

        return false;
    }
}
