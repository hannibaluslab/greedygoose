// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {IAeroFactory, IAeroPool, IAeroRouter, IChainlinkFeed} from "../src/IProtocols.sol";
import {ForkBase} from "./ForkBase.sol";
import {StockDouble} from "./StockDouble.sol";
import {IJustaPermissionManager as PM, ISpoke, IERC20Lite} from "./IJustaPermissionManager.sol";

/// The parts of Aave V4's AccessManager (AccessManagerEnumerable) the H6 suites use to add a collateral config.
interface IAccessManagerLike {
    function getTargetFunctionRole(address target, bytes4 selector) external view returns (uint64);
    function getRoleMember(uint64 roleId, uint256 index) external view returns (address);
}

interface ISpokeAdmin {
    function authority() external view returns (address);
    function addDynamicReserveConfig(uint256 reserveId, ISpoke.DynamicReserveConfig calldata config)
        external
        returns (uint32);
    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);
}

interface IOracleLike {
    function getReservePrice(uint256 reserveId) external view returns (uint256);
    function getReserveSource(uint256 reserveId) external view returns (address);
}

interface IFeedLike {
    function latestAnswer() external view returns (int256);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Shared fixtures for the GooseGuard fork suites (spec-final-v2.md §14, items 3-14): a Base fork pinned at one block
/// (so Foundry caches its reads on disk and every run sees the same pools), the seven stocks as StockDoubles holding
/// the hub's and their pools' real balances, the Guard deployed with the smoke tests' constructor (sale floor 3%, swap
/// floor 0.5%, band 1%, keep-back $1, dust $1), the app's permission templates over all seven stocks (§5), and moves
/// sent as KeeperHub sends them (prank 0x9c74…, 5.4M gas).
///
/// Keyless RPC only: BASE_RPC_URL=https://mainnet.base.org (it serves the pinned block's state). GUARD_FORK_BLOCK
/// overrides the block.
abstract contract GuardForkBase is ForkBase {
    uint256 constant FORK_BLOCK = 52_946_000;

    IAeroFactory constant AERO_FACTORY = IAeroFactory(0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef);
    IOracleLike constant ORACLE = IOracleLike(0xaBaf048fD7675Ea34a84332371ffd5D55E322A47);
    address constant ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address constant AERODROME_V1_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address constant UNISWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant PSM3 = 0x1601843c5E9bC251A3272907010AFa41Fa18347E;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant USDS = 0x820C137fa70C8691f0e44Dc420a5e53c168921Dc;
    address constant DAI = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
    address constant EURC = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;
    address constant EUR_USD = 0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F;
    address constant KEEPERHUB = 0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93;
    /// KeeperHub's write is 5.5M; about 5.4M reaches the Guard (tests.md trap 7).
    uint256 constant KH_GAS = 5_400_000;
    bytes32 constant REFUSED = keccak256("Refused(address,uint8,bytes4)");

    uint8 constant SAVE = 0;
    uint8 constant REPAY = 1;
    uint8 constant SELL = 2;
    uint8 constant TRADE = 3;
    uint8 constant CONVERT = 4;
    uint8 constant END = 5;
    uint8 constant REFRESH = 6;

    uint8 constant JOB_SAVE = 0;
    uint8 constant JOB_PROTECT = 1;
    uint8 constant JOB_SELL = 2;
    uint8 constant JOB_REBALANCE = 3;
    uint8 constant JOB_ENTRY = 4;

    uint256 constant AAPL = 0;
    uint256 constant NVDA = 5;
    uint256 constant TSLA = 6;
    uint256 constant ALL_STOCKS = 0x7f;

    bytes4 constant APPROVE = 0x095ea7b3;
    bytes4 constant V3_SUPPLY = 0x617ba037;
    bytes4 constant V3_WITHDRAW = 0x69328dec;
    bytes4 constant V4_WITHDRAW = 0x0ad58d2f;
    bytes4 constant V4_REPAY = 0xb1e8f8ef;
    bytes4 constant V4_REFRESH = 0x826002e2;
    bytes4 constant AERO_SWAP = 0xa026383e;
    bytes4 constant UNI_SWAP = 0x04e45aaf;
    bytes4 constant PSM_SWAP = 0x1a019e37;

    bytes4 constant UNAUTHORIZED_CALL = bytes4(keccak256("JustaPermissionManager_UnauthorizedCall(address,bytes4)"));
    bytes4 constant EXECUTE_ERROR = bytes4(keccak256("ExecuteError(uint256,bytes)"));
    /// What `_reason` returns for a `Refused` with an empty reason: the move's frame ran out of gas (or an inner call
    /// reverted without data). Not a real selector.
    bytes4 constant OUT_OF_GAS = 0xffffffff;

    GooseGuard g;
    uint256 starts;

    function _setUpGuard() internal {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"), vm.envOr("GUARD_FORK_BLOCK", FORK_BLOCK));
        for (uint256 r; r < 7; ++r) {
            _useStockDouble(STOCKS[r]);
            address pool = _poolOf(r);
            deal(STOCKS[r], pool, _realBalance(STOCKS[r], pool));
        }
        address probe = _newJawAccount("probe");
        g = new GooseGuard(address(this), KEEPERHUB, probe.codehash, 300, 50, 100, 1e6, 1e6);
        vm.label(address(g), "GooseGuard");
        vm.label(KEEPERHUB, "KeeperHub");
    }

    function _poolOf(uint256 r) internal view returns (address) {
        return AERO_FACTORY.getPool(STOCKS[r], address(USDC), 10);
    }

    // ================================================================== permissions, as the app grants them (§5)

    function _cp(address target, bytes4 selector) internal pure returns (PM.CallPermission memory) {
        return PM.CallPermission(target, selector, address(0));
    }

    function _spends(address[] memory tokens) internal pure returns (PM.SpendLimit[] memory s) {
        s = new PM.SpendLimit[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            s[i] = PM.SpendLimit(tokens[i], type(uint160).max, PM.PeriodUnit.Day, 1);
        }
    }

    /// A permission for the Guard, a year long, its start strictly above any earlier one this suite made (the Guard's
    /// high-water rule) and in the past.
    function _permission(address a, PM.CallPermission[] memory calls, address[] memory tokens)
        internal
        returns (PM.Permission memory)
    {
        uint48 now_ = uint48(vm.getBlockTimestamp());
        uint48 start = now_ - 3600 + uint48(++starts);
        return PM.Permission(
            a, address(g), start, now_ + 365 days, uint256(keccak256(abi.encode(a, starts))), calls, _spends(tokens)
        );
    }

    /// The one-tap batch's two halves: approve through the account, then the account registers it with the Guard.
    function _on(address a, uint8 job, PM.Permission memory p) internal returns (PM.Permission memory) {
        _grantThroughAccount(p);
        vm.prank(a);
        g.register(job, abi.encode(p));
        return p;
    }

    function _saveP(address a) internal returns (PM.Permission memory) {
        PM.CallPermission[] memory calls = new PM.CallPermission[](2);
        calls[0] = _cp(address(USDC), APPROVE);
        calls[1] = _cp(address(POOL), V3_SUPPLY);
        address[] memory tokens = new address[](1);
        tokens[0] = address(USDC);
        return _permission(a, calls, tokens);
    }

    function _protectP(address a) internal returns (PM.Permission memory) {
        PM.CallPermission[] memory calls = new PM.CallPermission[](3);
        calls[0] = _cp(address(POOL), V3_WITHDRAW);
        calls[1] = _cp(address(USDC), APPROVE);
        calls[2] = _cp(address(SPOKE), V4_REPAY);
        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(AUSDC);
        return _permission(a, calls, tokens);
    }

    /// Protect · sell over the stocks in `mask` (bit r = reserve r): V4 withdraw, each stock's approve, the Aerodrome
    /// swap, USDC approve, V4 repay and the config refresh (step0-facts.md, fact 5).
    function _sellP(address a, uint256 mask) internal returns (PM.Permission memory) {
        uint256 k = _bits(mask);
        PM.CallPermission[] memory calls = new PM.CallPermission[](5 + k);
        address[] memory tokens = new address[](1 + k);
        calls[0] = _cp(address(SPOKE), V4_WITHDRAW);
        calls[1] = _cp(ROUTER, AERO_SWAP);
        calls[2] = _cp(address(USDC), APPROVE);
        calls[3] = _cp(address(SPOKE), V4_REPAY);
        calls[4] = _cp(address(SPOKE), V4_REFRESH);
        tokens[0] = address(USDC);
        uint256 n;
        for (uint256 r; r < 7; ++r) {
            if (mask >> r & 1 == 0) continue;
            calls[5 + n] = _cp(STOCKS[r], APPROVE);
            tokens[1 + n++] = STOCKS[r];
        }
        return _permission(a, calls, tokens);
    }

    /// Rebalance over the stocks in `mask`: each stock's approve, USDC approve, the Aerodrome swap. No savings call.
    function _rebalanceP(address a, uint256 mask) internal returns (PM.Permission memory) {
        uint256 k = _bits(mask);
        PM.CallPermission[] memory calls = new PM.CallPermission[](2 + k);
        address[] memory tokens = new address[](1 + k);
        calls[0] = _cp(address(USDC), APPROVE);
        calls[1] = _cp(ROUTER, AERO_SWAP);
        tokens[0] = address(USDC);
        uint256 n;
        for (uint256 r; r < 7; ++r) {
            if (mask >> r & 1 == 0) continue;
            calls[2 + n] = _cp(STOCKS[r], APPROVE);
            tokens[1 + n++] = STOCKS[r];
        }
        return _permission(a, calls, tokens);
    }

    /// Turn into cash on CASH_COINS: each coin's approve, and the three venues.
    function _entryP(address a) internal returns (PM.Permission memory) {
        address[5] memory coins = [USDT, USDE, USDS, DAI, EURC];
        PM.CallPermission[] memory calls = new PM.CallPermission[](8);
        address[] memory tokens = new address[](5);
        for (uint256 i; i < 5; ++i) {
            calls[i] = _cp(coins[i], APPROVE);
            tokens[i] = coins[i];
        }
        calls[5] = _cp(AERODROME_V1_ROUTER, AERO_SWAP);
        calls[6] = _cp(UNISWAP_ROUTER, UNI_SWAP);
        calls[7] = _cp(PSM3, PSM_SWAP);
        return _permission(a, calls, tokens);
    }

    function _saveOn(address a) internal returns (PM.Permission memory) {
        return _on(a, JOB_SAVE, _saveP(a));
    }

    function _protectOn(address a) internal returns (PM.Permission memory) {
        return _on(a, JOB_PROTECT, _protectP(a));
    }

    function _sellOn(address a) internal returns (PM.Permission memory) {
        return _on(a, JOB_SELL, _sellP(a, ALL_STOCKS));
    }

    function _rebalanceOn(address a) internal returns (PM.Permission memory) {
        return _on(a, JOB_REBALANCE, _rebalanceP(a, ALL_STOCKS));
    }

    function _entryOn(address a) internal returns (PM.Permission memory) {
        return _on(a, JOB_ENTRY, _entryP(a));
    }

    function _allOn(address a) internal {
        _saveOn(a);
        _protectOn(a);
        _sellOn(a);
        _rebalanceOn(a);
        _entryOn(a);
    }

    function _bits(uint256 mask) internal pure returns (uint256 k) {
        for (; mask != 0; mask >>= 1) {
            k += mask & 1;
        }
    }

    // ================================================================== moves, sent as KeeperHub sends them

    function _move(address a, uint8 kind, uint256[] memory args) internal pure returns (GooseGuard.Move memory) {
        return GooseGuard.Move(a, kind, args);
    }

    function _one(address a, uint8 kind, uint256[] memory args) internal pure returns (bytes memory) {
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](1);
        moves[0] = GooseGuard.Move(a, kind, args);
        return abi.encode(moves);
    }

