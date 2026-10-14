// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJustaPermissionManager} from "../src/IJustaPermissionManager.sol";
import {IAaveV3Pool, IERC20, IJustanAccount, ISpoke} from "../src/IProtocols.sol";

/// The test-only parts of JAW's factory, the Aave V4 spoke, Aerodrome and ERC-20, on top of the interfaces in src.

/// JAW's account factory (the SDK's FACTORY_ADDRESS). Owners are ABI-encoded addresses or 64-byte passkeys.
interface IJawFactory {
    function createAccount(bytes[] calldata owners, uint256 nonce) external payable returns (address);
    function getImplementation() external view returns (address);
}

interface ISpokeLite is ISpoke {
    function supply(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf) external;
    function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
}

interface IERC20Lite is IERC20 {
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
