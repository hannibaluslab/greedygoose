// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IAeroPool, IAeroRouter} from "../src/IProtocols.sol";
import {PlanBase} from "../src/planner/PlanBase.sol";
import {PlannerForkBase} from "./PlannerForkBase.sol";
import {IERC20Lite} from "./IJustaPermissionManager.sol";

/// The Protect read's two capped calls, cold, on a seven-stock account (the costliest Aave read): ProtectPlanner.rankOf
/// stays within 80% of GoosePlanner.CHECK_GAS, and planProtectExcept within 80% of PLAN_GAS. Cold, at its worst: the call
/// is measured once while every account and slot it touches is recorded, then each distinct account is charged EIP-2929's
/// cold premium (2,500 over a warm touch) and each distinct slot its own (2,000), as if the first member of a read met
/// every one of them cold. (vm.cool did not cool them on this fork: the run after it cost the same as a warm one.)
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-path test/PlannerGasFork.t.sol -vv
abstract contract PlannerGasForkBase is PlannerForkBase {
    address a;
    uint256 hf;

    function _sevenStocks(uint256 at, uint256 savings) internal returns (address x) {
        x = _newJawAccount("seven");
        _backWithAllStocks(x, 1e8);
        _drawTo(x, at);
        _save(x, savings); // some of the credit in savings: a partial repay, then the sale
        deal(address(USDC), x, 0);
        _protectOn(x);
        _sellOn(x);
        hf = SPOKE.getUserAccountData(x).healthFactor;
    }

    /// The gas of `data` on `target` with every account and slot it touches cold (`cold`, an upper bound: the measured
    /// run plus each distinct account's and slot's cold premium), the measured run (`warm`), and its return data.
    function _coldGas(address target, bytes memory data) internal returns (uint256 cold, uint256 warm, bytes memory ret) {
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        (bool ok, bytes memory out) = target.staticcall(data);
        warm = g0 - gasleft();
        Vm.AccountAccess[] memory seen = vm.stopAndReturnStateDiff();
        assertTrue(ok, "the call reverted");
        ret = out;
        address[] memory accounts = new address[](seen.length);
        uint256 nAccounts;
        uint256 nSlots;
        for (uint256 i; i < seen.length; ++i) {
            nAccounts = _addAccount(accounts, nAccounts, seen[i].account);
            nSlots += seen[i].storageAccesses.length;
        }
        bytes32[] memory slots = new bytes32[](nSlots);
        nSlots = 0;
        for (uint256 i; i < seen.length; ++i) {
            for (uint256 k; k < seen[i].storageAccesses.length; ++k) {
                bytes32 key = keccak256(abi.encode(seen[i].storageAccesses[k].account, seen[i].storageAccesses[k].slot));
                bool known;
                for (uint256 j; j < nSlots; ++j) {
                    if (slots[j] == key) {
                        known = true;
                        break;
                    }
                }
                if (!known) slots[nSlots++] = key;
            }
        }
        cold = warm + nAccounts * 2500 + nSlots * 2000;
        console2.log("  distinct accounts, slots", nAccounts, nSlots);
    }

    function _addAccount(address[] memory list, uint256 n, address x) internal pure returns (uint256) {
        for (uint256 j; j < n; ++j) {
            if (list[j] == x) return n;
        }
        list[n] = x;
        return n + 1;
    }

    /// Moves stock r's pool `bps` under Aave's price with a real swap through Aerodrome's router.
    function _poolUnder(uint256 r, uint256 bps) internal {
        uint256 price = _price(r) * (1e4 - bps) / 1e4;
        uint160 target = uint160((uint256(1) << 96) * 1e10 / _sqrt(price * 1e10));
        address pool = AERO_FACTORY.getPool(STOCKS[r], address(USDC), 10);
        (uint160 now_,,,,,) = IAeroPool(pool).slot0();
        if (target <= now_) return;
        deal(STOCKS[r], address(this), 1e14);
        IERC20Lite(STOCKS[r]).approve(ROUTER, type(uint256).max);
        IAeroRouter(ROUTER).exactInputSingle(
            IAeroRouter.ExactInputSingleParams(
                STOCKS[r], address(USDC), 10, address(this), vm.getBlockTimestamp(), 1e14, 0, target
            )
        );
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}

/// rankOf at its costliest: Protect with savings (Aave V3's account read), and a Sell grant over seven stocks whose
/// first six pools are out of the band, so the sale test reads all seven holdings and pools.
contract PlannerGasRankForkTest is PlannerGasForkBase {
    function setUp() public override {
        super.setUp();
        a = _sevenStocks(1.02e18, 20e6);
        for (uint256 r; r < 6; ++r) {
            _poolUnder(r, 200);
        }
    }

    function test_cold_rankOf_on_a_seven_stock_account() public {
        (uint256 cold, uint256 warm, bytes memory ret) =
            _coldGas(address(protect), abi.encodeCall(protect.rankOf, (a, hf)));
        (uint256 key, bool sellOnly) = abi.decode(ret, (uint256, bool));
        console2.log("rankOf cold, warm, CHECK_GAS", cold, warm, planner.CHECK_GAS());
        console2.log("  key, sellOnly", key, sellOnly ? 1 : 0);
        assertGt(key, 0, "a seven-stock victim ranked 0");
        assertLe(cold, planner.CHECK_GAS() * 80 / 100, "rankOf over 80% of CHECK_GAS");
    }

    function test_cold_protectCheck_on_a_seven_stock_account() public {
        (uint256 cold, uint256 warm, bytes memory ret) =
            _coldGas(address(planner), abi.encodeCall(planner.protectCheck, (a, 0)));
        (uint8 need,) = abi.decode(ret, (uint8, uint256));
        console2.log("protectCheck cold, warm, CHECK_GAS", cold, warm, planner.CHECK_GAS());
        assertEq(need, 1);
        assertLe(cold, planner.CHECK_GAS() * 80 / 100, "protectCheck over 80% of CHECK_GAS");
    }
}

/// planProtectExcept at its costliest: a partial repay from savings, then a sale cut over seven stocks whose pools are
/// all in the band, so it walks every pool.
contract PlannerGasPlanForkTest is PlannerGasForkBase {
    function setUp() public override {
        super.setUp();
        a = _sevenStocks(1.02e18, 20e6);
    }

    function test_cold_planProtectExcept_on_a_seven_stock_account() public {
        (uint256 cold, uint256 warm, bytes memory ret) =
            _coldGas(address(protect), abi.encodeCall(protect.planProtectExcept, (a, 0, planner.PACK_GAS())));
        PlanBase.Move[] memory m = abi.decode(ret, (PlanBase.Move[]));
        console2.log("planProtectExcept cold, warm, PLAN_GAS", cold, warm, planner.PLAN_GAS());
        console2.log("  moves", m.length);
        for (uint256 i; i < m.length; ++i) {
            console2.log("  kind, legs", m[i].kind, m[i].args.length);
        }
        assertEq(m.length, 2, "not a repay and a sale");
        assertLe(cold, planner.PLAN_GAS() * 80 / 100, "planProtectExcept over 80% of PLAN_GAS");
    }
}