    /// Raw performData from `sender` with KeeperHub's gas. The perform must not revert: a reverted write loses the
    /// round (§4.0), so every hacked-runner case goes through here. `gasUsed` is the perform's execution gas, without
    /// the transaction's intrinsic gas (the call is its own transaction: see `_execGas`).
    function _performAs(address sender, bytes memory performData) internal returns (uint256 gasUsed, Vm.Log[] memory) {
        vm.recordLogs();
        bytes memory callData = abi.encodeCall(GooseGuard.performUpkeep, (performData));
        vm.prank(sender);
        (bool ok, bytes memory ret) = address(g).call{gas: KH_GAS}(callData);
        gasUsed = _execGas(callData);
        if (!ok) {
            console2.log("the perform reverted:");
            console2.logBytes(ret);
        }
        assertTrue(ok, "the whole perform reverted");
        return (gasUsed, vm.getRecordedLogs());
    }

    function _perform(bytes memory performData) internal returns (uint256 gasUsed, Vm.Log[] memory logs) {
        return _performAs(KEEPERHUB, performData);
    }

    /// Sends one move as KeeperHub and returns the reason it was refused: 0 = it ran, OUT_OF_GAS = refused with no
    /// reason (the frame ran out of gas, or an inner call reverted without data).
    function _send(address a, uint8 kind, uint256[] memory args) internal returns (bytes4) {
        (, Vm.Log[] memory logs) = _perform(_one(a, kind, args));
        return _reason(logs, a);
    }

