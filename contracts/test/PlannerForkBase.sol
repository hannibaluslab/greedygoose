// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GoosePlanner} from "../src/GoosePlanner.sol";
import {IGooseGuard, PlanBase} from "../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../src/planner/TradePlanner.sol";
import {CashPlanner} from "../src/planner/CashPlanner.sol";
import {PoolDepth, IClPool} from "../src/PoolDepth.sol";
import {IAeroFactory, IAeroRouter, IUniswapRouter, IPsm3} from "../src/IProtocols.sol";
import {ForkBase} from "./ForkBase.sol";
import {IJustaPermissionManager as PM, ISpoke, IERC20Lite} from "./IJustaPermissionManager.sol";

/// Shared fixtures for the GoosePlanner fork suites: a real GooseGuard and Planner on a Base fork, the agents'
/// permissions as the app grants them, and KeeperHub's round (read, write, read, write, at 5.4M a write).
abstract contract PlannerForkBase is ForkBase {
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
    /// KeeperHub's write is 5.5M; about 5.4M reaches the Guard.
    uint256 constant KH_GAS = 5_400_000;
    /// An eth_call cap well above the Planner's own 8M budget.
    uint256 constant READ_CAP = 50_000_000;
    bytes32 constant REFUSED = keccak256("Refused(address,uint8,bytes4)");
    uint256 constant AAPL = 0;

    GooseGuard g;
    GoosePlanner planner;
    ProtectPlanner protect;
    TradePlanner trader;
    CashPlanner cash;

    function setUp() public {
        // FORK_BLOCK pins the fork, so Foundry's RPC cache serves reruns (the keyless RPCs rate-limit).
        // Pinned by default to the Guard suites' block (GuardForkBase), so runs repeat and reuse the RPC cache.
        uint256 pinned = vm.envOr("FORK_BLOCK", uint256(52_946_000));
        if (pinned == 0) vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        else vm.createSelectFork(vm.envString("BASE_RPC_URL"), pinned);
        _useStockDouble(NVDAC);
        for (uint256 r; r < 7; ++r) {
            if (STOCKS[r] != NVDAC) _useStockDouble(STOCKS[r]);
            address pool = AERO_FACTORY.getPool(STOCKS[r], address(USDC), 10);
            deal(STOCKS[r], pool, _realBalance(STOCKS[r], pool));
        }
        address probe = _newJawAccount("probe");
        g = new GooseGuard(address(this), KEEPERHUB, probe.codehash, 300, 50, 100, 1e6, 1e6);
        IGooseGuard ig = IGooseGuard(address(g));
        protect = new ProtectPlanner(ig);
        trader = new TradePlanner(ig);
        cash = new CashPlanner(ig);
        planner = new GoosePlanner(ig, protect, trader, cash);
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

    function _protectOn(address a) internal {
        PM.CallPermission[] memory calls = new PM.CallPermission[](3);
        calls[0] = _call(address(POOL), 0x69328dec);
        calls[1] = _call(address(USDC), 0x095ea7b3);
        calls[2] = _call(address(SPOKE), 0xb1e8f8ef);
        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(AUSDC);
        _on(a, 1, calls, tokens);
    }

    /// Protect · sell over all seven stocks, with the config refresh.
    function _sellOn(address a) internal {
        PM.CallPermission[] memory calls = new PM.CallPermission[](12);
        address[] memory tokens = new address[](8);
        tokens[0] = address(USDC);
        for (uint256 r; r < 7; ++r) {
            calls[r] = _call(STOCKS[r], 0x095ea7b3);
            tokens[r + 1] = STOCKS[r];
        }
        calls[7] = _call(address(SPOKE), 0x0ad58d2f);
        calls[8] = _call(ROUTER, 0xa026383e);
        calls[9] = _call(address(USDC), 0x095ea7b3);
        calls[10] = _call(address(SPOKE), 0xb1e8f8ef);
        calls[11] = _call(address(SPOKE), 0x826002e2);
        _on(a, 2, calls, tokens);
    }

    function _saveOn(address a) internal {
        PM.CallPermission[] memory calls = new PM.CallPermission[](2);
        calls[0] = _call(address(USDC), 0x095ea7b3);
        calls[1] = _call(address(POOL), 0x617ba037);
        address[] memory tokens = new address[](1);
        tokens[0] = address(USDC);
        _on(a, 0, calls, tokens);
    }

    /// Rebalance over all seven stocks: approve each, approve USDC, swap on Aerodrome.
    function _rebalanceOn(address a) internal {
        PM.CallPermission[] memory calls = new PM.CallPermission[](9);
        address[] memory tokens = new address[](8);
        tokens[0] = address(USDC);
        for (uint256 r; r < 7; ++r) {
            calls[r] = _call(STOCKS[r], 0x095ea7b3);
            tokens[r + 1] = STOCKS[r];
        }
        calls[7] = _call(address(USDC), 0x095ea7b3);
        calls[8] = _call(ROUTER, 0xa026383e);
        _on(a, 3, calls, tokens);
    }

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

    // ================================================================== KeeperHub's round

    struct RoundLog {
        uint256 writes;
        uint256 moves;
        uint256 refused;
        uint256 maxReadGas;
        uint256 maxWriteGas;
    }

    /// One read and, if it found anything, one write as KeeperHub sends it. Returns the moves it sent.
    function _readWrite(RoundLog memory log) internal returns (uint256 sent) {
        uint256 before = gasleft();
        (bool need, bytes memory data) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        uint256 readGas = before - gasleft();
        if (readGas > log.maxReadGas) log.maxReadGas = readGas;
        if (!need) return 0;
        GooseGuard.Move[] memory moves = abi.decode(data, (GooseGuard.Move[]));
        sent = moves.length;
        for (uint256 i; i < moves.length; ++i) {
            console2.log("  move: kind, legs", moves[i].kind, moves[i].args.length);
        }
        vm.recordLogs();
        before = gasleft();
        vm.prank(KEEPERHUB);
        g.performUpkeep{gas: KH_GAS}(data);
        uint256 writeGas = before - gasleft();
        if (writeGas > log.maxWriteGas) log.maxWriteGas = writeGas;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(g) && logs[i].topics[0] == REFUSED) {
                ++log.refused;
                console2.log(
                    "  REFUSED kind, account", uint256(logs[i].topics[2]), address(uint160(uint256(logs[i].topics[1])))
                );
                console2.logBytes4(abi.decode(logs[i].data, (bytes4)));
                _why(moves, address(uint160(uint256(logs[i].topics[1]))), uint8(uint256(logs[i].topics[2])));
            }
        }
        console2.log("  read gas, write gas, bytes", readGas, writeGas, data.length);
        ++log.writes;
        log.moves += sent;
    }

    /// Runs a refused move again, as the Guard, to log its full revert data and its args.
    function _why(GooseGuard.Move[] memory moves, address a, uint8 kind) internal {
        for (uint256 i; i < moves.length; ++i) {
            if (moves[i].account != a || moves[i].kind != kind) continue;
            for (uint256 j; j < moves[i].args.length; ++j) {
                console2.log("    arg", moves[i].args[j]);
            }
            uint256 snap = vm.snapshotState();
            vm.prank(address(g));
            try g.run(moves[i]) {
                console2.log("    runs now");
            } catch (bytes memory err) {
                console2.logBytes(err);
            }
            vm.revertToState(snap);
        }
    }

    /// KeeperHub's 10-minute round: read, write, read, write; then the clock moves on.
    function _round(RoundLog memory log) internal returns (uint256 sent) {
        sent = _readWrite(log);
        sent += _readWrite(log);
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        vm.roll(block.number + 300);
    }

    // ================================================================== accounts

    function _hf(address a) internal view returns (uint256) {
        return SPOKE.getUserAccountData(a).healthFactor;
    }

    function _rescueAt(address a) internal view returns (uint32) {
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        return acc.rescueAt;
    }

    function _assertBack(address a, string memory name) internal view {
        (uint256 line, uint256 target) = g.linesOf(a);
        uint256 hf = _hf(a);
        console2.log(name, "health after", hf);
        assertGe(hf, line, string.concat(name, ": still under the line"));
        assertLe(hf, target + 0.01e18, string.concat(name, ": past the target plus 0.01"));
    }

    /// An account backed by AAPLc and NVDAc at health `hf`, with no cash.
    function _twoStocks(string memory name, uint256 hf) internal returns (address a) {
        a = _newJawAccount(name);
        _backWith(a, AAPL, 2e8);
        _backWith(a, 5, 4e8);
        _drawTo(a, hf);
        deal(address(USDC), a, 0);
    }

    // ================================================================== helpers

    function _pack(uint16[7] memory w) internal pure returns (uint112 mix) {
        for (uint256 r; r < 7; ++r) {
            mix |= uint112(w[r]) << uint112(16 * r);
        }
    }

    function _offBuyBand(uint256 r) internal view returns (bool) {
        return planner.poolPrice(r) * 1e4 > _price(r) * (1e4 + g.TIGHT_BPS());
    }

    function _price(uint256 r) internal view returns (uint256) {
        return IOracleLike(0xaBaf048fD7675Ea34a84332371ffd5D55E322A47).getReservePrice(r);
    }
}

interface IOracleLike {
    function getReservePrice(uint256 reserveId) external view returns (uint256);
}

interface ISpokeRepay {
    function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
}
