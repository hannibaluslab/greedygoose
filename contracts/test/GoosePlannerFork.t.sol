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
import {IJustaPermissionManager as PM, ISpoke, IERC20Lite} from "./IJustaPermissionManager.sol";
import {ISpokeRepay, PlannerForkBase} from "./PlannerForkBase.sol";

/// GoosePlanner end to end on a Base fork: KeeperHub's round (`checkUpkeep` → `performUpkeep` on a real GooseGuard as
/// KeeperHub's wallet, 5.4M gas, twice), JAW's manager, Aave V4 and V3, and the real pools. Stocks are StockDoubles
/// with the hub's and each pool's real balances.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GoosePlannerForkTest -vv
/// (optionally FORK_BLOCK=<recent block> to pin the fork; the 500-member test needs --gas-limit 4000000000)
contract GoosePlannerForkTest is PlannerForkBase {
    // ================================================================== Protect

    /// Accounts under their line, each needing a different Protect move, come back between their line and target + 0.01
    /// in KeeperHub's rounds, with nothing refused; a healthy account is left alone.
    function test_a_protect_round_brings_every_account_back_between_line_and_target() public {
        // Savings repay, at 1.02.
        address savings = _newJawAccount("savings");
        _save(savings, _openCreditAt(savings, 10e8, 1.02e18));
        _protectOn(savings);
        // Wallet repay, at 1.015: the credit stays as cash in the wallet.
        address wallet = _newJawAccount("wallet");
        _openCreditAt(wallet, 10e8, 1.015e18);
        _protectOn(wallet);
        // Sale only, NVDAc, no cash.
        address sale = _newJawAccount("sale");
        _openCreditAt(sale, 10e8, 1.02e18);
        deal(address(USDC), sale, 0);
        _sellOn(sale);
        // Both, two stocks: $20 of savings can't reach the target, so a repay and a sale in one write.
        address both = _twoStocks("both", 1.01e18);
        deal(address(USDC), both, 20e6);
        _save(both, 20e6);
        _protectOn(both);
        _sellOn(both);
        // Healthy, own line 1.05 / target 1.20.
        address healthy = _newJawAccount("healthy");
        _openCreditAt(healthy, 10e8, 1.5e18);
        _protectOn(healthy);
        _sellOn(healthy);
        vm.prank(healthy);
        g.setProtect(10500, 12000);
        uint256 healthyDebt = SPOKE.getUserTotalDebt(7, healthy);

        RoundLog memory log;
        for (uint256 i; i < 4; ++i) {
            console2.log("round", i);
            if (_round(log) == 0) break;
        }
        console2.log("writes, moves", log.writes, log.moves);
        console2.log("max read gas, max write gas", log.maxReadGas, log.maxWriteGas);
        assertEq(log.refused, 0, "the Guard refused a planned move");
        _assertBack(savings, "savings");
        _assertBack(wallet, "wallet");
        _assertBack(sale, "sale");
        _assertBack(both, "both");
        assertGe(SPOKE.getUserTotalDebt(7, healthy), healthyDebt, "a healthy account was repaid");
        assertEq(SPOKE.getUserSuppliedAssets(5, healthy), 10e8, "a healthy account's stock was sold");
        assertEq(_rescueAt(savings) | _rescueAt(wallet) | _rescueAt(sale) | _rescueAt(both), 0, "a rescue is still on");
        assertGe(USDC.balanceOf(wallet), 1e6, "the wallet's dollar went");
        assertLe(log.maxWriteGas, KH_GAS, "a write took more than KeeperHub sends");
    }

    /// The "both" account's first write carries its repay and its sale, the repay first.
    function test_a_repay_and_a_sale_go_in_one_write() public {
        address both = _twoStocks("both", 1.01e18);
        deal(address(USDC), both, 20e6);
        _save(both, 20e6);
        _protectOn(both);
        _sellOn(both);
        GoosePlanner.Plan memory plan = planner.planOf(both);
        assertEq(uint8(plan.action), uint8(GoosePlanner.Action.Repay), "planOf: not a repay");
        assertEq(plan.amount, 20e6 - 1, "planOf: not the savings");
        PlanBase.Move[] memory m = planner.movesOf(both);
        assertEq(m.length, 2, "two moves");
        assertEq(m[0].kind, 1, "repay first");
        assertEq(m[1].kind, 2, "then the sale");
        (bool need, bytes memory data) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        assertTrue(need);
        GooseGuard.Move[] memory sent = abi.decode(data, (GooseGuard.Move[]));
        assertEq(sent.length, 2);
        RoundLog memory log;
        _readWrite(log);
        assertEq(log.refused, 0, "refused");
        _assertBack(both, "both");
    }

    /// A seven-stock account: the Planner's repay and sale are right (each runs, back between the line and the
    /// target), but each needs more gas than the Guard's frame gives it. Aave's account read costs about 400k for seven
    /// stocks, the Guard reads it before and after, and every withdraw reads it again. Logged against `capOf`; the
    /// moves run here through `run` called as the Guard, with no cap.
    function test_seven_stock_moves_and_the_guard_caps() public {
        address a = _newJawAccount("seven");
        _backWithAllStocks(a, 1e8);
        _drawTo(a, 1.01e18);
        deal(address(USDC), a, 20e6);
        _save(a, 20e6);
        _protectOn(a);
        _sellOn(a);
        uint256 g0 = gasleft();
        SPOKE.getUserAccountData(a);
        console2.log("Aave account read, seven stocks", g0 - gasleft());
        PlanBase.Move[] memory m = planner.movesOf(a);
        assertEq(m.length, 2, "repay and sale");
        for (uint256 i; i < m.length; ++i) {
            GooseGuard.Move memory mv = GooseGuard.Move(m[i].account, m[i].kind, m[i].args);
            g0 = gasleft();
            vm.prank(address(g));
            g.run(mv);
            uint256 used = g0 - gasleft();
            console2.log("kind, legs", mv.kind, mv.args.length);
            console2.log("  gas used, Guard cap", used, g.capOf(mv.kind, mv.args));
        }
        _assertBack(a, "seven");
    }

    /// A member whose registered permission is junk can't stop the round: the others are still planned.
    function test_a_junk_permission_does_not_stop_the_others() public {
        address junk = _newJawAccount("junk");
        _openCreditAt(junk, 10e8, 1.01e18);
        deal(address(USDC), junk, 0);
        // Head words the Guard checks are right; the offsets after them point nowhere, so decoding reverts.
        uint48 now_ = uint48(vm.getBlockTimestamp());
        bytes memory bad = abi.encode(
            uint256(0x20),
            junk,
            address(g),
            uint256(now_ - 60),
            uint256(now_ + 1 days),
            uint256(1),
            type(uint64).max,
            type(uint64).max
        );
        // The Guard refuses them (the manager can't have approved what it can't decode); a manager that said yes
        // anyway still mustn't stop the Planner.
        vm.expectRevert(GooseGuard.NotApproved.selector);
        vm.prank(junk);
        g.register(2, bad);
        vm.mockCall(address(MANAGER), abi.encodePacked(PM.isApproved.selector, bad), abi.encode(true));
        vm.prank(junk);
        g.register(2, bad);
        vm.clearMockedCalls();
        address good = _newJawAccount("good");
        _save(good, _openCreditAt(good, 10e8, 1.02e18));
        _protectOn(good);

        (bool need, bytes memory data) = planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        assertTrue(need, "nothing planned");
        GooseGuard.Move[] memory moves = abi.decode(data, (GooseGuard.Move[]));
        assertEq(moves.length, 1);
        assertEq(moves[0].account, good);
        assertEq(planner.movesOf(junk).length, 0, "the junk account got a move");
    }

    /// A finished rescue ends with END when the account repaid by hand outside the app.
    function test_a_finished_rescue_is_ended() public {
        address a = _newJawAccount("rescue");
        uint256 credit = _openCreditAt(a, 10e8, 1.02e18);
        deal(address(USDC), a, credit / 50); // only a little cash: the repay lands short of the target, so a rescue starts
        _save(a, credit / 50);
        _protectOn(a);
        RoundLog memory log;
        _readWrite(log);
        assertGt(_rescueAt(a), 0, "no rescue");
        // The user repays the rest by hand, outside the app (no endRescue in the batch).
        deal(address(USDC), a, credit);
        vm.startPrank(a);
        USDC.approve(address(SPOKE), credit / 4);
        ISpokeRepay(address(SPOKE)).repay(7, credit / 4, a);
        vm.stopPrank();
        PlanBase.Move[] memory m = planner.movesOf(a);
        assertEq(m.length, 1);
        assertEq(m[0].kind, 5, "not END");
        _readWrite(log);
        assertEq(log.refused, 0);
        assertEq(_rescueAt(a), 0, "the rescue is still on");
    }

    // ================================================================== Save, Turn into cash, Rebalance, top-ups

    /// One account of each: everything planned runs, and the results match each rule.
    function test_save_convert_trade_and_top_up_run_unrefused() public {
        address saver = _newJawAccount("saver");
        deal(address(USDC), saver, 250e6);
        _saveOn(saver);

        address coins = _newJawAccount("coins");
        _entryOn(coins);
        deal(USDT, coins, 300e6);
        deal(USDE, coins, 300e18);
        deal(USDS, coins, 300e18);
        deal(DAI, coins, 50e18);
        deal(EURC, coins, 300e6);

        address mixer = _newJawAccount("mixer");
        deal(NVDAC, mixer, 3e8);
        deal(STOCKS[AAPL], mixer, 1e8);
        uint16[7] memory w;
        w[AAPL] = 5000;
        w[5] = 5000;
        vm.prank(mixer);
        g.setMix(_pack(w));
        _rebalanceOn(mixer);

        address topper = _newJawAccount("topper");
        uint16[7] memory w2;
        w2[AAPL] = 6000;
        w2[5] = 4000;
        vm.startPrank(topper);
        g.setMix(_pack(w2));
        g.setTopUps(true, 50e6);
        vm.stopPrank();
        _rebalanceOn(topper);
        _saveOn(topper);
        deal(address(USDC), topper, 451e6);
        vm.warp(vm.getBlockTimestamp() + 1);

        RoundLog memory log;
        for (uint256 i; i < 4; ++i) {
            console2.log("round", i);
            if (_round(log) == 0) break;
        }
        console2.log("writes, moves", log.writes, log.moves);
        console2.log("max read gas, max write gas", log.maxReadGas, log.maxWriteGas);
        assertEq(log.refused, 0, "the Guard refused a planned move");
        assertEq(USDC.balanceOf(saver), 1e6, "save left more than the dollar");
        assertEq(IERC20Lite(USDT).balanceOf(coins), 0, "USDT left");
        assertEq(IERC20Lite(USDE).balanceOf(coins), 0, "USDe left");
        assertEq(IERC20Lite(USDS).balanceOf(coins), 0, "USDS left");
        assertEq(IERC20Lite(EURC).balanceOf(coins), 0, "EURC left");
        console2.log("DAI left (shallow pool)", IERC20Lite(DAI).balanceOf(coins));
        uint256 aapl = IERC20Lite(STOCKS[AAPL]).balanceOf(mixer) * _price(AAPL);
        uint256 nvda = IERC20Lite(NVDAC).balanceOf(mixer) * _price(5);
        console2.log("mixer AAPL share, BPS", aapl * 1e4 / (aapl + nvda));
        assertGt(aapl * 1e4 / (aapl + nvda), 4500, "the mix didn't come back toward 50/50");
        assertGe(AUSDC.balanceOf(topper) + 2, 50e6, "Keep not filled");
        // A stock whose pool sits above the Guard's buy band (Aave + 0.40%) keeps its share of the top-up waiting in
        // the wallet; the rest goes in.
        uint256 waiting = 1e6 + 4e6;
        if (_offBuyBand(AAPL)) waiting += 240e6;
        if (_offBuyBand(5)) waiting += 160e6;
        console2.log("top-up left in the wallet", USDC.balanceOf(topper));
        assertLe(USDC.balanceOf(topper), waiting, "the top-up didn't go in");
        assertGt(IERC20Lite(STOCKS[AAPL]).balanceOf(topper), 0, "no AAPLc bought");
    }

    /// A drifted mix waits while the credit's health is under 1.10 (today's Rebalancer rule), and trades above it.
    function test_band_trades_wait_under_health_1_10() public {
        address a = _newJawAccount("owing-mixer");
        _openCreditAt(a, 10e8, 1.08e18);
        deal(address(USDC), a, 0);
        deal(NVDAC, a, 3e8);
        deal(STOCKS[AAPL], a, 1e8);
        uint16[7] memory w;
        w[AAPL] = 5000;
        w[5] = 5000;
        vm.prank(a);
        g.setMix(_pack(w));
        _rebalanceOn(a);
        assertEq(planner.movesOf(a).length, 0, "traded under 1.10");
        // Repay a third of the credit by hand: health well above 1.10, and the band trade comes back.
        uint256 debt = SPOKE.getUserTotalDebt(7, a);
        deal(address(USDC), a, debt / 3);
        vm.startPrank(a);
        USDC.approve(address(SPOKE), debt / 3);
        ISpokeRepay(address(SPOKE)).repay(7, debt / 3, a);
        vm.stopPrank();
        PlanBase.Move[] memory m = planner.movesOf(a);
        assertEq(m.length, 1);
        assertEq(m[0].kind, 3, "no trade above 1.10");
    }

    // ================================================================== pool depth, checked against real swaps

    /// The tick maths matches every pool: TickMath brackets each pool's price, and the known edges hold.
    function test_tick_maths_brackets_every_live_pool() public view {
        assertEq(PoolDepth.sqrtAt(0), 1 << 96);
        assertEq(PoolDepth.sqrtAt(-887272), 4295128739);
        assertEq(PoolDepth.sqrtAt(887272), 1461446703485210103287273052203988822378723970342);
        address[11] memory pools;
        for (uint256 r; r < 7; ++r) {
            pools[r] = planner.pool(r);
        }
        pools[7] = 0xa41Bc0AFfbA7Fd420d186b84899d7ab2aC57fcD1;
        pools[8] = 0xedAf6Ca46FB852D4AB0A2e9449d267cf03213F05;
        pools[9] = 0xC18F50d6A832f12F6DcAaeEe8D0c87A65B96787E;
        pools[10] = 0xc5E51044eB7318950B1aFb044FccFb25782C48c1;
        for (uint256 i; i < 11; ++i) {
            (uint160 sqrtP, int24 tick) = IClPool(pools[i]).slot0();
            assertLe(PoolDepth.sqrtAt(tick), sqrtP, "price under its tick");
            assertGt(PoolDepth.sqrtAt(tick + 1), sqrtP, "price past the next tick");
        }
    }

    /// For each stock, a Rebalance-sized sale and buy at the depth the Planner reads fill at the 0.5% swap floor on the
    /// real pool. Logged: each pool's depth in dollars.
    function test_stock_depth_fills_at_the_swap_floor() public {
        for (uint256 r; r < 7; ++r) {
            uint256 price = _price(r);
            uint256 spot = planner.poolPrice(r);
            uint256 sellDepth = planner.stockDepth(r, price, false, 50, type(uint256).max);
            uint256 buyDepth = planner.stockDepth(r, price, true, 50, type(uint256).max);
            console2.log("stock", r);
            console2.log("  pool vs Aave, BPS from 10000", spot * 1e4 / price);
            console2.log("  sale depth $, buy depth $", sellDepth * price / 1e18, buyDepth / 1e6);
            uint256 snap = vm.snapshotState();
            if (sellDepth > 0) _sellStock(r, sellDepth, sellDepth * price * 9950 / 1e14);
            vm.revertToState(snap);
            if (buyDepth > 0) _buyStock(r, buyDepth, buyDepth * 1e10 * 9950 / (price * 1e4));
            vm.revertToState(snap);
        }
    }

    /// Each coin's depth fills at the 0.5% floor on its real venue.
    function test_coin_depth_fills_at_the_floor() public {
        address[5] memory coins = [USDT, USDE, USDS, DAI, EURC];
        uint256[5] memory big = [uint256(1_000_000e6), 1_000_000e18, 1_000_000e18, 1_000_000e18, 1_000_000e6];
        for (uint256 k; k < 5; ++k) {
            uint256 depth = cash.convertDepth(k, big[k]);
            console2.log("coin", k, "depth (raw)", depth);
            if (depth == 0) continue;
            uint256 snap = vm.snapshotState();
            _convert(k, coins[k], depth);
            vm.revertToState(snap);
        }
    }

    function _sellStock(uint256 r, uint256 shares, uint256 minOut) internal {
        deal(STOCKS[r], address(this), shares);
        IERC20Lite(STOCKS[r]).approve(ROUTER, shares);
        IAeroRouter(ROUTER)
            .exactInputSingle(
                IAeroRouter.ExactInputSingleParams(
                    STOCKS[r], address(USDC), 10, address(this), block.timestamp, shares, minOut, 0
                )
            );
    }

    function _buyStock(uint256 r, uint256 usdcIn, uint256 minShares) internal {
        deal(address(USDC), address(this), usdcIn);
        USDC.approve(ROUTER, usdcIn);
        IAeroRouter(ROUTER)
            .exactInputSingle(
                IAeroRouter.ExactInputSingleParams(
                    address(USDC), STOCKS[r], 10, address(this), block.timestamp, usdcIn, minShares, 0
                )
            );
    }

    function _convert(uint256 k, address coin, uint256 amountIn) internal {
        deal(coin, address(this), amountIn);
        uint256 rate = k == 4 ? cash.eurUsd() : 1e8;
        uint256 scale = k == 0 || k == 4 ? 1 : 1e12;
        uint256 minOut = (amountIn * rate * 9950 - 1) / (scale * 1e12) + 1;
        if (k == 1 || k == 3) {
            IERC20Lite(coin).approve(UNISWAP_ROUTER, amountIn);
            IUniswapRouter(UNISWAP_ROUTER)
                .exactInputSingle(
                    IUniswapRouter.ExactInputSingleParams(
                        coin, address(USDC), k == 1 ? 500 : 100, address(this), amountIn, minOut, 0
                    )
                );
        } else if (k == 2) {
            IERC20Lite(coin).approve(PSM3, amountIn);
            IPsm3(PSM3).swapExactIn(coin, address(USDC), amountIn, minOut, address(this), 0);
        } else {
            IERC20Lite(coin).approve(AERODROME_V1_ROUTER, amountIn);
            IAeroRouter(AERODROME_V1_ROUTER)
                .exactInputSingle(
                    IAeroRouter.ExactInputSingleParams(
                        coin, address(USDC), 1, address(this), block.timestamp, amountIn, minOut, 0
                    )
                );
        }
    }

    // ================================================================== read gas and coverage

    /// Read gas with 10 and 100 members that all owe (the costly case), and how many one read scans.
    function test_read_gas_at_10_and_100_members() public {
        _members(10);
        _measure(10);
        _members(90);
        _measure(100);
    }

    /// 500 owing members: read gas, members one read scans, and the rounds until every member was scanned. Its 1,000
    /// registrations need more than Forge's default test gas (foundry.toml).
    function test_read_gas_and_coverage_at_500_members() public {
        _members(500);
        uint256 per = _measure(500);
        uint256 round = vm.getBlockTimestamp() / 600;
        bool[] memory seen = new bool[](500);
        uint256 covered;
        uint256 rounds;
        for (; covered < 500 && rounds < 200; ++rounds) {
            (uint256 start, uint256 scanned,) = planner.scanOf{gas: READ_CAP}(round + rounds, 0, 1);
            for (uint256 j; j < scanned; ++j) {
                uint256 k = (start + j) % 500;
                if (!seen[k]) {
                    seen[k] = true;
                    ++covered;
                }
            }
        }
        console2.log("members scanned per read", per);
        console2.log("rounds until all 500 were scanned", rounds);
        assertEq(covered, 500, "a member was never scanned");
        assertGe(per, 40, "too few members per read");
    }

    /// `n` more members, each owing at health 1.4 with Protect and Protect · sell on.
    function _members(uint256 n) internal {
        uint256 have = g.membersLength();
        for (uint256 i; i < n; ++i) {
            address a = _newJawAccount(string.concat("m", vm.toString(have + i)));
            _openCreditAt(a, 1e8, 1.4e18);
            _protectOn(a);
            _sellOn(a);
        }
    }

    function _measure(uint256 n) internal view returns (uint256 scanned) {
        uint256 before = gasleft();
        planner.checkUpkeep{gas: READ_CAP}(abi.encode(uint256(0), uint256(1)));
        uint256 readGas = before - gasleft();
        (, scanned,) = planner.scanOf{gas: READ_CAP}(vm.getBlockTimestamp() / 600, 0, 1);
        console2.log("members", n);
        console2.log("  checkUpkeep gas", readGas);
        console2.log("  members one read scans", scanned);
    }

    // ================================================================== probe

    function test_probe_returns_the_gas_at_entry_and_the_filler() public view {
        (uint256 gasAtEntry, bytes memory filler) = planner.probe{gas: 1_000_000}(4096);
        assertGt(gasAtEntry, 900_000);
        assertLe(gasAtEntry, 1_000_000);
        assertEq(filler.length, 4096);
    }
}
