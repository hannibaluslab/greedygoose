// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {IAeroFactory} from "../src/IProtocols.sol";
import {ForkBase} from "./ForkBase.sol";
import {IJustaPermissionManager as PM} from "./IJustaPermissionManager.sol";

/// Build steps 2-3 smoke test: Save, Rebalance (trades and top-ups), Turn into cash and Refresh run through the Guard,
/// JAW's manager, Aave and the real pools on a Base fork, sent as KeeperHub would send them. Step 6 replaces it with the
/// full suites.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardMovesForkTest -vv
contract GooseGuardMovesForkTest is ForkBase {
    IAeroFactory constant AERO_FACTORY = IAeroFactory(0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef);
    address constant ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address constant AERODROME_V1_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address constant UNISWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant PSM3 = 0x1601843c5E9bC251A3272907010AFa41Fa18347E;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant USDS = 0x820C137fa70C8691f0e44Dc420a5e53c168921Dc;
    address constant DAI = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
    address constant EURC = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;
    address constant KEEPERHUB = 0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93;
    uint256 constant KH_GAS = 5_400_000;
    uint256 constant AAPL = 0;
    bytes32 constant REFUSED = keccak256("Refused(address,uint8,bytes4)");

    GooseGuard g;

    function setUp() public {
        _fork();
        _useStockDouble(STOCKS[AAPL]);
        for (uint256 r; r < STOCKS.length; r += 5) {
            address pool = AERO_FACTORY.getPool(STOCKS[r], address(USDC), 10);
            deal(STOCKS[r], pool, _realBalance(STOCKS[r], pool));
        }
        address probe = _newJawAccount("probe");
        g = new GooseGuard(address(this), KEEPERHUB, probe.codehash, 300, 50, 100, 1e6, 1e6);
    }

    // ================================================================== permissions, as the app will grant them

    function _call(address target, bytes4 selector) internal pure returns (PM.CallPermission memory) {
        return PM.CallPermission(target, selector, address(0));
    }

    function _spends(address[] memory tokens) internal pure returns (PM.SpendLimit[] memory spends) {
        spends = new PM.SpendLimit[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            spends[i] = PM.SpendLimit(tokens[i], type(uint160).max, PM.PeriodUnit.Day, 1);
        }
    }

    function _on(address a, uint8 job, PM.CallPermission[] memory calls, address[] memory tokens) internal {
        uint48 now_ = uint48(vm.getBlockTimestamp());
        PM.Permission memory p = PM.Permission(
            a, address(g), now_ - 60, now_ + 365 days, uint256(keccak256(abi.encode(a, job))), calls, _spends(tokens)
        );
        _grantThroughAccount(p);
        vm.prank(a);
        g.register(job, abi.encode(p));
    }

    function _saveOn(address a) internal {
        PM.CallPermission[] memory calls = new PM.CallPermission[](2);
        calls[0] = _call(address(USDC), 0x095ea7b3);
        calls[1] = _call(address(POOL), 0x617ba037);
        address[] memory tokens = new address[](1);
        tokens[0] = address(USDC);
        _on(a, 0, calls, tokens);
    }

    /// Rebalance over AAPLc and NVDAc: approve each, approve USDC, swap on Aerodrome. No savings withdraw (decision 1).
    function _rebalanceOn(address a) internal {
        PM.CallPermission[] memory calls = new PM.CallPermission[](4);
        calls[0] = _call(STOCKS[AAPL], 0x095ea7b3);
        calls[1] = _call(NVDAC, 0x095ea7b3);
        calls[2] = _call(address(USDC), 0x095ea7b3);
        calls[3] = _call(ROUTER, 0xa026383e);
        address[] memory tokens = new address[](3);
        tokens[0] = address(USDC);
        tokens[1] = STOCKS[AAPL];
        tokens[2] = NVDAC;
        _on(a, 3, calls, tokens);
    }

    /// Turn into cash on CASH_COINS: approve each coin, swap on its venue.
    function _entryOn(address a) internal {
        address[5] memory coins = [USDT, USDE, USDS, DAI, EURC];
        PM.CallPermission[] memory calls = new PM.CallPermission[](8);
        address[] memory tokens = new address[](5);
        for (uint256 i; i < 5; ++i) {
            calls[i] = _call(coins[i], 0x095ea7b3);
            tokens[i] = coins[i];
        }
        calls[5] = _call(AERODROME_V1_ROUTER, 0xa026383e);
        calls[6] = _call(UNISWAP_ROUTER, 0x04e45aaf);
        calls[7] = _call(PSM3, 0x1a019e37);
        _on(a, 4, calls, tokens);
    }

    /// Protect · sell with the config refresh (step0-facts.md, fact 5).
    function _sellOn(address a) internal {
        PM.CallPermission[] memory calls = new PM.CallPermission[](6);
        calls[0] = _call(address(SPOKE), 0x0ad58d2f);
        calls[1] = _call(NVDAC, 0x095ea7b3);
        calls[2] = _call(ROUTER, 0xa026383e);
        calls[3] = _call(address(USDC), 0x095ea7b3);
        calls[4] = _call(address(SPOKE), 0xb1e8f8ef);
        calls[5] = _call(address(SPOKE), 0x826002e2);
        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = NVDAC;
        _on(a, 2, calls, tokens);
    }

    // ================================================================== sending moves as KeeperHub

    /// Sends one move and returns the reason it was refused (0 = it ran).
    function _send(address a, uint8 kind, uint256[] memory args) internal returns (bytes4 reason) {
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](1);
        moves[0] = GooseGuard.Move(a, kind, args);
        vm.recordLogs();
        uint256 before = gasleft();
        vm.prank(KEEPERHUB);
        g.performUpkeep{gas: KH_GAS}(abi.encode(moves));
        console2.log("kind", kind, "gas", before - gasleft());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(g) && logs[i].topics[0] == REFUSED) reason = abi.decode(logs[i].data, (bytes4));
        }
    }

    function _args(uint256 x) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = x;
    }

    function _args(uint256 x, uint256 y) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = x;
        a[1] = y;
    }

    function _args(uint256 x, uint256 y, uint256 z) internal pure returns (uint256[] memory a) {
        a = new uint256[](3);
        a[0] = x;
        a[1] = y;
        a[2] = z;
    }

    /// The mix as setMix takes it: reserve r's weight at bits [16r, 16r + 16).
    function _pack(uint16[7] memory w) internal pure returns (uint112 mix) {
        for (uint256 r; r < 7; ++r) {
            mix |= uint112(w[r]) << uint112(16 * r);
        }
    }

    function _price(uint256 r) internal view returns (uint256) {
        return IOracleLike(0xaBaf048fD7675Ea34a84332371ffd5D55E322A47).getReservePrice(r);
    }

    function _bal(address token, address a) internal view returns (uint256) {
        return IERC20Like(token).balanceOf(a);
    }

    // ================================================================== SAVE

    /// Save keeps $1 in the wallet; with top-ups on it only fills savings up to Keep, leaving the rest to invest.
    function test_save_keeps_a_dollar_and_with_top_ups_only_fills_keep() public {
        address a = _newJawAccount("saver");
        deal(address(USDC), a, 100e6);
        _saveOn(a);
        assertEq(_send(a, 0, _args(1_000e6)), bytes4(0), "save refused");
        assertEq(_bal(address(USDC), a), 1e6, "the dollar didn't stay");

        vm.prank(a);
        g.setTopUps(true, 150e6);
        deal(address(USDC), a, 101e6);
        uint256 savings = _bal(address(AUSDC), a);
        assertEq(_send(a, 0, _args(1_000e6)), bytes4(0), "save with top-ups refused");
        uint256 saved = 101e6 - _bal(address(USDC), a);
        assertEq(saved, 150e6 - savings, "saved more than Keep needed");
    }

    // ================================================================== TRADE

    /// A drifted 50/50 mix: sell some NVDAc, buy AAPLc with the sale's floor. A second sale two hours later is paced;
    /// a new mix opens a session at once.
    function test_a_rebalance_trades_toward_target_and_is_paced() public {
        address a = _newJawAccount("mixer");
        deal(NVDAC, a, 3e8);
        deal(STOCKS[AAPL], a, 1e8);
        uint16[7] memory w;
        w[AAPL] = 5000;
        w[NVDAC_RESERVE] = 5000;
        vm.prank(a);
        g.setMix(_pack(w));
        _rebalanceOn(a);
        vm.warp(vm.getBlockTimestamp() + 1);

        uint256 nvdaPrice = _price(NVDAC_RESERVE);
        uint256 shares = 100e6 * 1e10 / nvdaPrice; // about $100 of NVDAc
        uint256 floor = shares * nvdaPrice * 9950 / 1e14;
        uint256 sell = NVDAC_RESERVE << 248 | shares;
        uint256 buy = AAPL << 248 | 1 << 247 | floor;
        assertEq(_send(a, 3, _args(0, sell, buy)), bytes4(0), "rebalance refused");
        assertGt(_bal(STOCKS[AAPL], a), 1e8, "no AAPLc bought");

        vm.warp(vm.getBlockTimestamp() + 2 hours);
        // A sale must buy with its floor (GG-06), so the paced move is an honest one.
        uint256 tenth = shares / 10;
        uint256 tenthFloor = tenth * nvdaPrice * 9950 / 1e14;
        assertEq(
            _send(a, 3, _args(0, NVDAC_RESERVE << 248 | tenth, AAPL << 248 | 1 << 247 | tenthFloor)),
            GooseGuard.Paced.selector,
            "not paced"
        );

        w[AAPL] = 4000;
        w[NVDAC_RESERVE] = 6000;
        vm.prank(a);
        g.setMix(_pack(w));
        vm.warp(vm.getBlockTimestamp() + 1);
        // NVDAc is now under its 60% target, so selling it would cross: buy it with nothing to fund it is refused too.
        assertEq(_send(a, 3, _args(0, NVDAC_RESERVE << 248 | shares / 10)), GooseGuard.Crossed.selector);
    }

    /// With top-ups on, wallet cash above $1 goes into a 100% AAPLc mix.
    function test_a_top_up_goes_into_the_mix_from_the_wallet() public {
        address a = _newJawAccount("topup");
        uint16[7] memory w;
        w[AAPL] = 10_000;
        vm.startPrank(a);
        g.setMix(_pack(w));
        g.setTopUps(true, 0);
        vm.stopPrank();
        _rebalanceOn(a);
        deal(address(USDC), a, 501e6);
        assertEq(_send(a, 3, _args(500e6, AAPL << 248 | 1 << 247 | 500e6)), bytes4(0), "top-up refused");
        assertEq(_bal(address(USDC), a), 1e6, "the dollar didn't stay");
        assertGt(_bal(STOCKS[AAPL], a), 0, "no AAPLc bought");
    }

    // ================================================================== CONVERT

    /// Each kind of venue: USDT on Aerodrome v1, USDe on Uniswap, USDS on PSM3, EURC priced by Chainlink.
    function test_coins_turn_into_cash_at_99_5_percent_or_better() public {
        address a = _newJawAccount("coins");
        _entryOn(a);
        deal(USDT, a, 100e6);
        deal(USDE, a, 100e18);
        deal(USDS, a, 100e18);
        deal(EURC, a, 100e6);
        uint8[4] memory ks = [0, 1, 2, 4];
        address[4] memory coins = [USDT, USDE, USDS, EURC];
        for (uint256 i; i < 4; ++i) {
            uint256 cash = _bal(address(USDC), a);
            bytes4 reason = _send(a, 4, _args(ks[i], type(uint128).max));
            console2.log("coin", coins[i], "USDC out", _bal(address(USDC), a) - cash);
            assertEq(reason, bytes4(0), "conversion refused");
            assertEq(_bal(coins[i], a), 0, "coin left");
        }
    }

    // ================================================================== REFRESH, pause

    /// With no newer config, a refresh doesn't raise health, so it is refused: a runner can't force a pointless one.
    function test_a_refresh_that_gains_nothing_is_refused() public {
        address a = _newJawAccount("refresh");
        _openCreditAt(a, 10e8, 1.5e18);
        _sellOn(a);
        assertEq(_send(a, 6, new uint256[](0)), GooseGuard.NoGain.selector);
    }

    /// The owner's pause stops Save.
    function test_the_pause_stops_save() public {
        address a = _newJawAccount("paused");
        deal(address(USDC), a, 100e6);
        _saveOn(a);
        g.pause();
        assertEq(_send(a, 0, _args(50e6)), GooseGuard.IsPaused.selector);
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}

interface IOracleLike {
    function getReservePrice(uint256 reserveId) external view returns (uint256);
}
