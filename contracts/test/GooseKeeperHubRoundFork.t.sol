// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GoosePlanner} from "../src/GoosePlanner.sol";
import {IGooseGuard} from "../src/planner/PlanBase.sol";
import {ProtectPlanner} from "../src/planner/ProtectPlanner.sol";
import {TradePlanner} from "../src/planner/TradePlanner.sol";
import {CashPlanner} from "../src/planner/CashPlanner.sol";
import {IAeroPool, IAeroRouter} from "../src/IProtocols.sol";
import {PlannerForkBase} from "./PlannerForkBase.sol";

/// Build step 11: KeeperHub's rounds end to end (spec §14 item 15). Every 10 minutes a read of the Planner, a write
/// of the Guard at 5.4M, twice. A crash moves Aave's price AND the pool together (a real swap pushes the pool to the
/// new price), so sales meet the pool they would meet live.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseKeeperHubRoundForkTest -vv
contract GooseKeeperHubRoundForkTest is PlannerForkBase {
    uint256 constant NVDA = 5;
    address constant ORACLE = 0xaBaf048fD7675Ea34a84332371ffd5D55E322A47;

    // ================================================================== prices

    /// Aave's price for stock r becomes `price` (8 decimals), and a real swap pushes its pool to the same price.
    function _moveTo(uint256 r, uint256 price) internal {
        vm.mockCall(ORACLE, abi.encodeWithSignature("getReservePrice(uint256)", r), abi.encode(price));
        _poolTo(r, price);
    }

    /// Arbitrage: a real swap moves stock r's pool to `price`, selling the stock into it when the pool is above, and
    /// buying it with USDC when the pool is below (as after Protect's own sales). Stops at that price.
    function _poolTo(uint256 r, uint256 price) internal {
        address pool = AERO_FACTORY.getPool(STOCKS[r], address(USDC), 10);
        (uint160 now_,,,,,) = IAeroPool(pool).slot0();
        uint160 target = _sqrtPriceOf(price);
        if (now_ == target) return;
        // USDC is token0: selling the stock raises the square-root price (the share price falls), buying lowers it.
        bool sell = target > now_;
        address tokenIn = sell ? STOCKS[r] : address(USDC);
        uint256 amountIn = sell ? 1e14 : 1e13;
        deal(tokenIn, address(this), amountIn);
        IERC20Like(tokenIn).approve(ROUTER, type(uint256).max);
        IAeroRouter(ROUTER).exactInputSingle(
            IAeroRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: sell ? address(USDC) : STOCKS[r],
                tickSpacing: 10,
                recipient: address(this),
                deadline: vm.getBlockTimestamp(),
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: target
            })
        );
    }

    /// The pool's square-root price for `price` USDC a share, the inverse of JobBase.priceOf with USDC as token0.
    function _sqrtPriceOf(uint256 price) internal pure returns (uint160) {
        uint256 q = _sqrt(price * 1e10); // √(raw USDC a raw share) × 1e10
        return uint160((uint256(1) << 96) * 1e10 / q);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /// KeeperHub's round with arbitrage before each read: the fork has almost no liquidity this far from the live
    /// price, so without it Protect's own sales leave the pool more than 1% under Aave's price and the next sale waits.
    function _arbRound(RoundLog memory log, uint256 price) internal {
        _poolTo(NVDA, price);
        _readWrite(log);
        _poolTo(NVDA, price);
        _readWrite(log);
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        vm.roll(block.number + 300);
    }

    // ================================================================== accounts

    /// An account backed by 2 NVDAc at health `hf`, with Protect and Protect · sell on. With savings, the credit taken
    /// as cash sits in savings (as Earn with stocks does), so Protect repays; without, only a sale can help.
    function _owing(string memory name, uint256 hf, bool savings) internal returns (address a) {
        a = _newJawAccount(name);
        _backWith(a, NVDA, 2e8);
        uint256 credit = _drawTo(a, hf);
        if (savings) _save(a, credit);
        else deal(address(USDC), a, 0);
        _protectOn(a);
        _sellOn(a);
    }

    // ================================================================== a crash

    /// Twenty accounts from health 1.06 to 1.35, half with savings; NVDAc falls 2% a round for ten rounds (−18%), the
    /// pool with it, and arbitrage brings the pool back to Aave's price before each write (live, Protect's own sales
    /// push it down). Protect must keep every account above 1 (where Aave itself would sell) throughout, and bring each
    /// back to its line within three calm rounds after.
    function test_a_crash_across_twenty_accounts() public {
        address[] memory a = new address[](20);
        for (uint256 i; i < 20; ++i) {
            a[i] = _owing(string.concat("crash", vm.toString(i)), 1.06e18 + i * 0.015e18, i % 2 == 0);
        }
        uint256 price = _price(NVDA);
        RoundLog memory log;
        uint256 lowest = type(uint256).max;
        for (uint256 k; k < 10; ++k) {
            price = price * 98 / 100;
            vm.mockCall(ORACLE, abi.encodeWithSignature("getReservePrice(uint256)", NVDA), abi.encode(price));
            _arbRound(log, price);
            for (uint256 i; i < 20; ++i) {
                uint256 hf = _hf(a[i]);
                if (hf < lowest) lowest = hf;
            }
            console2.log("round, lowest health so far", k, lowest);
        }
        for (uint256 k; k < 3; ++k) {
            _arbRound(log, price);
        }
        console2.log("writes, moves, refused", log.writes, log.moves, log.refused);
        console2.log("most read gas, most write gas", log.maxReadGas, log.maxWriteGas);
        assertGe(lowest, 1e18, "an account fell under 1, where Aave itself sells");
        for (uint256 i; i < 20; ++i) {
            (uint256 line,) = g.linesOf(a[i]);
            if (_hf(a[i]) < line) _explain(a[i], string.concat("crash", vm.toString(i)));
        }
        for (uint256 i; i < 20; ++i) {
            (uint256 line,) = g.linesOf(a[i]);
            assertGe(_hf(a[i]), line, string.concat("crash", vm.toString(i), " still under its line"));
        }
        assertLe(log.maxWriteGas, KH_GAS, "a write took more than KeeperHub sends");
    }

    /// Why an account is still under its line: what the Planner would send it, and the pool against Aave's price.
    function _explain(address a, string memory name) internal view {
        console2.log(name, "health", _hf(a));
        console2.log("  pool, Aave", planner.poolPrice(NVDA), _price(NVDA));
        console2.log("  supplied NVDAc, debt", SPOKE.getUserSuppliedAssets(NVDA, a), SPOKE.getUserTotalDebt(7, a));
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        console2.log("  rescueAt, now", acc.rescueAt, vm.getBlockTimestamp());
        GoosePlanner.Move[] memory m = planner.movesOf(a);
        console2.log("  planned moves", m.length);
        for (uint256 i; i < m.length; ++i) {
            console2.log("    kind, legs", m[i].kind, m[i].args.length);
        }
    }

    // ================================================================== a weekend

    /// Aave's price held still while the pool drifts 1.5% down: the sale waits (the band), the cash repay still runs.
    function test_a_weekend_repays_and_holds_the_sale() public {
        address a = _owing("weekend", 1.02e18, true);
        _poolTo(NVDA, _price(NVDA) * 985 / 1000);
        RoundLog memory log;
        _round(log);
        console2.log("health after the round", _hf(a));
        assertEq(log.refused, 0, "a move was refused");
        assertGt(_hf(a), 1.03e18, "the cash repay didn't run");
    }

    // ================================================================== Rebalance pacing across rounds

    /// A drifted 50/50 mix trades in the first round. Once its one-hour session is over, the drift comes back, and the
    /// rounds inside the 20-hour gap propose no sale, so nothing is refused.
    function test_rebalance_trades_once_and_the_planner_respects_pacing() public {
        address a = _newJawAccount("mixer");
        deal(STOCKS[NVDA], a, 3e8);
        deal(STOCKS[AAPL], a, 1e8);
        uint16[7] memory w;
        w[AAPL] = 5000;
        w[NVDA] = 5000;
        vm.prank(a);
        g.setMix(_pack(w));
        _rebalanceOn(a);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 nvda = IERC20Like(STOCKS[NVDA]).balanceOf(a);
        RoundLog memory log;
        _round(log);
        uint256 afterFirst = IERC20Like(STOCKS[NVDA]).balanceOf(a);
        assertLt(afterFirst, nvda, "no rebalance in the first round");
        vm.warp(vm.getBlockTimestamp() + 1 hours); // the session is over
        deal(STOCKS[NVDA], a, afterFirst + 2e8); // the drift comes back
        for (uint256 k; k < 6; ++k) {
            _round(log);
        }
        assertEq(log.refused, 0, "a paced trade was sent and refused");
        assertEq(IERC20Like(STOCKS[NVDA]).balanceOf(a), afterFirst + 2e8, "it traded again inside the 20-hour gap");
        console2.log("next trade at, now", planner.nextTradeAt(a), vm.getBlockTimestamp());
    }

    // ================================================================== a Planner swap

    /// A second Planner on the same Guard runs the same accounts' grants: replacing the Planner needs no user action.
    function test_a_new_planner_runs_existing_grants() public {
        address a = _owing("swap", 1.02e18, true);
        IGooseGuard ig = IGooseGuard(address(g));
        planner = new GoosePlanner(ig, new ProtectPlanner(ig), new TradePlanner(ig), new CashPlanner(ig));
        RoundLog memory log;
        _round(log);
        assertEq(log.refused, 0, "refused");
        _assertBack(a, "swap");
    }

    // ================================================================== KeeperHub's second read

    /// If the second read sees the first write, it plans what's left and nothing repeats.
    function test_a_second_read_after_the_first_write_repeats_nothing() public {
        _owing("fresh", 1.02e18, true);
        RoundLog memory log;
        _readWrite(log);
        uint256 sent = _readWrite(log);
        assertEq(log.refused, 0, "refused");
        console2.log("moves in the second write", sent);
    }

    /// If the second read runs before the first write lands, it sends the same moves: each is refused, and the second
    /// write costs little (decision 11 changes the second read's input only if the live test shows this).
    function test_a_second_read_before_the_first_write_is_refused_cheaply() public {
        _owing("stale", 1.02e18, true);
        (, bytes memory first) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        (, bytes memory second) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        assertEq(keccak256(first), keccak256(second), "the two reads differ");
        vm.prank(KEEPERHUB);
        g.performUpkeep{gas: KH_GAS}(first);
        uint256 before = gasleft();
        vm.prank(KEEPERHUB);
        g.performUpkeep{gas: KH_GAS}(second);
        uint256 wasted = before - gasleft();
        console2.log("gas of the stale second write", wasted);
        assertLt(wasted, 1_000_000, "a stale second write is costly");
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}
