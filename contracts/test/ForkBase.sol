// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StockDouble} from "./StockDouble.sol";
import {
    IJustaPermissionManager as PM,
    IJawFactory,
    IJustanAccount,
    IAaveV3Pool,
    ISpokeLite,
    IERC20Lite
} from "./IJustaPermissionManager.sol";

/// Base mainnet fork fixtures: the real JustaPermissionManager, JAW account factory, Aave V3 Pool and Aave V4
/// Equities Hub. Tests create their own JAW accounts, so none depends on a live account's position.
/// Needs BASE_RPC_URL; the fork is taken at the latest block.
abstract contract ForkBase is Test {
    PM constant MANAGER = PM(0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8);
    IJawFactory constant JAW_FACTORY = IJawFactory(0x5803c076563C85799989d42Fc00292A8aE52fa9E);
    /// EntryPoint v0.8 (JustanAccount.entryPoint()): it calls account.executeBatch in every JAW user operation.
    address constant ENTRY_POINT = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    IAaveV3Pool constant POOL = IAaveV3Pool(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);
    ISpokeLite constant SPOKE = ISpokeLite(0x17905Db0e4A3514467539956c084180616AE7B8D);
    address constant HUB = 0xa4d5947Eb727A052bae69C593FfC84247EC9864E;
    IERC20Lite constant USDC = IERC20Lite(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20Lite constant AUSDC = IERC20Lite(0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB);
    address constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    uint256 constant NVDAC_RESERVE = 5;
    uint256 constant USDC_RESERVE = 7;

    function _fork() internal {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        _useStockDouble(NVDAC);
    }

    /// B20 stocks can't run in Foundry's EVM (see StockDouble). Swap in the double and give the hub the balance it
    /// really holds at this block, read from the node: the hub checks its balance covers its books on every supply.
    function _useStockDouble(address stock) internal {
        string memory params = string.concat(
            '[{"to":"',
            vm.toString(stock),
            '","data":"',
            vm.toString(abi.encodeWithSignature("balanceOf(address)", HUB)),
            '"},"',
            _hexQuantity(block.number),
            '"]'
        );
        uint256 hubBalance = abi.decode(vm.rpc("eth_call", params), (uint256));
        vm.etch(stock, type(StockDouble).runtimeCode);
        deal(stock, HUB, hubBalance);
    }

    /// A new account from JAW's factory, with the owners JAW's SDK gives every account: the user's signer and the
    /// permission manager (core/dist/account/smartAccount.js createSmartAccount). A plain key stands in for the passkey.
    function _newJawAccount(string memory name) internal returns (address) {
        bytes[] memory owners = new bytes[](2);
        owners[0] = abi.encode(makeAddr(name));
        owners[1] = abi.encode(address(MANAGER));
        return JAW_FACTORY.createAccount(owners, 0);
    }

    /// Back a credit line with NVDAc and draw `creditRaw` USDC, as the account itself.
    function _openCredit(address account, uint256 sharesRaw, uint256 creditRaw) internal {
        deal(NVDAC, account, sharesRaw);
        vm.startPrank(account);
        IERC20Lite(NVDAC).approve(address(SPOKE), sharesRaw);
        SPOKE.supply(NVDAC_RESERVE, sharesRaw, account);
        SPOKE.setUsingAsCollateral(NVDAC_RESERVE, true, account);
        SPOKE.borrow(USDC_RESERVE, creditRaw, account);
        vm.stopPrank();
    }

    /// Move `amount` of the account's own USDC into Aave V3 savings, as the account itself.
    function _save(address account, uint256 amount) internal {
        vm.startPrank(account);
        USDC.approve(address(POOL), amount);
        POOL.supply(address(USDC), amount, account, 0);
        vm.stopPrank();
    }

    /// Approve a permission the way JAW's grant lands on-chain: a user operation whose execution is
    /// account.executeBatch([manager.approve(permission)]), called by the EntryPoint.
    function _grantThroughAccount(PM.Permission memory p) internal {
        PM.Call[] memory calls = new PM.Call[](1);
        calls[0] = PM.Call(address(MANAGER), 0, abi.encodeCall(PM.approve, (p)));
        vm.prank(ENTRY_POINT);
        IJustanAccount(p.account).executeBatch(calls);
    }

    function _hexQuantity(uint256 v) internal pure returns (string memory) {
        bytes memory digits = "0123456789abcdef";
        bytes memory reversed = new bytes(64);
        uint256 n;
        do {
            reversed[n++] = digits[v & 15];
            v >>= 4;
        } while (v != 0);
        bytes memory out = new bytes(n + 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < n; ++i) {
            out[i + 2] = reversed[n - 1 - i];
        }
        return string(out);
    }
}
