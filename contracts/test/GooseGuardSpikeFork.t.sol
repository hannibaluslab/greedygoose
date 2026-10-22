// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {GooseGuard} from "../src/GooseGuard.sol";
import {IAeroFactory} from "../src/IProtocols.sol";
import {ForkBase} from "./ForkBase.sol";
import {IJustaPermissionManager as PM, ISpoke} from "./IJustaPermissionManager.sol";

/// Build step 1 smoke test: a real Protect repay and a real Protect sale run through the Guard spike, JAW's manager,
/// Aave V4 and Aerodrome on a Base fork, sent as KeeperHub would send them. Step 6 replaces it with the full suites.
/// Run: BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseGuardSpikeForkTest -vv
contract GooseGuardSpikeForkTest is ForkBase {
    IAeroFactory constant AERO_FACTORY = IAeroFactory(0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef);
    address constant ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address constant KEEPERHUB = 0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93;
    /// KeeperHub's write is 5.5M; about 5.4M reaches the Guard (tests.md trap 7).
    uint256 constant KH_GAS = 5_400_000;
    bytes32 constant REFUSED = keccak256("Refused(address,uint8,bytes4)");

    GooseGuard g;

    function setUp() public {
        _fork();
        address pool = AERO_FACTORY.getPool(NVDAC, address(USDC), 10);
        deal(NVDAC, pool, _realBalance(NVDAC, pool));
        address probe = _newJawAccount("probe");
        g = new GooseGuard(address(this), KEEPERHUB, probe.codehash, 300, 50, 100, 1e6, 1e6);
    }

    // ================================================================== permissions, as the app will grant them

    function _permission(address a, PM.CallPermission[] memory calls, PM.SpendLimit[] memory spends)
        internal
        view
        returns (PM.Permission memory)
    {
        uint48 now_ = uint48(vm.getBlockTimestamp());
        return PM.Permission(a, address(g), now_ - 60, now_ + 365 days, uint256(keccak256(abi.encode(a, calls))), calls, spends);
    }

    function _call(address target, bytes4 selector) internal pure returns (PM.CallPermission memory) {
        return PM.CallPermission(target, selector, address(0));
    }

    function _spend(address token) internal pure returns (PM.SpendLimit memory) {
        return PM.SpendLimit(token, type(uint160).max, PM.PeriodUnit.Day, 1);
    }

    /// Protect: V3 withdraw, USDC approve, V4 repay; USDC and aUSDC with no limit.
    function _protectOn(address a) internal {
        PM.CallPermission[] memory calls = new PM.CallPermission[](3);
        calls[0] = _call(address(POOL), 0x69328dec);
        calls[1] = _call(address(USDC), 0x095ea7b3);
        calls[2] = _call(address(SPOKE), 0xb1e8f8ef);
        PM.SpendLimit[] memory spends = new PM.SpendLimit[](2);
        spends[0] = _spend(address(USDC));
        spends[1] = _spend(address(AUSDC));
        _on(a, 1, _permission(a, calls, spends));
    }

    /// Protect · sell, NVDAc only: V4 withdraw, NVDAc approve, Aerodrome swap, USDC approve, V4 repay.
    function _sellOn(address a) internal {
        PM.CallPermission[] memory calls = new PM.CallPermission[](5);
        calls[0] = _call(address(SPOKE), 0x0ad58d2f);
        calls[1] = _call(NVDAC, 0x095ea7b3);
        calls[2] = _call(ROUTER, 0xa026383e);
        calls[3] = _call(address(USDC), 0x095ea7b3);
        calls[4] = _call(address(SPOKE), 0xb1e8f8ef);
        PM.SpendLimit[] memory spends = new PM.SpendLimit[](2);
        spends[0] = _spend(address(USDC));
        spends[1] = _spend(NVDAC);
        _on(a, 2, _permission(a, calls, spends));
    }

    /// The one-tap batch's two halves: approve through the account, then the account registers it with the Guard.
    function _on(address a, uint8 job, PM.Permission memory p) internal {
        _grantThroughAccount(p);
        vm.prank(a);
        g.register(job, abi.encode(p));
        assertEq(keccak256(g.permissionOf(a, job)), keccak256(abi.encode(p)), "permissionOf isn't what was approved");
    }

    // ================================================================== sending moves as KeeperHub

    function _send(address a, uint8 kind, uint256[] memory args) internal returns (uint256 gasUsed, uint256 refused) {
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](1);
        moves[0] = GooseGuard.Move(a, kind, args);
        vm.recordLogs();
        uint256 before = gasleft();
        vm.prank(KEEPERHUB);
        g.performUpkeep{gas: KH_GAS}(abi.encode(moves));
        gasUsed = before - gasleft();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(g) && logs[i].topics[0] == REFUSED) {
                ++refused;
                console2.log("refused, reason:");
                console2.logBytes4(abi.decode(logs[i].data, (bytes4)));
            }
        }
    }

    function _two(uint256 x, uint256 y) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = x;
        a[1] = y;
    }

    function _hf(address a) internal view returns (uint256) {
        return SPOKE.getUserAccountData(a).healthFactor;
    }

    // ================================================================== tests

    /// Under the line, a repay from savings lands between the line and the target plus 0.01.
    function test_a_repay_from_savings_lands_between_the_line_and_the_target() public {
        address a = _newJawAccount("repay");
        uint256 credit = _openCreditAt(a, SHARES, 1.02e18);
        _save(a, credit); // the credit taken as cash sits in savings, as Earn with stocks does
        _protectOn(a);

        // USDC to repay to land at 1.10: debt − power / 1.10.
        ISpoke.UserAccountData memory d = SPOKE.getUserAccountData(a);
        uint256 power = d.totalCollateralValue * d.avgCollateralFactor / 1e18;
        uint256 repay = (d.totalDebtValueRay / 1e27 - power * 1e18 / 1.1e18) / 1e20;

        uint256 hfBefore = _hf(a);
        (uint256 gasUsed, uint256 refused) = _send(a, 1, _two(0, repay));
        uint256 hfAfter = _hf(a);
        console2.log("REPAY gas", gasUsed);
        console2.log("health before", hfBefore);
        console2.log("health after", hfAfter);
        assertEq(refused, 0, "the repay was refused");
        assertGt(hfAfter, 1.03e18, "still under the line");
        assertLe(hfAfter, 1.13e18, "past the target plus 0.01");
        (GooseGuard.Account memory acc,) = g.accountOf(a);
        assertGt(acc.rescueAt, 0, "a rescue short of the target should be on");
    }

    /// Under the line, a sale of NVDAc in six slices lands between the line and the target plus 0.01, and every
    /// share withdrawn was sold. Each slice is small enough that its withdraw keeps health above 1 (the Planner's job).
    function test_a_sale_in_six_slices_lands_between_the_line_and_the_target() public {
        address a = _newJawAccount("sell");
        _openCreditAt(a, SHARES, 1.02e18);
        deal(address(USDC), a, 0); // no cash: only a sale can help
        _sellOn(a);

        // Value to sell to land near 1.05: (T·D − P) / (T × 0.97 − cf), split into six equal slices.
        ISpoke.UserAccountData memory d = SPOKE.getUserAccountData(a);
        uint256 power = d.totalCollateralValue * d.avgCollateralFactor / 1e18;
        uint256 debt = d.totalDebtValueRay / 1e27;
        uint256 t = 1.05e18;
        uint256 value = (t * debt / 1e18 - power) * 1e18 / (t * 97 / 100 - d.avgCollateralFactor);
        uint256 price = ORACLE_PRICE(NVDAC_RESERVE);
        uint256 slice = value / 6 / (price * 1e10);
        uint256[] memory legs = new uint256[](6);
        for (uint256 i; i < 6; ++i) {
            legs[i] = NVDAC_RESERVE << 248 | slice;
        }

        uint256 hfBefore = _hf(a);
        (uint256 gasUsed, uint256 refused) = _send(a, 2, legs);
        uint256 hfAfter = _hf(a);
        console2.log("SELL gas (6 slices)", gasUsed);
        console2.log("health before", hfBefore);
        console2.log("health after", hfAfter);
        assertEq(refused, 0, "the sale was refused");
        assertGt(hfAfter, hfBefore, "health didn't rise");
        assertLe(hfAfter, 1.13e18, "past the target plus 0.01");
        assertEq(IERC20Like(NVDAC).balanceOf(a), 0, "stock left in the wallet");
    }

    /// A repay while healthy is refused, and the perform itself doesn't revert.
    function test_a_repay_while_healthy_is_refused_not_reverted() public {
        address a = _newJawAccount("healthy");
        uint256 credit = _openCreditAt(a, SHARES, 1.5e18);
        _save(a, credit);
        _protectOn(a);
        (, uint256 refused) = _send(a, 1, _two(0, 1e6));
        assertEq(refused, 1, "a repay while healthy wasn't refused");
    }

    /// A stranger can't send moves for someone else's account: they're skipped, with no event in its feed.
    function test_a_stranger_is_skipped() public {
        address a = _newJawAccount("victim");
        GooseGuard.Move[] memory moves = new GooseGuard.Move[](1);
        moves[0] = GooseGuard.Move(a, 1, _two(0, 1e6));
        vm.recordLogs();
        vm.prank(makeAddr("stranger"));
        g.performUpkeep(abi.encode(moves));
        assertEq(vm.getRecordedLogs().length, 0, "a stranger's move left an event");
    }

    uint256 constant SHARES = 10e8;

    function ORACLE_PRICE(uint256 r) internal view returns (uint256) {
        return IOracleLike(0xaBaf048fD7675Ea34a84332371ffd5D55E322A47).getReservePrice(r);
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}

interface IOracleLike {
    function getReservePrice(uint256 reserveId) external view returns (uint256);
}