    /// Same, with the perform's gas.
    function _sendGas(address a, uint8 kind, uint256[] memory args) internal returns (bytes4 reason, uint256 gasUsed) {
        Vm.Log[] memory logs;
        (gasUsed, logs) = _perform(_one(a, kind, args));
        reason = _reason(logs, a);
    }

    /// The last `Refused` reason logged for `a`: 0 when none was logged, OUT_OF_GAS for an empty reason.
    function _reason(Vm.Log[] memory logs, address a) internal view returns (bytes4 reason) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(g) || logs[i].topics[0] != REFUSED) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != a) continue;
            reason = abi.decode(logs[i].data, (bytes4));
            if (reason == bytes4(0)) reason = OUT_OF_GAS;
        }
    }

    /// Every `Refused` reason in order (OUT_OF_GAS for an empty one).
    function _reasons(Vm.Log[] memory logs) internal view returns (bytes4[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(g) && logs[i].topics[0] == REFUSED) ++n;
        }
        out = new bytes4[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(g) && logs[i].topics[0] == REFUSED) {
                bytes4 reason = abi.decode(logs[i].data, (bytes4));
                out[n++] = reason == bytes4(0) ? OUT_OF_GAS : reason;
            }
        }
    }

    /// Whether the Guard logged `topic0` for `a`.
    function _logged(Vm.Log[] memory logs, bytes32 topic0, address a) internal view returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(g) || logs[i].topics[0] != topic0) continue;
            if (logs[i].topics.length > 1 && address(uint160(uint256(logs[i].topics[1]))) == a) return true;
        }
        return false;
    }

    function _a0() internal pure returns (uint256[] memory a) {
        a = new uint256[](0);
    }

    function _a1(uint256 x) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = x;
    }

    function _a2(uint256 x, uint256 y) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = x;
        a[1] = y;
    }

    function _a3(uint256 x, uint256 y, uint256 z) internal pure returns (uint256[] memory a) {
        a = new uint256[](3);
        a[0] = x;
        a[1] = y;
        a[2] = z;
    }

    function _leg(uint256 r, uint256 shares) internal pure returns (uint256) {
        return r << 248 | shares;
    }

    function _buy(uint256 r, uint256 usdc) internal pure returns (uint256) {
        return r << 248 | 1 << 247 | usdc;
    }

    function _pack(uint16[7] memory w) internal pure returns (uint112 mix) {
        for (uint256 r; r < 7; ++r) {
            mix |= uint112(w[r]) << uint112(16 * r);
        }
    }

    // ================================================================== positions and readings

    function _price(uint256 r) internal view returns (uint256) {
        return ORACLE.getReservePrice(r);
    }

    /// Shares of stock r worth `usd` USDC units at Aave's price.
    function _sharesFor(uint256 r, uint256 usd) internal view returns (uint256) {
        return usd * 1e10 / _price(r);
    }

    function _valueOf(uint256 r, uint256 shares) internal view returns (uint256) {
        return shares * _price(r) / 1e10;
    }

    function _backUsd(address a, uint256 r, uint256 usd) internal returns (uint256 shares) {
        shares = _sharesFor(r, usd);
        _backWith(a, r, shares);
    }

    /// `usd` of each stock in `mask` backing the credit.
    function _backMask(address a, uint256 mask, uint256 usd) internal {
        for (uint256 r; r < 7; ++r) {
            if (mask >> r & 1 == 1) _backUsd(a, r, usd);
        }
    }

    function _hf(address a) internal view returns (uint256) {
        return SPOKE.getUserAccountData(a).healthFactor;
    }

    function _debt(address a) internal view returns (uint256) {
        return SPOKE.getUserTotalDebt(USDC_RESERVE, a);
    }

    function _bal(address token, address a) internal view returns (uint256) {
        return IERC20Lite(token).balanceOf(a);
    }

    function _supplied(uint256 r, address a) internal view returns (uint256) {
        return ISpokeAdmin(address(SPOKE)).getUserSuppliedAssets(r, a);
    }

    /// USDC to repay so health lands at `t`: debt − power / t.
    function _repayTo(address a, uint256 t) internal view returns (uint256) {
        ISpoke.UserAccountData memory d = SPOKE.getUserAccountData(a);
        uint256 power = d.totalCollateralValue * d.avgCollateralFactor / 1e18;
        uint256 debtValue = d.totalDebtValueRay / 1e27;
        return (debtValue - power * 1e18 / t) / 1e20;
    }

    /// A slice of stock r worth `bps` of the debt.
    function _slice(address a, uint256 r, uint256 bps) internal view returns (uint256) {
        return _sharesFor(r, _debt(a) * bps / 1e4);
    }

    // ================================================================== what a victim holds

    struct Holdings {
        uint256 usdc;
        uint256 ausdc;
        uint256 debt;
        uint256[7] wallet;
        uint256[7] supplied;
        uint256[5] coins;
    }

    function _holdings(address a) internal view returns (Holdings memory h) {
        h.usdc = _bal(address(USDC), a);
        h.ausdc = _bal(address(AUSDC), a);
        h.debt = _debt(a);
        for (uint256 r; r < 7; ++r) {
            h.wallet[r] = _bal(STOCKS[r], a);
            h.supplied[r] = _supplied(r, a);
        }
        address[5] memory coins = [USDT, USDE, USDS, DAI, EURC];
        for (uint256 i; i < 5; ++i) {
            h.coins[i] = _bal(coins[i], a);
        }
    }

    /// Nothing moved. aUSDC accrues interest by the block, so it may only grow by rounding.
    function _assertUnchanged(address a, Holdings memory h) internal view {
        Holdings memory n = _holdings(a);
        assertEq(n.usdc, h.usdc, "victim's USDC moved");
        assertApproxEqAbs(n.ausdc, h.ausdc, 2, "victim's savings moved");
        assertApproxEqAbs(n.debt, h.debt, 2, "victim's credit moved");
        for (uint256 r; r < 7; ++r) {
            assertEq(n.wallet[r], h.wallet[r], "victim's free stock moved");
            assertEq(n.supplied[r], h.supplied[r], "victim's backing moved");
        }
        for (uint256 i; i < 5; ++i) {
            assertEq(n.coins[i], h.coins[i], "victim's coins moved");
        }
    }

    // ================================================================== pools and prices

    /// Stock r's pool price in USDC a share, 8 decimals: the Guard's own `_poolPrice`, copied.
    function _poolPrice(uint256 r) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,) = IAeroPool(_poolOf(r)).slot0();
        uint256 q = (uint256(1) << 96) * 1e10 / sqrtPriceX96;
        return q * q / 1e10;
    }

    /// The pool's distance from Aave's price, in signed BPS (positive = pool above Aave).
    function _offBps(uint256 r) internal view returns (int256) {
        uint256 px = _price(r);
        uint256 pool = _poolPrice(r);
        return (int256(pool) - int256(px)) * 1e4 / int256(px);
    }

    /// Moves stock r's pool to `bpsFromAave` (signed BPS from Aave's price) with a real swap through Aerodrome's
    /// router, stopped exactly at that price by sqrtPriceLimitX96. A whale pays for it.
    function _nudge(uint256 r, int256 bpsFromAave) internal {
        uint256 target = uint256(int256(_price(r)) * (1e4 + bpsFromAave) / 1e4); // 8 decimals
        // USDC is token0: sqrtPriceX96 = sqrt(raw shares per raw USDC) × 2^96 = sqrt(1e10 / price8) × 2^96.
        uint160 limit = uint160(_sqrt((uint256(1) << 192) / target * 1e10));
        (uint160 now_,,,,,) = IAeroPool(_poolOf(r)).slot0();
        address whale = makeAddr("whale");
        bool buyStock = limit < now_; // USDC in pushes sqrtPrice down and the share price up
        address tokenIn = buyStock ? address(USDC) : STOCKS[r];
        address tokenOut = buyStock ? STOCKS[r] : address(USDC);
        uint256 amountIn = buyStock ? 50_000_000e6 : 1_000_000e8;
        deal(tokenIn, whale, amountIn);
        vm.startPrank(whale);
        IERC20Lite(tokenIn).approve(ROUTER, amountIn);
        IAeroRouter(ROUTER).exactInputSingle(
            IAeroRouter.ExactInputSingleParams(
                tokenIn, tokenOut, 10, whale, vm.getBlockTimestamp(), amountIn, 0, limit
            )
        );
        vm.stopPrank();
    }

    /// Restores stock r's pool to where it was (`sqrtPriceX96`), as an arbitrageur would.
    function _restorePool(uint256 r, uint160 sqrtPriceX96) internal {
        (uint160 now_,,,,,) = IAeroPool(_poolOf(r)).slot0();
        if (now_ == sqrtPriceX96) return;
        address whale = makeAddr("arb");
        bool buyStock = sqrtPriceX96 < now_;
        address tokenIn = buyStock ? address(USDC) : STOCKS[r];
        address tokenOut = buyStock ? STOCKS[r] : address(USDC);
        uint256 amountIn = buyStock ? 50_000_000e6 : 1_000_000e8;
        deal(tokenIn, whale, amountIn);
        vm.startPrank(whale);
        IERC20Lite(tokenIn).approve(ROUTER, amountIn);
        IAeroRouter(ROUTER).exactInputSingle(
            IAeroRouter.ExactInputSingleParams(
                tokenIn, tokenOut, 10, whale, vm.getBlockTimestamp(), amountIn, 0, sqrtPriceX96
            )
        );
        vm.stopPrank();
    }

    function _sqrtPrice(uint256 r) internal view returns (uint160 s) {
        (s,,,,,) = IAeroPool(_poolOf(r)).slot0();
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x >> 1) + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) >> 1;
        }
    }

    /// Aave's price for stock r becomes `price8` (an oracle shock): its Chainlink source is mocked, so the Spoke, the
    /// oracle and the Guard all read it.
    function _mockPrice(uint256 r, uint256 price8) internal {
        address source = ORACLE.getReserveSource(r);
        vm.mockCall(source, IFeedLike.latestAnswer.selector, abi.encode(int256(price8)));
        vm.mockCall(
            source,
            IFeedLike.latestRoundData.selector,
            abi.encode(uint80(1), int256(price8), vm.getBlockTimestamp(), vm.getBlockTimestamp(), uint80(1))
        );
        assertEq(_price(r), price8, "the oracle didn't take the mocked price");
    }

    // ================================================================== Aave's collateral configs (H6)

    /// Adds a new dynamic config for stock r with collateral factor `cfBps`, as Aave governance would: the Spoke's
    /// AccessManager names the role allowed to call addDynamicReserveConfig, and its one member is pranked. New
    /// positions and any refresh (withdraw, borrow, updateUserDynamicConfig) take it; stored positions keep theirs.
    function _setCollateralFactor(uint256 r, uint16 cfBps) internal returns (uint32 key) {
        IAccessManagerLike am = IAccessManagerLike(ISpokeAdmin(address(SPOKE)).authority());
        uint64 role = am.getTargetFunctionRole(address(SPOKE), ISpokeAdmin.addDynamicReserveConfig.selector);
        address admin = am.getRoleMember(role, 0);
        ISpoke.DynamicReserveConfig memory c = _latestConfig(r);
        c.collateralFactor = cfBps;
        vm.prank(admin);
        key = ISpokeAdmin(address(SPOKE)).addDynamicReserveConfig(r, c);
    }

    function _latestConfig(uint256 r) internal view returns (ISpoke.DynamicReserveConfig memory) {
        return SPOKE.getDynamicReserveConfig(r, SPOKE.getReserve(r).dynamicConfigKey);
    }

    // ================================================================== gas, cold

    /// Foundry runs each top-level call of a test as its own transaction (`isolate = true`, its default here): fresh
    /// access lists and original values, as a KeeperHub write gets. `lastCallGas` then includes the intrinsic gas,
    /// which this takes off. Calls made from a deeper frame are not isolated and read warm, so every measured call
    /// here is made from the test function itself.
    function _execGas(bytes memory callData) internal view returns (uint256) {
        uint256 intrinsic = 21_000;
        for (uint256 i; i < callData.length; ++i) {
            intrinsic += callData[i] == 0 ? 4 : 16;
        }
        uint256 used = vm.lastCallGas().gasTotalUsed;
        return used > intrinsic ? used - intrinsic : used; // not isolated: no intrinsic in it
    }

    /// Fails unless top-level calls are isolated transactions (don't pass --no-isolate): only then is gas cold.
    function _assertIsolated() internal {
        vm.prank(address(0xdead));
        g.endRescue(); // a no-op write: only writes are isolated

        assertGe(vm.lastCallGas().gasTotalUsed, 21_000, "run with isolation (forge's default here; no --no-isolate)");
    }

    /// The cold gas of one move's own frame (`run` called as the Guard calls it, with all of KeeperHub's gas: what
    /// `capOf` must cover), and of the whole perform carrying only it at 5.4M, where the frame gets only its cap. Both
    /// start from the same state and are execution gas (no intrinsic); the perform is the one that stays. `reason` is
    /// the perform's refusal, 0 if it ran.
    function _coldGas(GooseGuard.Move memory m) internal returns (uint256 frame, uint256 perform, bytes4 reason) {
        _assertIsolated();
        uint256 snap = vm.snapshotState();
        bytes memory runData = abi.encodeCall(GooseGuard.run, (m));
        vm.prank(address(g));
        (bool ok, bytes memory ret) = address(g).call{gas: KH_GAS}(runData);
        frame = _execGas(runData);
        if (!ok) {
            console2.log("the move's frame reverted:");
            console2.logBytes(ret);
        }
        assertTrue(ok, "the move's frame reverted even with all of KeeperHub's gas");
        vm.revertToState(snap);

        bytes memory performData = abi.encodeCall(GooseGuard.performUpkeep, (_oneMove(m)));
        vm.recordLogs();
        vm.prank(KEEPERHUB);
        (ok,) = address(g).call{gas: KH_GAS}(performData);
        perform = _execGas(performData);
        assertTrue(ok, "the perform reverted");
        reason = _reason(vm.getRecordedLogs(), m.account);
    }

    function _oneMove(GooseGuard.Move memory m) internal pure returns (bytes memory) {
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](1);
        moves[0] = m;
        return abi.encode(moves);
    }

    /// Runs a move's frame directly, as the Guard would, with no gas cap: a fixture for setting up a state (a rescue,
    /// say) on a position whose real move the caps refuse. Reverts if the move would be refused.
    function _runUncapped(GooseGuard.Move memory m) internal {
        vm.prank(address(g));
        g.run(m);
    }
}
