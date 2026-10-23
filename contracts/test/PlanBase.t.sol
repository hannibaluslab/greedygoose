// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IJustaPermissionManager as PM} from "../src/IJustaPermissionManager.sol";
import {IGooseGuard, PlanBase} from "../src/planner/PlanBase.sol";

/// A Guard that returns whatever permission bytes a test registers, with GooseGuard's default numbers.
contract GrantGuard {
    uint256 public constant SALE_FLOOR_BPS = 300;
    uint256 public constant SWAP_FLOOR_BPS = 50;
    uint256 public constant BAND_BPS = 100;
    uint256 public constant TIGHT_BPS = 40;
    uint256 public constant KEEP_BACK = 1e6;
    mapping(address => mapping(uint8 => bytes)) internal raw;

    function set(address a, uint8 job, bytes memory p) external {
        raw[a][job] = p;
    }

    function permissionOf(address a, uint8 job) external view returns (bytes memory) {
        return raw[a][job];
    }
}

/// JAW's manager, as far as the template check asks it: nothing is revoked.
contract NothingRevoked {
    function isRevoked(PM.Permission calldata) external pure returns (bool) {
        return false;
    }
}

/// A JAW account the manager owns.
contract ManagedAccount {
    function isOwnerAddress(address) external pure returns (bool) {
        return true;
    }
}

contract PlanBaseHarness is PlanBase {
    constructor(IGooseGuard g) PlanBase(g) {}

    function aliveP(address a, uint8 job, PM.Permission memory p) external view returns (bool) {
        return _aliveP(a, job, p);
    }

    function alive(address a, uint8 job) external view returns (bool) {
        return _alive(a, job);
    }

    function permission(address a, uint8 job) external view returns (PM.Permission memory) {
        return _permission(a, job);
    }

    function maxGrantBytes() external pure returns (uint256) {
        return MAX_GRANT_BYTES;
    }
}

