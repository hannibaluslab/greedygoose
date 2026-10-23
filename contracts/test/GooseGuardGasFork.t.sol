// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {GuardForkBase} from "./GuardForkBase.sol";

/// Build step 6 (spec-final-v2.md §14, item 3): the cold worst case of every kind, sent as KeeperHub sends it (5.4M),
/// with each move's own frame (`run`, what `capOf` bounds) asserted at most 80% of its cap. "Cold": each measured call
/// is its own transaction (forge's `isolate = true`), with fresh access lists and original values, as a KeeperHub
/// write gets (GuardForkBase._coldGas). The worst position is an account backed by all seven stocks, since every
/// health reading and every withdraw's health check walks each collateral, each a cold Chainlink read.
///
/// Each test logs one row: kind, legs (args), frame gas, whole-perform gas, cap, frame / cap. `test_gas_table` runs
/// every case and prints the table.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardGasForkTest -vv
contract GooseGuardGasForkTest is GuardForkBase {
    /// Each of the seven stocks backing the credit, in USDC units: about $100k of borrowing power in all.
    uint256 constant BACKING = 20_000e6;

    struct Row {
        string name;
        uint8 kind;
        uint256 cap; // the Guard's cap for this move
        uint256 frame;
        uint256 perform;
        bytes4 reason;
    }

    Row[] rows;

    function setUp() public {
        _setUpGuard();
    }

    // ================================================================== the cases

    /// An account backed by all seven stocks, drawn to health `hf`, every agent on.
    function _sevenStockAccount(string memory name, uint256 hf) internal returns (address a) {
        return _account(name, ALL_STOCKS, hf);
    }

    /// An account backed by the stocks in `mask`, drawn to health `hf`, every agent on.
    function _account(string memory name, uint256 mask, uint256 hf) internal returns (address a) {
        a = _newJawAccount(name);
        _backMask(a, mask, BACKING);
        _drawTo(a, hf);
        _allOn(a);
    }

    /// One slice of NVDAc, 2.5% of the debt, from an account backed by all seven stocks: the base of the sale's cap.
    function _caseSaleOneSlice() internal returns (Row memory) {
        address a = _sevenStockAccount("one", 1.025e18);
        return _row("SELL, 1 slice", _move(a, SELL, _a1(_leg(NVDA, _slice(a, NVDA, 250)))));
    }

    /// One sale leg of AAPLc in a drifted two-stock mix and the buy of NVDAc it funds: the base of the trade's cap.
    function _caseTradeOneLeg() internal returns (Row memory) {
        address a = _sevenStockAccount("trade1", 1.5e18);
        uint16[7] memory w;
        w[AAPL] = 5000;
        w[NVDA] = 5000;
        deal(STOCKS[AAPL], a, _sharesFor(AAPL, 1_500e6));
        deal(STOCKS[NVDA], a, _sharesFor(NVDA, 500e6));
        vm.prank(a);
        g.setMix(_pack(w));
        vm.warp(vm.getBlockTimestamp() + 1);
        // A sale must buy with its floor (GG-06): the smallest move that sells is a sale and a buy.
        uint256 sell = _sharesFor(AAPL, 400e6);
        uint256 floor = sell * _price(AAPL) * 9950 / 1e14;
        return _row("TRADE, 1 sale + 1 buy", _move(a, TRADE, _a3(0, _leg(AAPL, sell), _buy(NVDA, floor))));
    }

    /// One slice of each of the seven stocks, each 2% of the debt: every withdraw keeps health above 1 from 1.025.
    function _caseSaleSevenStocks() internal returns (Row memory) {
        address a = _sevenStockAccount("seven", 1.025e18);
        uint256[] memory legs = new uint256[](7);
        for (uint256 r; r < 7; ++r) {
            legs[r] = _leg(r, _slice(a, r, 200));
        }
        return _row("SELL, 7 stocks x 1 slice", _move(a, SELL, legs));
    }

    /// Six slices of NVDAc, each 2.5% of the debt, from an account backed by all seven stocks.
    function _caseSaleSixSlices() internal returns (Row memory) {
        address a = _sevenStockAccount("six", 1.025e18);
        uint256[] memory legs = new uint256[](6);
        uint256 slice = _slice(a, NVDA, 250);
        for (uint256 i; i < 6; ++i) {
            legs[i] = _leg(NVDA, slice);
        }
        return _row("SELL, 6 slices of NVDAc", _move(a, SELL, legs));
    }

    /// A top-up bought into all seven stocks of an equal mix that's on target, from an account that also owes (so
    /// the top-up reads health over seven collaterals).
    function _caseTopUpSevenBuys() internal returns (Row memory) {
        address a = _sevenStockAccount("topup", 1.5e18);
        uint16[7] memory w = [uint16(1428), 1428, 1428, 1428, 1428, 1428, 1432];
        for (uint256 r; r < 7; ++r) {
            deal(STOCKS[r], a, _sharesFor(r, 1_000e6));
        }
        vm.startPrank(a);
        g.setMix(_pack(w));
        g.setTopUps(true, 0);
        vm.stopPrank();
        uint256 invest = 1_400e6;
        deal(address(USDC), a, invest + 1e6);
        uint256[] memory args = new uint256[](8);
        args[0] = invest;
        for (uint256 r; r < 7; ++r) {
            args[r + 1] = _buy(r, invest * w[r] / 1e4 - 1e6);
        }
        return _row("TRADE, top-up 7 buys", _move(a, TRADE, args));
    }

    /// A drifted equal mix: sell AAPLc, METAc and MSFTc (over target), buy AMZNc, GOOGLc, NVDAc and TSLAc with the
    /// sales' floors. The first sale of a session writes the pacing slot.
    function _caseRebalanceSevenLegs() internal returns (Row memory) {
        address a = _sevenStockAccount("rebalance", 1.5e18);
        uint16[7] memory w = [uint16(1428), 1428, 1428, 1428, 1428, 1428, 1432];
        uint256[7] memory usd = [uint256(1_500e6), 600e6, 600e6, 1_500e6, 1_500e6, 600e6, 600e6];
        for (uint256 r; r < 7; ++r) {
            deal(STOCKS[r], a, _sharesFor(r, usd[r]));
        }
        vm.prank(a);
        g.setMix(_pack(w));
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256[] memory args = new uint256[](8);
        uint8[3] memory sells = [0, 3, 4];
        uint8[4] memory buys = [1, 2, 5, 6];
        uint256 floors;
        for (uint256 i; i < 3; ++i) {
            uint256 shares = _sharesFor(sells[i], 400e6);
            args[1 + i] = _leg(sells[i], shares);
            floors += shares * _price(sells[i]) * 9950 / 1e14;
        }
        // The four buys spend exactly the sales' floors (GG-06), the last one the rounding.
        for (uint256 i; i < 4; ++i) {
            args[4 + i] = _buy(buys[i], i < 3 ? floors / 4 : floors - 3 * (floors / 4));
        }
        return _row("TRADE, 3 sales + 4 buys", _move(a, TRADE, args));
    }

    /// A repay from the wallet and from savings, from an account backed by all seven stocks at 1.02, to land at 1.10.
    function _repayAccount(string memory name) internal returns (address a, uint256[] memory args) {
        return _repayAccount(name, ALL_STOCKS);
    }

    function _repayAccount(string memory name, uint256 mask) internal returns (address a, uint256[] memory args) {
        a = _account(name, mask, 1.02e18);
        uint256 cash = _bal(address(USDC), a);
        _save(a, cash - 200e6); // the credit taken sits in savings; $200 stays in the wallet
        uint256 repay = _repayTo(a, 1.10e18);
        args = _a2(100e6, repay - 100e6);
    }

    function _caseRepay() internal returns (Row memory) {
        (address a, uint256[] memory args) = _repayAccount("repay");
        return _row("REPAY, wallet + savings", _move(a, REPAY, args));
    }

    /// The same repay from an account backed by NVDAc alone, for comparison.
    function _caseRepayOneStock() internal returns (Row memory) {
        (address a, uint256[] memory args) = _repayAccount("repay1", 1 << NVDA);
        return _row("REPAY, 1-stock account", _move(a, REPAY, args));
    }

    function _caseConvert(uint256 k) internal returns (Row memory) {
        address[5] memory coins = [USDT, USDE, USDS, DAI, EURC];
        string[5] memory names =
            ["CONVERT USDT (Aero v1)", "CONVERT USDe (Uniswap)", "CONVERT USDS (PSM3)", "CONVERT DAI (Uniswap)", "CONVERT EURC (Aero v1)"];
        address a = _newJawAccount(names[k]);
        _entryOn(a);
        // DAI's Uniswap pool is shallow (step0-facts.md): $1,000 fits its 0.5% floor.
        deal(coins[k], a, k == 0 || k == 4 ? 1_000e6 : 1_000e18);
        return _row(names[k], _move(a, CONVERT, _a2(k, type(uint128).max)));
    }

    /// Aave raises all seven collateral factors by 1% under new config keys: the refresh moves the account to all
    /// seven, the most it can write.
    function _caseRefresh() internal returns (Row memory) {
        address a = _sevenStockAccount("refresh", 1.02e18);
        for (uint256 r; r < 7; ++r) {
            _setCollateralFactor(r, _latestConfig(r).collateralFactor + 100);
        }
        return _row("REFRESH, 7 raised factors", _move(a, REFRESH, _a0()));
    }

    function _caseRefreshOneStock() internal returns (Row memory) {
        address a = _account("refresh1", 1 << NVDA, 1.02e18);
        _setCollateralFactor(NVDA, _latestConfig(NVDA).collateralFactor + 100);
        return _row("REFRESH, 1-stock account", _move(a, REFRESH, _a0()));
    }

    /// Save with top-ups on, so it also reads savings against Keep.
    function _caseSave() internal returns (Row memory) {
        address a = _newJawAccount("save");
        _saveOn(a);
        vm.prank(a);
        g.setTopUps(true, 5_000e6);
        deal(address(USDC), a, 1_000e6);
        return _row("SAVE, top-ups on", _move(a, SAVE, _a1(type(uint128).max)));
    }

    /// END's costliest path: a rescue still inside its 7 days, ended because the user repaid by hand back past the
    /// target without ending it, so END reads the debt and health. The rescue is started by a repay run uncapped.
    function _caseEnd(uint256 mask, string memory name) internal returns (Row memory) {
        (address a, uint256[] memory args) = _repayAccount(name, mask);
        args[1] = _repayTo(a, 1.06e18) - args[0]; // lands short of 1.12, so a rescue starts
        _runUncapped(_move(a, REPAY, args));
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        assertGt(acc.rescueAt, 0, "no rescue");
        uint256 more = _repayTo(a, 1.15e18);
        deal(address(USDC), a, more);
        vm.startPrank(a);
        USDC.approve(address(SPOKE), more);
        SPOKE.repay(USDC_RESERVE, more, a);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        return _row(name, _move(a, END, _a0()));
    }

    function _row(string memory name, GooseGuard.Move memory m) internal returns (Row memory row) {
        (uint256 frame, uint256 perform, bytes4 reason) = _coldGas(m);
        row = Row(name, m.kind, g.capOf(m.kind, m.args), frame, perform, reason);
        _print(row);
    }

    function _print(Row memory row) internal view {
        uint256 cap = row.cap;
        console2.log(
            string.concat(
                _pad(row.name, 28),
                " | frame ",
                _pad(vm.toString(row.frame), 9),
                " | perform ",
                _pad(vm.toString(row.perform), 9),
                " | cap ",
                _pad(vm.toString(cap), 9),
                " | frame/cap ",
                _pad(string.concat(vm.toString(row.frame * 100 / cap), "%"), 5),
                " | cap for 80% ",
                _pad(vm.toString((row.frame * 100 + 79) / 80), 8),
                " | at 5.4M: ",
                row.reason == bytes4(0) ? "ran" : string.concat("refused ", _name(row.reason))
            )
        );
    }

    function _name(bytes4 r) internal pure returns (string memory) {
        if (r == bytes4(0)) return "ran";
        if (r == GooseGuard.NotNeeded.selector) return "NotNeeded (tried)";
        if (r == OUT_OF_GAS) return "(out of gas)";
        if (r == EXECUTE_ERROR) return "ExecuteError (an inner call ran out of gas)";
        if (r == GooseGuard.NoGas.selector) return "NoGas";
        return vm.toString(abi.encodePacked(r));
    }

    function _assert80(Row memory row) internal view {
        uint256 cap = row.cap;
        assertLe(row.frame, cap * 80 / 100, string.concat(row.name, ": over 80% of its cap"));
    }

    function _pad(string memory s, uint256 n) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length >= n) return s;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = i < b.length ? b[i] : bytes1(" ");
        }
        return string(out);
    }

    // ================================================================== one test per kind

    function test_gas_a_sale_across_seven_stocks() public {
        _assert80(_caseSaleSevenStocks());
    }

    function test_gas_a_six_slice_sale() public {
        _assert80(_caseSaleSixSlices());
    }

    function test_gas_a_seven_leg_top_up() public {
        _assert80(_caseTopUpSevenBuys());
    }

    function test_gas_a_seven_leg_rebalance() public {
        _assert80(_caseRebalanceSevenLegs());
    }

    function test_gas_a_repay() public {
        _assert80(_caseRepay());
    }

    function test_gas_a_repay_from_a_one_stock_account() public {
        _assert80(_caseRepayOneStock());
    }

    function test_gas_a_one_slice_sale() public {
        _assert80(_caseSaleOneSlice());
    }

    function test_gas_a_one_leg_trade() public {
        _assert80(_caseTradeOneLeg());
    }

    function test_gas_each_coins_conversion() public {
        for (uint256 k; k < 5; ++k) {
            uint256 snap = vm.snapshotState();
            _assert80(_caseConvert(k));
            vm.revertToState(snap);
        }
    }

    function test_gas_refresh() public {
        _assert80(_caseRefresh());
    }

    function test_gas_refresh_of_a_one_stock_account() public {
        _assert80(_caseRefreshOneStock());
    }

    function test_gas_save() public {
        _assert80(_caseSave());
    }

    function test_gas_end() public {
        _assert80(_caseEnd(ALL_STOCKS, "END, 7-stock rescue"));
    }

    function test_gas_end_of_a_one_stock_rescue() public {
        _assert80(_caseEnd(1 << NVDA, "END, 1-stock rescue"));
    }

    /// Eight accounts, each under the line, repaid in one cold perform at KeeperHub's 5.4M (the spec plans 6-slice
    /// sale + 2 repays, or ~8 repays, a write). Logs how many ran.
    function _eightRepays(uint256 mask, string memory tag) internal returns (uint256 ran) {
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](8);
        for (uint256 i; i < 8; ++i) {
            (address a, uint256[] memory args) = _repayAccount(string.concat(tag, vm.toString(i)), mask);
            moves[i] = _move(a, REPAY, args);
        }
        _assertIsolated();
        (uint256 used, Vm.Log[] memory logs) = _perform(abi.encode(moves));
        bytes4[] memory refused = _reasons(logs);
        ran = 8 - refused.length;
        console2.log(string.concat("8 repays in one perform (", tag, "): gas"), used, "ran", ran);
        for (uint256 i; i < refused.length; ++i) {
            console2.log(string.concat("  refused ", _name(refused[i])));
        }
    }

    function test_gas_eight_repays_of_seven_stock_accounts_in_one_perform() public {
        assertEq(_eightRepays(ALL_STOCKS, "7-stock accounts"), 8, "not all 8 repays ran");
    }

    function test_gas_eight_repays_of_one_stock_accounts_in_one_perform() public {
        assertEq(_eightRepays(1 << NVDA, "1-stock accounts"), 8, "not all 8 repays ran");
    }

    /// The gas gate (cap × 64/63 + 60k) against KeeperHub's 5.4M: the most legs a SELL (and args a TRADE) can carry
    /// and still be tried, as the first move of a perform, at today's caps. Larger ones are always refused NoGas.
    function test_gas_the_most_legs_a_move_can_carry() public {
        address a = _account("legs", 1 << NVDA, 1.5e18); // healthy: a sale that passes the gate is refused NotNeeded
        uint256 most;
        for (uint256 n = 4; n <= 16; ++n) {
            uint256[] memory legs = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                legs[i] = _leg(NVDA, 1e6);
            }
            bytes4 reason = _send(a, SELL, legs);
            console2.log(string.concat("SELL with ", vm.toString(n), " legs: ", _name(reason)));
            if (reason != GooseGuard.NoGas.selector) most = n;
        }
        console2.log("most SELL legs tried in a 5.4M perform at today's caps", most);
        // One stock: 1.3M + 8 × 0.45M + 0.3M = 5.2M, and 5.2M × 64/63 + 60k fits 5.4M; a ninth slice doesn't.
        assertEq(most, 8, "the gate's limit moved");
    }

    /// Cases [from, to), then their table. Every case starts from the same state, and every measured call is made from
    /// the test itself, so it runs as its own (cold) transaction.
    function _table(string memory title, uint256 from, uint256 to) internal {
        for (uint256 i = from; i < to; ++i) {
            uint256 snap = vm.snapshotState();
            Row memory row;
            if (i == 0) row = _caseSaleOneSlice();
            else if (i == 1) row = _caseSaleSixSlices();
            else if (i == 2) row = _caseSaleSevenStocks();
            else if (i == 3) row = _caseRepay();
            else if (i == 4) row = _caseRepayOneStock();
            else if (i == 5) row = _caseRefresh();
            else if (i == 6) row = _caseRefreshOneStock();
            else if (i == 7) row = _caseEnd(ALL_STOCKS, "END, 7-stock rescue");
            else if (i == 8) row = _caseEnd(1 << NVDA, "END, 1-stock rescue");
            else if (i == 9) row = _caseTradeOneLeg();
            else if (i == 10) row = _caseTopUpSevenBuys();
            else if (i == 11) row = _caseRebalanceSevenLegs();
            else if (i < 17) row = _caseConvert(i - 12);
            else row = _caseSave();
            vm.revertToState(snap);
            rows.push(row);
        }
        console2.log("");
        console2.log(string.concat("=== GooseGuard cold gas, ", title, " (frame = the move's own run: what capOf must cover) ==="));
        uint256 over;
        for (uint256 i; i < rows.length; ++i) {
            _print(rows[i]);
            if (rows[i].frame > rows[i].cap * 80 / 100) ++over;
        }
        assertEq(over, 0, "cases over 80% of their cap");
    }

    function test_gas_table_sales() public {
        _table("Protect sales", 0, 3);
    }

    function test_gas_table_repay_refresh_end() public {
        _table("Protect repays, refresh, end", 3, 9);
    }

    function test_gas_table_trade_convert_save() public {
        _table("Rebalance, Turn into cash, Save", 9, 18);
    }
}
