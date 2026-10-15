// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StockDouble} from "./StockDouble.sol";
import {
    IJustaPermissionManager as PM,
    IJawFactory,
    IJustanAccount,
    IAaveV3Pool,
    ISpoke,
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
    /// The seven stocks, by reserve id (lib/tokens/registry.ts).
    address[7] STOCKS = [
        0xb200000000000000000000C2e324d24d7eEcd1fb, // AAPLc
        0xb200000000000000000000d9192b6B456483C2E8, // AMZNc
        0xb2000000000000000000002D0BA3164cc74f58B7, // GOOGLc
        0xb2000000000000000000008bC8786B856E61707C, // METAc
        0xB200000000000000000000Ab99cFa739E253872B, // MSFTc
        NVDAC,
        0xb2000000000000000000001e800a7f5189430cD0 // TSLAc
    ];
    uint256 constant USDC_RESERVE = 7;

    function _fork() internal {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        _useStockDouble(NVDAC);
    }

    /// B20 stocks can't run in Foundry's EVM (see StockDouble). Swap in the double and give the hub the balance it
    /// really holds at this block, read from the node: the hub checks its balance covers its books on every supply.
    function _useStockDouble(address stock) internal {
        uint256 hubBalance = _realBalance(stock, HUB);
        vm.etch(stock, type(StockDouble).runtimeCode);
        deal(stock, HUB, hubBalance);
    }

    /// A stock's balance at `holder` on Base at this block, read from the node (the fork can't run B20 code).
    function _realBalance(address stock, address holder) internal returns (uint256) {
        string memory params = string.concat(
            '[{"to":"',
            vm.toString(stock),
            '","data":"',
            vm.toString(abi.encodeWithSignature("balanceOf(address)", holder)),
            '"},"',
            _hexQuantity(block.number),
            '"]'
        );
        return abi.decode(vm.rpc("eth_call", params), (uint256));
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
        _backWithNvda(account, sharesRaw);
        vm.prank(account);
        SPOKE.borrow(USDC_RESERVE, creditRaw, account);
    }

    /// Back a credit line with NVDAc and draw USDC until the health factor is `hf` (WAD), as the account itself.
    function _openCreditAt(address account, uint256 sharesRaw, uint256 hf) internal returns (uint256 creditRaw) {
        _backWithNvda(account, sharesRaw);
        return _drawTo(account, hf);
    }

    /// Draw USDC on what already backs the account until its health factor is `hf` (WAD).
    function _drawTo(address account, uint256 hf) internal returns (uint256 creditRaw) {
        ISpoke.UserAccountData memory d = SPOKE.getUserAccountData(account);
        creditRaw = d.totalCollateralValue * d.avgCollateralFactor / 1e18 * 1e18 / hf / 1e20;
        vm.prank(account);
        SPOKE.borrow(USDC_RESERVE, creditRaw, account);
    }

    /// Draw more USDC on what already backs the account, on top of what it owes, until its health factor is `hf` (WAD).
    function _drawMoreTo(address account, uint256 hf) internal {
        ISpoke.UserAccountData memory d = SPOKE.getUserAccountData(account);
        uint256 owed = d.totalCollateralValue * d.avgCollateralFactor / 1e18 * 1e18 / hf / 1e20;
        uint256 debt = SPOKE.getUserTotalDebt(USDC_RESERVE, account);
        vm.prank(account);
        SPOKE.borrow(USDC_RESERVE, owed - debt, account);
    }

    /// Back a credit line with `sharesRaw` of each of the seven stocks, the costliest position to read. Needs
    /// `_useStockDouble` for every stock first.
    function _backWithAllStocks(address account, uint256 sharesRaw) internal {
        for (uint256 r; r < STOCKS.length; ++r) {
            _backWith(account, r, sharesRaw);
        }
    }

    function _backWithNvda(address account, uint256 sharesRaw) internal {
        _backWith(account, NVDAC_RESERVE, sharesRaw);
    }

    /// Back a credit line with `sharesRaw` of the stock at reserve `r`, as the account itself.
    function _backWith(address account, uint256 r, uint256 sharesRaw) internal {
        deal(STOCKS[r], account, sharesRaw);
        vm.startPrank(account);
        IERC20Lite(STOCKS[r]).approve(address(SPOKE), sharesRaw);
        SPOKE.supply(r, sharesRaw, account);
        SPOKE.setUsingAsCollateral(r, true, account);
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

    /// Revoke the way JAW's revoke screen lands on-chain: account.executeBatch([manager.revoke(permission)]).
    function _revokeThroughAccount(PM.Permission memory p) internal {
        PM.Call[] memory calls = new PM.Call[](1);
        calls[0] = PM.Call(address(MANAGER), 0, abi.encodeCall(PM.revoke, (p)));
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
