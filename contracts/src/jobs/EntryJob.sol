// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GooseExecutor} from "../GooseExecutor.sol";
import {IJustaPermissionManager as PM} from "../IJustaPermissionManager.sol";
import {IAeroRouter, IERC20, IPsm3, IUniswapRouter} from "../IProtocols.sol";
import {Coin, EntryLimits, EntryRules} from "../EntryRules.sol";
import {JobBase} from "./JobBase.sol";

/// @title EntryJob
/// @notice The Entry agent on Base (plan item 2, steps 1-3): a whitelisted dollar stablecoin in the wallet becomes USDC
///         in the same wallet at 99.5% of its face value or better, one capped swap a run, on the deepest venue for that
///         coin. A swap that can't meet the floor moves nothing: the coin waits (EntryWaiting) and is tried again an
///         hour later. The rule is EntryRules; this library reads the wallet, builds the batch, sends it through the
///         manager and checks the result.
///
///         The coins and venues are Base mainnet's, fixed here (lib/tokens/stables.ts, checked against the chain by
///         DeployExecutor.t.sol): another chain gets its own Entry library. GHO is left out: Base has no GHO/USDC
///         liquidity to speak of.
/// @dev A linked library: its code runs as GooseExecutor, the spender, exactly as if it were inlined there.
library EntryJob {
    uint256 internal constant COINS = 4;
    /// A coin whose swap couldn't meet the floor waits this long before the next try.
    uint32 internal constant RETRY = 1 hours;
    /// Kept for the reads and post-checks around the batch.
    uint256 internal constant CHECKS_GAS = 200_000;

    // The coins, in the Entry permission's order (lib/tokens/stables.ts ENTRY_COINS).
    address internal constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address internal constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address internal constant USDBC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    address internal constant USDS = 0x820C137fa70C8691f0e44Dc420a5e53c168921Dc;
    /// Aerodrome Slipstream's first deployment, where USDT/USDC and USDbC/USDC sit at tick spacing 1 (venues.ts
    /// AERODROME_V1).
    address internal constant AERODROME_V1_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    int24 internal constant STABLE_TICK_SPACING = 1;
    /// Uniswap v3's SwapRouter02: USDe/USDC at 0.05% holds the depth (venues.ts UNISWAP).
    address internal constant UNISWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    uint24 internal constant USDE_FEE = 500;
    /// Spark's PSM3: USDS for USDC 1:1 (venues.ts SPARK_PSM3).
    address internal constant PSM3 = 0x1601843c5E9bC251A3272907010AFa41Fa18347E;

    enum Venue {
        Aerodrome,
        Uniswap,
        Psm3
    }

    /// What a planned conversion carries to its batch.
    struct Move {
        PM.Permission perm;
        uint256 index;
        uint256 amountIn;
        uint256 minOut;
    }

    /// Coin k: its address, decimals and venue.
    function coin(uint256 k) internal pure returns (address token, uint256 decimals, Venue venue) {
        if (k == 0) return (USDT, 6, Venue.Aerodrome);
        if (k == 1) return (USDE, 18, Venue.Uniswap);
        if (k == 2) return (USDBC, 6, Venue.Aerodrome);
        return (USDS, 18, Venue.Psm3);
    }

    function _router(Venue v) internal pure returns (address) {
        return v == Venue.Aerodrome ? AERODROME_V1_ROUTER : v == Venue.Uniswap ? UNISWAP_ROUTER : PSM3;
    }

    // ================================================================== permission

    /// The template the user approved: approve each coin, then each venue's swap. A daily limit on each coin, all at
    /// the same face value: `cap` USDC units, decimals adjusted.
    function permission(
        GooseExecutor.Env memory,
        address account,
        GooseExecutor.Grant memory g,
        uint256 salt,
        uint256 // no terms
    )
        public
        view
        returns (PM.Permission memory p)
    {
        p.account = account;
        p.spender = address(this); // the executor: this code runs in its context
        p.start = g.start;
        p.end = g.end;
        p.salt = salt;
        p.calls = new PM.CallPermission[](COINS + 3);
        p.spends = new PM.SpendLimit[](COINS);
        for (uint256 k; k < COINS; ++k) {
            (address token, uint256 decimals,) = coin(k);
            p.calls[k] = PM.CallPermission(token, IERC20.approve.selector, address(0));
            p.spends[k] = PM.SpendLimit(token, uint160(g.cap * 10 ** (decimals - 6)), PM.PeriodUnit.Day, 1);
        }
        p.calls[COINS] = PM.CallPermission(AERODROME_V1_ROUTER, IAeroRouter.exactInputSingle.selector, address(0));
        p.calls[COINS + 1] = PM.CallPermission(UNISWAP_ROUTER, IUniswapRouter.exactInputSingle.selector, address(0));
        p.calls[COINS + 2] = PM.CallPermission(PSM3, IPsm3.swapExactIn.selector, address(0));
    }

    function checkLimits(EntryLimits memory l) public pure {
        if (!EntryRules.limitsOk(l)) revert GooseExecutor.OutOfBounds();
    }

    // ================================================================== plan and run

    /// What a run would do now: convert a coin, prune a dead permission, or nothing.
    function plan(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage,
        mapping(address => uint256) storage waits
    ) public view returns (GooseExecutor.Plan memory p) {
        (p,) = _plan(e, c, waits[c.account]);
    }

    /// Plans, then converts. A swap the venue can't fill at the floor moves nothing; the coin waits RETRY. A batch that
    /// wouldn't fit in the gas left is deferred to the next run.
    function run(
        GooseExecutor.Env memory e,
        GooseExecutor.Ctx memory c,
        GooseExecutor.Account storage,
        mapping(address => uint256) storage waits
    ) external returns (GooseExecutor.Plan memory p) {
        Move memory m;
        (p, m) = _plan(e, c, waits[c.account]);
        if (p.action != GooseExecutor.Action.Convert) return p;
        if (gasleft() < JobBase.ACCOUNT_GAS + CHECKS_GAS) {
            p.action = GooseExecutor.Action.Defer;
            return p;
        }
        (address token,, Venue venue) = coin(m.index);
        Before memory b = snapshot(e, c.account, token);
        try e.manager.executeBatch{gas: JobBase.ACCOUNT_GAS}(m.perm, _calls(e, c.account, token, venue, m)) {}
        catch {
            uint32 retryAt = uint32(block.timestamp) + RETRY;
            uint256 at = 32 * m.index;
            waits[c.account] = waits[c.account] & ~(uint256(type(uint32).max) << at) | uint256(retryAt) << at;
            emit GooseExecutor.EntryWaiting(c.account, token, m.amountIn, retryAt);
            return p;
        }
        emit GooseExecutor.EntryConverted(c.account, token, m.amountIn, check(e, c.account, m.amountIn, m.minOut, b));
    }

    /// Cheap reads first: most accounts hold no coin, and the limits and the permission's status are only paid for
    /// when one is worth converting.
    function _plan(GooseExecutor.Env memory e, GooseExecutor.Ctx memory c, uint256 waitWord)
        internal
        view
        returns (GooseExecutor.Plan memory p, Move memory m)
    {
        p.job = GooseExecutor.Job.Entry;
        p.hf = c.hf;
        EntryLimits memory l = c.entryLimits;
        Coin[] memory coins = new Coin[](COINS);
        bool any;
        for (uint256 k; k < COINS; ++k) {
            (address token, uint256 decimals,) = coin(k);
            coins[k].decimals = decimals;
            coins[k].waiting = waitWord >> (32 * k) & type(uint32).max > block.timestamp;
            if (coins[k].waiting) continue;
            coins[k].balance = IERC20(token).balanceOf(c.account);
            if (coins[k].balance / 10 ** (decimals - 6) >= l.minEntry) any = true;
        }
        if (!any) return (p, m);
        m.perm = permission(e, c.account, c.grant, c.salt, 0);
        for (uint256 k; k < COINS; ++k) {
            if (coins[k].balance / 10 ** (coins[k].decimals - 6) < l.minEntry) continue; // the rule skips it anyway
            coins[k].limitLeft = JobBase.capLeft(e.manager, m.perm, k);
        }
        bool found;
        (found, m.index, m.amountIn, m.minOut) = EntryRules.plan(coins, l);
        if (!found) return (p, m);
        (bool alive, GooseExecutor.OffReason off) = JobBase.alive(e.manager, m.perm);
        if (!alive) {
            p.action = GooseExecutor.Action.Prune;
            p.off = off;
            return (p, m);
        }
        p.action = GooseExecutor.Action.Convert;
        p.amount = m.minOut;
        p.reason = uint8(m.index);
    }

    /// Approve the venue exactly, then swap to the account with face value less the floor as the minimum.
    function _calls(GooseExecutor.Env memory e, address account, address token, Venue venue, Move memory m)
        internal
        view
        returns (PM.Call[] memory calls)
    {
        address router = _router(venue);
        calls = new PM.Call[](2);
        calls[0] = PM.Call(token, 0, abi.encodeCall(IERC20.approve, (router, m.amountIn)));
        bytes memory swap;
        if (venue == Venue.Aerodrome) {
            swap = abi.encodeCall(
                IAeroRouter.exactInputSingle,
                (IAeroRouter.ExactInputSingleParams({
                        tokenIn: token,
                        tokenOut: address(e.usdc),
                        tickSpacing: STABLE_TICK_SPACING,
                        recipient: account,
                        deadline: block.timestamp,
                        amountIn: m.amountIn,
                        amountOutMinimum: m.minOut,
                        sqrtPriceLimitX96: 0
                    }))
            );
        } else if (venue == Venue.Uniswap) {
            swap = abi.encodeCall(
                IUniswapRouter.exactInputSingle,
                (IUniswapRouter.ExactInputSingleParams({
                        tokenIn: token,
                        tokenOut: address(e.usdc),
                        fee: USDE_FEE,
                        recipient: account,
                        amountIn: m.amountIn,
                        amountOutMinimum: m.minOut,
                        sqrtPriceLimitX96: 0
                    }))
            );
        } else {
            swap = abi.encodeCall(IPsm3.swapExactIn, (token, address(e.usdc), m.amountIn, m.minOut, account, 0));
        }
        calls[1] = PM.Call(router, 0, swap);
    }

    /// What a conversion's post-checks compare with.
    struct Before {
        address token;
        uint256 coin;
        uint256 cash;
        uint256 savings;
        uint256 mine; // the executor's balance of the coin
    }

    function snapshot(GooseExecutor.Env memory e, address account, address token) public view returns (Before memory) {
        return Before(
            token,
            IERC20(token).balanceOf(account),
            e.usdc.balanceOf(account),
            e.aUsdc.balanceOf(account),
            IERC20(token).balanceOf(address(this))
        );
    }

    /// A conversion's post-checks: the coin fell by exactly what was swapped, the wallet's USDC rose by at least the
    /// floor, savings didn't move, and the executor holds none of the coin. Returns the USDC the swap brought in.
    function check(GooseExecutor.Env memory e, address account, uint256 amountIn, uint256 minOut, Before memory b)
        public
        view
        returns (uint256 usdcOut)
    {
        if (IERC20(b.token).balanceOf(account) + amountIn != b.coin) revert GooseExecutor.WrongAmount();
        uint256 cash = e.usdc.balanceOf(account);
        if (cash < b.cash + minOut) revert GooseExecutor.BelowFloor();
        if (e.aUsdc.balanceOf(account) < b.savings) revert GooseExecutor.SavingsMoved();
        if (IERC20(b.token).balanceOf(address(this)) > b.mine) revert GooseExecutor.ExecutorGotFunds();
        return cash - b.cash;
    }
}