/// Offline unit tests for PlanBase's grant checks: the app's template (every spend at NO_LIMIT, decision 9) and the
/// longest grant the Planner decodes.
/// Run: forge test --match-contract PlanBaseTest -vv
contract PlanBaseTest is Test {
    address constant MANAGER = 0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8;
    address constant SPOKE = 0x17905Db0e4A3514467539956c084180616AE7B8D;
    address constant V3 = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant AUSDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address constant ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    /// lib/agents/permissions.ts NO_LIMIT.
    uint160 constant NO_LIMIT = type(uint160).max;
    uint8 constant JOB_PROTECT = 1;
    uint8 constant JOB_SELL = 2;

    GrantGuard guard;
    PlanBaseHarness base;
    address account;

    function setUp() public {
        guard = new GrantGuard();
        base = new PlanBaseHarness(IGooseGuard(address(guard)));
        vm.etch(MANAGER, type(NothingRevoked).runtimeCode);
        account = address(new ManagedAccount());
        vm.warp(1_800_000_000);
    }

    function _call(address target, bytes4 selector) internal pure returns (PM.CallPermission memory) {
        return PM.CallPermission(target, selector, address(0));
    }

    function _grant(PM.CallPermission[] memory calls, address[] memory tokens)
        internal
        view
        returns (PM.Permission memory p)
    {
        PM.SpendLimit[] memory spends = new PM.SpendLimit[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            spends[i] = PM.SpendLimit(tokens[i], NO_LIMIT, PM.PeriodUnit.Day, 1);
        }
        uint48 now_ = uint48(block.timestamp);
        p = PM.Permission(account, address(guard), now_ - 60, now_ + 365 days, 7, calls, spends);
    }

    /// The app's Protect grant (permissions.ts agentPermission("protect")): V3 withdraw, USDC approve, V4 repay; USDC
    /// and aUSDC a day each with no limit.
    function _protect() internal view returns (PM.Permission memory) {
        PM.CallPermission[] memory calls = new PM.CallPermission[](3);
        calls[0] = _call(V3, 0x69328dec);
        calls[1] = _call(USDC, 0x095ea7b3);
        calls[2] = _call(SPOKE, 0xb1e8f8ef);
        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = AUSDC;
        return _grant(calls, tokens);
    }

    /// The app's Protect · sell grant over all seven stocks (permissions.ts sellPermission), its largest: V4 withdraw,
    /// each stock's approve, the Aerodrome swap, USDC approve, V4 repay, the config refresh; USDC, aUSDC and each stock.
    function _sellAll() internal view returns (PM.Permission memory) {
        PM.CallPermission[] memory calls = new PM.CallPermission[](12);
        address[] memory tokens = new address[](9);
        calls[0] = _call(SPOKE, 0x0ad58d2f);
        tokens[0] = USDC;
        tokens[1] = AUSDC;
        for (uint256 r; r < 7; ++r) {
            calls[1 + r] = _call(base.stock(r), 0x095ea7b3);
            tokens[2 + r] = base.stock(r);
        }
        calls[8] = _call(ROUTER, 0xa026383e);
        calls[9] = _call(USDC, 0x095ea7b3);
        calls[10] = _call(SPOKE, 0xb1e8f8ef);
        calls[11] = _call(SPOKE, 0x826002e2);
        return _grant(calls, tokens);
    }

    // ================================================================== the template rule (GG-01)

    /// The app's NO_LIMIT grants are live; the same grant with any one spend capped is not, so no move is planned for
    /// it (a capped grant let a paying attacker's $1 repays look like rescues).
    function test_the_apps_no_limit_grant_is_live_and_a_capped_spend_is_refused() public view {
        PM.Permission memory p = _protect();
        assertTrue(base.aliveP(account, JOB_PROTECT, p), "the app's Protect grant");
        p.spends[0].allowance = 1e6; // Mariano's paying attacker: $1 of USDC per period
        assertFalse(base.aliveP(account, JOB_PROTECT, p), "a capped USDC spend");
        p = _protect();
        p.spends[1].allowance = NO_LIMIT - 1; // one unit under the maximum, on aUSDC
        assertFalse(base.aliveP(account, JOB_PROTECT, p), "a capped aUSDC spend");

        PM.Permission memory s = _sellAll();
        assertTrue(base.aliveP(account, JOB_SELL, s), "the app's Protect sell grant");
        s.spends[8].allowance = 1; // the free attacker: one unit of TSLAc
        assertFalse(base.aliveP(account, JOB_SELL, s), "a capped stock spend");
    }

    /// The bytes the app registers (scripts/agent-vectors.ts `registrations`, lib/agents/register.ts): its Protect and
    /// Protect · sell grants pass the template rule as they are.
    function test_the_apps_registered_bytes_pass_the_template_rule() public {
        string memory json = vm.readFile("test/vectors/permissions.json");
        bytes[] memory regs = vm.parseJsonBytesArray(json, ".registrations");
        uint8[2] memory jobs = [JOB_PROTECT, JOB_SELL];
        for (uint256 i; i < 2; ++i) {
            PM.Permission memory p = abi.decode(regs[i], (PM.Permission));
            for (uint256 k; k < p.spends.length; ++k) {
                assertEq(p.spends[k].allowance, NO_LIMIT, "the app granted a limit");
            }
            // The vector's own account, spender and window, with this test's Guard and an account the manager owns.
            vm.etch(p.account, type(ManagedAccount).runtimeCode);
            vm.etch(p.spender, address(guard).code);
            PlanBaseHarness h = new PlanBaseHarness(IGooseGuard(p.spender));
            vm.warp(p.start);
            assertTrue(h.aliveP(p.account, jobs[i], p), "the app's registration isn't live");
        }
    }

    // ================================================================== the longest grant decoded (GG-04)

    /// MAX_GRANT_BYTES is the app's largest grant as `permissionOf` returns it, plus 25%.
    function test_max_grant_bytes_is_the_apps_largest_plus_a_quarter() public view {
        uint256 largest = abi.encode(_sellAll()).length;
        assertEq(largest, 2_624, "the app's largest grant");
        assertEq(base.maxGrantBytes(), largest * 125 / 100);
        assertGt(base.maxGrantBytes(), abi.encode(_protect()).length);
    }

    /// A grant up to MAX_GRANT_BYTES is decoded and live; a longer one is left undecoded and counts as none.
    function test_a_grant_longer_than_max_grant_bytes_counts_as_none() public {
        PM.Permission memory p = _sellAll();
        guard.set(account, JOB_SELL, abi.encode(p));
        assertTrue(base.alive(account, JOB_SELL), "the app's largest grant");
        // The same grant with checker-free calls it never uses, past the bound.
        PM.CallPermission[] memory calls = new PM.CallPermission[](30);
        for (uint256 i; i < 30; ++i) {
            calls[i] = i < 12 ? p.calls[i] : _call(address(uint160(0x1000 + i)), 0x12345678);
        }
        p.calls = calls;
        bytes memory big = abi.encode(p);
        assertGt(big.length, base.maxGrantBytes());
        guard.set(account, JOB_SELL, big);
        assertEq(base.permission(account, JOB_SELL).account, address(0), "decoded");
        assertFalse(base.alive(account, JOB_SELL), "a grant past the bound is live");
    }
}
