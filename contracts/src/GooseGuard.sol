// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SSTORE2} from "solady/utils/SSTORE2.sol";
import {IJustaPermissionManager as PM} from "./IJustaPermissionManager.sol";
import {
    IAaveOracle,
    IAaveV3Pool,
    IAeroPool,
    IAeroRouter,
    IChainlinkFeed,
    IERC20,
    IPsm3,
    ISpoke,
    IUniswapRouter
} from "./IProtocols.sol";

/// @title GooseGuard
/// @notice The only GreedyGoose contract that can move money (guard-build/design/spec-final-v2.md). It is the spender of
///         every agent permission a user grants through JAW. A runner sends it moves; it builds every call itself, for
///         the user's own account only, runs them through JAW's permission manager and checks the result on live
///         reads. A move that breaks a rule is refused and retried at the next round; nothing switches itself off.
///
///         It plans nothing: GoosePlanner works out the moves and KeeperHub carries them here, so the Planner can be
///         replaced any day without users granting again. Every amount in a move is untrusted and bounded here.
///
///         The account registers its own approved permission per agent (only it can), and only the newest one counts.
///         The owner can pause Save, Rebalance and Turn into cash, never Protect, and every other change waits 48
///         hours in public. The owner can never move money.
contract GooseGuard {
    // ------------------------------------------------------------------ types

    /// One move for one account. `args` depend on the kind (spec §4).
    struct Move {
        address account;
        uint8 kind;
        uint256[] args;
    }

    /// One slot. `index` is the account's place in `members` plus one (0 = not a member).
    struct Account {
        uint24 index;
        uint8 jobs; // 1 << job for each registered agent
        uint32 rescueAt; // when the current rescue started; 0 = none
        uint32 sessionAt; // when the current Rebalance session opened
        address runner; // the one helper the account chose to send its moves (Q2); 0 = none
    }

    /// What the account chose. Written only by the account itself.
    struct Settings {
        uint112 mix; // 7 weights in BPS, 16 bits each, reserve r at bits [16r, 16r + 16)
        uint16 line; // Protect line in 1e-4 health; 0 = the default
        uint16 target; // Protect target in 1e-4 health
        uint32 mixSetAt;
        bool keepMix;
        bool topUpsOn;
        uint48 keep; // "Keep $X as cash", USDC units
    }

    /// The newest registered permission for one agent.
    struct Perm {
        address data; // SSTORE2 pointer to abi.encode(Permission)
        uint48 start; // the high-water start: never lowered, so only a newer grant can replace it
    }

    /// The mix's free stock (in the wallet) at Aave's prices, for one TRADE. Stocks outside the mix have price 0.
    struct Book {
        uint256[7] price; // Aave's price, 8 decimals
        uint256[7] wallet; // free shares before the trade
        uint256 total; // the mix's value plus the top-up, USDC units
        uint256 invest; // the top-up, USDC units
        uint112 mix;
    }

    /// One TRADE's running tally while its legs are checked in order.
    struct Pass {
        uint256 cash; // what the buys may still spend: the top-up plus the sales' floors so far
        uint256 seen; // a bit per stock already traded
        uint256 bought; // a bit per stock bought
        uint256 sales;
        bool buying; // a buy came: no more sales
    }

    /// A Protect move's reading before its batch.
    struct Before {
        uint256 debt;
        uint256 hf;
        uint256 target;
        uint32 rescueAt;
        bool rescuing;
        bool payoffOk;
    }

    // ------------------------------------------------------------------ constants: Base

    PM internal constant MANAGER = PM(0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8);
    ISpoke internal constant SPOKE = ISpoke(0x17905Db0e4A3514467539956c084180616AE7B8D);
    IAaveOracle internal constant ORACLE = IAaveOracle(0xaBaf048fD7675Ea34a84332371ffd5D55E322A47);
    IAaveV3Pool internal constant AAVE_V3_POOL = IAaveV3Pool(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);
    IERC20 internal constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20 internal constant AUSDC = IERC20(0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB);
    /// Aerodrome Slipstream's router: every stock sale and buy goes through it.
    address internal constant ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    uint256 internal constant USDC_RESERVE_ID = 7;
    /// JustanAccount's `ExecuteError(uint256 index, bytes reason)`: how a JAW account reports a call that failed.
    bytes4 internal constant EXECUTE_ERROR = 0x5a154675;
    /// Every stock pool is tick spacing 10 with USDC and a 0.05% fee (step0-facts.md, fact 7).
    int24 internal constant TICK_SPACING = 10;
    uint256 internal constant POOL_FEE_BPS = 5;

    // Turn into cash: the coins in CASH_COINS order (lib/tokens/stables.ts:106) and where each one swaps.
    address internal constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address internal constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address internal constant USDS = 0x820C137fa70C8691f0e44Dc420a5e53c168921Dc;
    address internal constant DAI = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
    address internal constant EURC = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42;
    /// Aerodrome's v1 Slipstream router: USDT and EURC, tick spacing 1. Same swap call as the stock router.
    address internal constant AERODROME_V1_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    /// Uniswap's SwapRouter02: USDe (fee 500) and DAI (fee 100).
    address internal constant UNISWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    /// Spark's PSM3: USDS for USDC, 1:1.
    address internal constant PSM3 = 0x1601843c5E9bC251A3272907010AFa41Fa18347E;
    /// Chainlink's EUR/USD, 8 decimals. It writes at least hourly, weekends included (step0-facts.md, fact 6).
    IChainlinkFeed internal constant EUR_USD = IChainlinkFeed(0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F);

    // ------------------------------------------------------------------ constants: rules

    uint8 internal constant SAVE = 0;
    uint8 internal constant REPAY = 1;
    uint8 internal constant SELL = 2;
    uint8 internal constant TRADE = 3;
    uint8 internal constant CONVERT = 4;
    uint8 internal constant END = 5;
    uint8 internal constant REFRESH = 6;

    /// Agents, in the app's JOBS order: Save, Protect, Protect · sell, Rebalance, Turn into cash.
    uint8 internal constant JOB_SAVE = 0;
    uint8 internal constant JOB_PROTECT = 1;
    uint8 internal constant JOB_SELL = 2;
    uint8 internal constant JOB_REBALANCE = 3;
    uint8 internal constant JOB_ENTRY = 4;
    uint8 internal constant JOBS = 5;

    uint256 internal constant WAD = 1e18;
    /// A user's own Protect line may never be lower (decision 3).
    uint256 internal constant LINE_MIN = 1.03e18;
    uint256 internal constant DEFAULT_LINE = 1.03e18;
    uint256 internal constant DEFAULT_TARGET = 1.12e18;
    uint256 internal constant TARGET_MAX = 1.4e18;
    uint256 internal constant TARGET_GAP = 0.05e18;
    /// How far past the target a Protect move may land.
    uint256 internal constant OVERSHOOT = 0.01e18;
    /// Back at the target, give or take Aave's rounding.
    uint256 internal constant DONE_GAP = 0.001e18;
    /// An unfinished rescue ends after this (decision 5).
    uint256 internal constant RESCUE_MAX_AGE = 7 days;
    /// A top-up goes into the mix only at this health or above (and above the user's line).
    uint256 internal constant INVEST_HF = 1.1e18;
    /// Rebalance sells in at most one session this long, then waits this gap, unless the user sets a new mix
    /// (decision 4).
    uint256 internal constant REBALANCE_SESSION = 1 hours;
    uint256 internal constant REBALANCE_GAP = 20 hours;
    /// EURC's price must be this fresh: Chainlink's hourly heartbeat plus an hour (decision 10).
    uint256 internal constant EURC_FEED_MAX_AGE = 2 hours;
    /// Every owner change waits this long, in public.
    uint256 internal constant DELAY = 48 hours;
    /// The largest permission an account may register.
    uint256 internal constant MAX_PERMISSION = 8192;

    /// Most gas a move's own frame may use, by kind: the cold worst case measured on a Base fork for an account backed
    /// by all seven stocks, where each of Aave's account reads costs about 391k, plus about 25% (GooseGuardGasFork).
    uint256 internal constant SAVE_GAS = 500_000;
    uint256 internal constant REPAY_GAS = 1_200_000;
    uint256 internal constant SELL_GAS = 1_300_000;
    uint256 internal constant SELL_LEG_GAS = 450_000; // each slice
    uint256 internal constant SELL_STOCK_GAS = 300_000; // each distinct stock sold, on top of its slices
    uint256 internal constant TRADE_GAS = 500_000;
    uint256 internal constant TRADE_LEG_GAS = 320_000;
    uint256 internal constant CONVERT_GAS = 660_000;
    uint256 internal constant REFRESH_GAS = 1_000_000;
    uint256 internal constant END_GAS = 520_000;
    /// Kept back for the perform's own loop and events after a move.
    uint256 internal constant LOOP_GAS = 60_000;

    // Owner change kinds.
    uint8 internal constant ADD_RUNNER = 0;
    uint8 internal constant REMOVE_RUNNER = 1;
    uint8 internal constant ALLOW_CODEHASH = 2;
    uint8 internal constant DISALLOW_CODEHASH = 3;
    uint8 internal constant SET_OWNER = 4;

    // ------------------------------------------------------------------ immutables (bounded in the constructor)

    /// Protect sells at most this far under Aave's price.
    uint256 public immutable SALE_FLOOR_BPS;
    /// Rebalance and Turn into cash swap at most this far under.
    uint256 public immutable SWAP_FLOOR_BPS;
    /// How far the pool's price may sit from Aave's, either way.
    uint256 public immutable BAND_BPS;
    /// A Rebalance trade's losing side, tighter than the band: past it, the pool can't fill at the swap floor after
    /// its 0.05% fee, so the trade is refused cheaply before the batch (step0-facts.md, change 5).
    uint256 public immutable TIGHT_BPS;
    /// Always left in the wallet, USDC units.
    uint256 public immutable KEEP_BACK;
    /// Protect may pay off the whole credit only when what's left at the target would be at most this (decision 6).
    uint256 public immutable DUST;

    // ------------------------------------------------------------------ storage

    address public owner;
    bool public paused;
    mapping(bytes32 id => uint256 eta) public queued;
    mapping(address runner => bool) public isRunner;
    mapping(bytes32 codehash => bool) public codehashOk;
    address[] public members;
    mapping(address account => Account) internal accounts;
    mapping(address account => Settings) internal settings;
    mapping(address account => mapping(uint8 job => Perm)) internal perms;
    bool transient _lock;

    // ------------------------------------------------------------------ events

    event JobOn(address indexed account, uint8 indexed job, uint48 start, uint48 end);
    event JobOff(address indexed account, uint8 indexed job);
    event ProtectRepaid(
        address indexed account, uint256 fromWallet, uint256 fromSavings, uint256 hfBefore, uint256 hfAfter
    );
    event ProtectSold(address indexed account, uint256[7] shares, uint256 repaid, uint256 hfBefore, uint256 hfAfter);
    event RescueEnded(address indexed account);
    event Saved(address indexed account, uint256 amount);
    event ConfigRefreshed(address indexed account, uint256 hfBefore, uint256 hfAfter);
    /// Shares sold and bought, by stock.
    event Rebalanced(address indexed account, uint256[7] sold, uint256[7] bought);
    event TopUpInvested(address indexed account, uint256 amount, uint256[7] bought);
    event EntryConverted(address indexed account, address indexed coin, uint256 amountIn, uint256 usdcOut);
    /// A move the Guard refused: a Guard error, or the failed call's own error selector, unwrapped from the account's
    /// ExecuteError (0 = out of gas or no reason).
    event Refused(address indexed account, uint8 indexed kind, bytes4 reason);
    /// The mix: 7 weights in BPS, 16 bits each, reserve r at bits [16r, 16r + 16).
    event MixSet(address indexed account, uint112 mix);
    event KeepMixSet(address indexed account, bool on);
    event TopUpsSet(address indexed account, bool on, uint48 keep);
    event ProtectSet(address indexed account, uint16 line, uint16 target);
    event RunnerSet(address indexed account, address runner);
    event Paused(bool on);
    event ChangeQueued(bytes32 indexed id, uint8 kind, bytes32 arg, uint256 eta);
    event ChangeApplied(bytes32 indexed id, uint8 kind, bytes32 arg);
    event ChangeCancelled(bytes32 indexed id);

    // ------------------------------------------------------------------ errors

    error Reentered();
    error NotOwner();
    error OnlySelf();
    error NotRunner();
    error NoGas();
    error BadKind();
    error BadArgs();
    error IsPaused();
    error NoGrant();
    error NothingOwed();
    error NotNeeded();
    error NothingToMove();
    error NotCollateral();
    error NoPrice();
    error OffBand();
    error BelowFloor();
    error DebtNotLower();
    error HealthLower();
    error Overshoot();
    error PaidOff();
    error StockMoved();
    error RescueOn();
    error BadJob();
    error TooLong();
    error CodeNotAllowed();
    error NotAccount();
    error NotSpender();
    error FutureStart();
    error Expired();
    error StaleGrant();
    error NotApproved();
    error TooManyMembers();
    error BadMix();
    error BadLines();
    error BadChange();
    error AlreadyQueued();
    error NotQueued();
    error TooEarly(uint256 eta);
    error NotNewOwner();
    error OutOfBounds();
    error NoGain();
    error NoMix();
    error NotInMix();
    error Crossed();
    error CashOut();
    error Paced();
    error NotTopUp();
    error HealthTooLow();
    error TooMuch();
    error StaleFeed();
    error CashLower();

    modifier nonReentrant() {
        if (_lock) revert Reentered();
        _lock = true;
        _;
        _lock = false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// The owner, KeeperHub as the only runner, JAW's clone codehash, and the floors. Each floor is fixed for good.
    constructor(
        address owner_,
        address runner,
        bytes32 cloneCodehash,
        uint256 saleFloorBps,
        uint256 swapFloorBps,
        uint256 bandBps,
        uint256 keepBack,
        uint256 dust
    ) {
        // 1 − the sale floor stays above the largest collateral factor (0.79), so a sale always raises health.
        if (saleFloorBps < 100 || saleFloorBps > 500) revert OutOfBounds();
        // Never under 99.5%; at least 0.30% keeps the Rebalance band's tight side positive.
        if (swapFloorBps < 30 || swapFloorBps > 50) revert OutOfBounds();
        if (bandBps < 25 || bandBps > 200) revert OutOfBounds();
        // Above the app's $0.50 fuel tank.
        if (keepBack < 0.6e6 || keepBack > 5e6) revert OutOfBounds();
        if (dust > 10e6) revert OutOfBounds();
        if (owner_ == address(0) || runner == address(0)) revert OutOfBounds();
        owner = owner_;
        isRunner[runner] = true;
        codehashOk[cloneCodehash] = true;
        SALE_FLOOR_BPS = saleFloorBps;
        SWAP_FLOOR_BPS = swapFloorBps;
        BAND_BPS = bandBps;
        TIGHT_BPS = _min(bandBps, swapFloorBps - POOL_FEE_BPS - 5);
        KEEP_BACK = keepBack;
        DUST = dust;
    }

    // ================================================================== moves

    /// Runs each move in its own gas-capped frame. A refused move emits `Refused` and the next one runs; the perform
    /// itself never reverts for a move's sake, because KeeperHub stops the round when a write reverts.
    function performUpkeep(bytes calldata performData) external nonReentrant {
        Move[] memory moves = abi.decode(performData, (Move[]));
        bool runner = isRunner[msg.sender];
        for (uint256 i; i < moves.length; ++i) {
            Move memory m = moves[i];
            // A stranger's move is skipped with no event, so nobody can write refusals for someone else's account.
            if (!runner && msg.sender != m.account && msg.sender != accounts[m.account].runner && m.kind != END) {
                continue;
            }
            uint256 cap = capOf(m.kind, m.args);
            // The 63/64 rule: without this, a short-gassed write would starve the frame and look like a refusal. For
            // the account or its own helper the perform reverts instead, so a gas estimate sizes the call to run it.
            if (gasleft() < cap * 64 / 63 + LOOP_GAS) {
                if (!runner) revert NoGas();
                emit Refused(m.account, m.kind, NoGas.selector);
                continue;
            }
            (bool ok, bytes4 reason) = _try(cap, abi.encodeCall(this.run, (m)));
            if (!ok) emit Refused(m.account, m.kind, reason);
        }
    }

    /// One move's frame: its checks, its batch and its post-checks, all rolled back together when any fails.
    function run(Move calldata m) external {
        if (msg.sender != address(this)) revert OnlySelf();
        uint8 kind = m.kind;
        // The owner's pause stops Save, Rebalance and Turn into cash; never Protect.
        if (paused && (kind == SAVE || kind == TRADE || kind == CONVERT)) revert IsPaused();
        if (kind == SAVE) _save(m.account, m.args);
        else if (kind == REPAY) _repay(m.account, m.args);
        else if (kind == SELL) _sell(m.account, m.args);
        else if (kind == TRADE) _trade(m.account, m.args);
        else if (kind == CONVERT) _convert(m.account, m.args);
        else if (kind == END) _end(m.account);
        else if (kind == REFRESH) _refresh(m.account);
        else revert BadKind();
    }

    /// Most gas a move's frame may use. A sale's cost grows with its slices and with each distinct stock it sells
    /// (measured: +363k a slice of the same stock, +598k a slice of another), so a seven-stock sale goes in two moves.
    function capOf(uint8 kind, uint256[] memory args) public pure returns (uint256) {
        if (kind == SAVE) return SAVE_GAS;
        if (kind == REPAY) return REPAY_GAS;
        if (kind == SELL) {
            uint256 seen;
            uint256 stocks;
            for (uint256 i; i < args.length; ++i) {
                uint256 r = args[i] >> 248;
                if (r < 7 && seen >> r & 1 == 0) {
                    seen |= 1 << r;
                    ++stocks;
                }
            }
            return SELL_GAS + SELL_LEG_GAS * args.length + SELL_STOCK_GAS * stocks;
        }
        if (kind == TRADE) return TRADE_GAS + TRADE_LEG_GAS * args.length;
        if (kind == CONVERT) return CONVERT_GAS;
        if (kind == REFRESH) return REFRESH_GAS;
        return END_GAS;
    }

    /// A self-call with a gas cap that copies at most 4 bytes of revert data, so a huge revert can't burn the
    /// perform's gas.
    function _try(uint256 cap, bytes memory data) internal returns (bool ok, bytes4 reason) {
        assembly ("memory-safe") {
            ok := call(cap, address(), 0, add(data, 0x20), mload(data), 0x00, 0x00)
            if and(iszero(ok), gt(returndatasize(), 3)) {
                returndatacopy(0x00, 0x00, 0x04)
                reason := shl(224, shr(224, mload(0x00)))
            }
        }
    }

    // ------------------------------------------------------------------ REPAY [fromWallet, fromSavings]

    /// Repays the credit from wallet cash and savings when health is under the line, or in a rescue under the target.
    /// The wallet goes first; $1 always stays in it.
    function _repay(address a, uint256[] calldata args) internal {
        if (args.length != 2) revert BadArgs();
        Before memory b = _protectBefore(a);
        uint256 cash = _bal(address(USDC), a);
        uint256 fromWallet = _min(args[0], cash > KEEP_BACK ? cash - KEEP_BACK : 0);
        uint256 fromSavings = _min(args[1], _bal(address(AUSDC), a));
        // Above the debt, savings are cut first, so the wallet pays first (M2).
        if (fromWallet + fromSavings > b.debt) {
            fromSavings = fromWallet >= b.debt ? 0 : b.debt - fromWallet;
            fromWallet = _min(fromWallet, b.debt);
        }
        uint256 total = fromWallet + fromSavings;
        if (total == 0) revert NothingToMove();

        PM.Call[] memory calls = new PM.Call[](fromSavings > 0 ? 3 : 2);
        uint256 n;
        if (fromSavings > 0) {
            calls[n++] =
                _call(address(AAVE_V3_POOL), abi.encodeCall(IAaveV3Pool.withdraw, (address(USDC), fromSavings, a)));
        }
        calls[n++] = _approve(address(USDC), address(SPOKE), total);
        calls[n] = _repayCall(a, total);
        _execute(a, JOB_PROTECT, calls);

        uint256 hfAfter = _protectAfter(a, b);
        emit ProtectRepaid(a, fromWallet, fromSavings, b.hf, hfAfter);
    }

    // ------------------------------------------------------------------ SELL [r << 248 | shares, …]

    /// Sells stock that backs the credit and repays with exactly each slice's floor. Each leg: withdraw from Aave,
    /// swap on Aerodrome at no less than Aave's price minus the sale floor, repay. The pool must agree with Aave's price
    /// within the band, either way, which also guards a weekend when Aave's prices stop updating (decision 7).
    function _sell(address a, uint256[] calldata legs) internal {
        uint256 n = legs.length;
        if (n == 0 || n > 16) revert BadArgs();

        // The per-stock checks come first: they are cheap, so a refusal on price costs little.
        uint256[7] memory sold;
        uint256[7] memory price;
        uint256[] memory minOut = new uint256[](n);
        uint256 repaid;
        for (uint256 i; i < n; ++i) {
            (uint256 r, uint256 shares) = _leg(legs[i]);
            if (sold[r] == 0) price[r] = _checkSale(a, r);
            sold[r] += shares;
            minOut[i] = shares * price[r] * (1e4 - SALE_FLOOR_BPS) / 1e14;
            if (minOut[i] == 0) revert BelowFloor();
            repaid += minOut[i];
        }
        Before memory b = _protectBefore(a);

        uint256[7] memory walletBefore;
        uint256 stocksSold;
        for (uint256 r; r < 7; ++r) {
            if (sold[r] == 0) continue;
            walletBefore[r] = _bal(_stock(r), a);
            ++stocksSold;
        }
        _execute(a, JOB_SELL, _sellCalls(a, legs, minOut, sold, repaid, stocksSold));

        // A short withdraw would let the swap take free stock from the wallet (step0-facts.md, fact 3).
        for (uint256 r; r < 7; ++r) {
            if (sold[r] > 0 && _bal(_stock(r), a) != walletBefore[r]) revert StockMoved();
        }
        uint256 hfAfter = _protectAfter(a, b);
        emit ProtectSold(a, sold, repaid, b.hf, hfAfter);
    }

    /// A sale leg's reserve and shares; the bits between them must be clear.
    function _leg(uint256 leg) internal pure returns (uint256 r, uint256 shares) {
        r = leg >> 248;
        shares = uint128(leg);
        if (r >= 7 || shares == 0 || leg >> 128 & type(uint120).max != 0) revert BadArgs();
    }

    /// Stock r may be sold for the account now: it backs the credit, Aave prices it, and the pool agrees with Aave
    /// within the band either way. Returns Aave's price.
    function _checkSale(address a, uint256 r) internal view returns (uint256 price) {
        (bool collateral,) = SPOKE.getUserReserveStatus(r, a);
        if (!collateral) revert NotCollateral();
        price = _price(r);
        _checkBand(r, price, BAND_BPS, BAND_BPS);
    }

    /// Aave's price for stock r, 8 decimals.
    function _price(uint256 r) internal view returns (uint256 price) {
        price = ORACLE.getReservePrice(r);
        if (price == 0) revert NoPrice();
    }

    /// Stock r's pool price is at most `below` under Aave's price and at most `above` over it, in BPS.
    function _checkBand(uint256 r, uint256 price, uint256 below, uint256 above) internal view {
        uint256 pool = _poolPrice(r);
        if (pool * 1e4 < price * (1e4 - below) || pool * 1e4 > price * (1e4 + above)) revert OffBand();
    }

    function _sellCalls(
        address a,
        uint256[] calldata legs,
        uint256[] memory minOut,
        uint256[7] memory sold,
        uint256 repaid,
        uint256 stocksSold
    ) internal view returns (PM.Call[] memory calls) {
        calls = new PM.Call[](1 + stocksSold + 3 * legs.length);
        calls[0] = _approve(address(USDC), address(SPOKE), repaid);
        uint256 k = 1;
        for (uint256 r; r < 7; ++r) {
            if (sold[r] > 0) calls[k++] = _approve(_stock(r), ROUTER, sold[r]);
        }
        for (uint256 i; i < legs.length; ++i) {
            k = _addSaleLeg(calls, k, a, legs[i], minOut[i]);
        }
    }

    /// One sale leg's three calls: withdraw the shares from Aave, swap them for at least `minOut`, repay `minOut`.
    function _addSaleLeg(PM.Call[] memory calls, uint256 k, address a, uint256 leg, uint256 minOut)
        internal
        view
        returns (uint256)
    {
        (uint256 r, uint256 shares) = _leg(leg);
        calls[k] = _call(address(SPOKE), abi.encodeCall(ISpoke.withdraw, (r, shares, a)));
        calls[k + 1] = _swapCall(ROUTER, TICK_SPACING, _stock(r), address(USDC), a, shares, minOut);
        calls[k + 2] = _repayCall(a, minOut);
        return k + 3;
    }

    /// An Aerodrome Slipstream swap of exactly `amountIn` for at least `minOut`, paid to the account, no price limit.
    function _swapCall(
        address router,
        int24 tickSpacing,
        address tokenIn,
        address tokenOut,
        address a,
        uint256 amountIn,
        uint256 minOut
    ) internal view returns (PM.Call memory) {
        IAeroRouter.ExactInputSingleParams memory swap = IAeroRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            tickSpacing: tickSpacing,
            recipient: a,
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });
        return _call(router, abi.encodeCall(IAeroRouter.exactInputSingle, (swap)));
    }

    // ------------------------------------------------------------------ SAVE [amount]

    /// Moves wallet cash above the $1 keep-back into the account's own Aave V3 savings. With top-ups on, only up to
    /// Keep: the rest waits in the wallet to go into the mix, since savings never go into stock (decision 1).
    function _save(address a, uint256[] calldata args) internal {
        if (args.length != 1) revert BadArgs();
        uint256 cash = _bal(address(USDC), a);
        uint256 room = cash > KEEP_BACK ? cash - KEEP_BACK : 0;
        Settings storage s = settings[a];
        if (s.topUpsOn) {
            uint256 savings = _bal(address(AUSDC), a);
            room = _min(room, s.keep > savings ? s.keep - savings : 0);
        }
        uint256 amount = _min(args[0], room);
        if (amount == 0) revert NothingToMove();
        PM.Call[] memory calls = new PM.Call[](2);
        calls[0] = _approve(address(USDC), address(AAVE_V3_POOL), amount);
        calls[1] = _call(address(AAVE_V3_POOL), abi.encodeCall(IAaveV3Pool.supply, (address(USDC), amount, a, 0)));
        _execute(a, JOB_SAVE, calls);
        emit Saved(a, amount);
    }

    // ------------------------------------------------------------------ TRADE [invest, r << 248 | isBuy << 247 | amount, …]

    /// Brings the mix of free stock (in the wallet) back toward the user's weights at Aave's prices, or puts a top-up
    /// from the wallet into the mix. Every trade moves its stock toward its target and stops there, so a runner can
    /// only trade the drift, at no less than Aave's price minus the swap floor. Sales come first and fund the buys; a
    /// top-up only buys; a move that sells is paced to one session a day unless the user set a new mix (decision 4).
    /// There is no Aave call, so savings and stock that backs credit are out of reach.
    function _trade(address a, uint256[] calldata args) internal {
        uint256 n = args.length;
        if (n < 2 || n > 8) revert BadArgs();
        Settings memory s = settings[a];
        if (s.mix == 0) revert NoMix();
        if (args[0] > 0) _checkInvest(a, s, args[0]);
        Book memory b = _book(a, s.mix, args[0]);

        Pass memory p = Pass(b.invest, 0, 0, 0, false);
        uint256[7] memory sold;
        PM.Call[] memory calls = new PM.Call[](2 * (n - 1));
        for (uint256 i = 1; i < n; ++i) {
            _tradeLeg(a, args[i], b, p, sold, calls, 2 * (i - 1));
        }
        if (p.sales > 0) _pace(a, s.mixSetAt);

        uint256 cashBefore = _bal(address(USDC), a);
        _execute(a, JOB_REBALANCE, calls);
        if (_bal(address(USDC), a) + b.invest < cashBefore) revert CashLower();

        uint256[7] memory bought;
        for (uint256 r; r < 7; ++r) {
            if (p.bought >> r & 1 == 1) bought[r] = _bal(_stock(r), a) - b.wallet[r];
        }
        if (p.sales > 0) emit Rebalanced(a, sold, bought);
        else emit TopUpInvested(a, b.invest - p.cash, bought);
    }

    /// One leg: checks it and writes its approve and swap at `calls[k]` and `calls[k + 1]`. A sale may only take a
    /// stock down to its target, a buy only up to it; each stock trades once, and only stocks in the mix.
    function _tradeLeg(
        address a,
        uint256 leg,
        Book memory b,
        Pass memory p,
        uint256[7] memory sold,
        PM.Call[] memory calls,
        uint256 k
    ) internal view {
        uint256 r = leg >> 248;
        uint256 amount = uint128(leg);
        // bits 128..246 clear, and each stock once
        if (r >= 7 || amount == 0 || leg >> 128 & (1 << 119) - 1 != 0 || p.seen >> r & 1 == 1) revert BadArgs();
        p.seen |= 1 << r;
        uint256 price = b.price[r];
        if (price == 0) revert NotInMix();
        uint256 value = b.wallet[r] * price / 1e10;
        uint256 target = b.total * _weight(b.mix, r) / 1e4;
        if (leg >> 247 & 1 == 1) {
            if (target <= value || amount > target - value) revert Crossed();
            if (amount > p.cash) revert CashOut();
            _checkBand(r, price, BAND_BPS, TIGHT_BPS);
            uint256 minShares = amount * 1e10 * (1e4 - SWAP_FLOOR_BPS) / (price * 1e4);
            if (minShares == 0) revert BelowFloor();
            p.cash -= amount;
            p.buying = true;
            p.bought |= 1 << r;
            calls[k] = _approve(address(USDC), ROUTER, amount);
            calls[k + 1] = _swapCall(ROUTER, TICK_SPACING, address(USDC), _stock(r), a, amount, minShares);
        } else {
            if (p.buying || b.invest > 0) revert BadArgs(); // sales come first; a top-up only buys
            if (value <= target || amount * price / 1e10 > value - target) revert Crossed();
            _checkBand(r, price, TIGHT_BPS, BAND_BPS);
            uint256 minOut = amount * price * (1e4 - SWAP_FLOOR_BPS) / 1e14;
            if (minOut == 0) revert BelowFloor();
            p.cash += minOut;
            ++p.sales;
            sold[r] = amount;
            calls[k] = _approve(_stock(r), ROUTER, amount);
            calls[k + 1] = _swapCall(ROUTER, TICK_SPACING, _stock(r), address(USDC), a, amount, minOut);
        }
    }

    /// A top-up goes into the mix only from wallet cash above $1 and above what Keep still needs in savings, only with
    /// top-ups on, and never during a rescue or under health max(1.10, line): Protect may need that cash (decision 1).
    function _checkInvest(address a, Settings memory s, uint256 invest) internal view {
        if (!s.topUpsOn) revert NotTopUp();
        uint256 rescueAt = accounts[a].rescueAt;
        if (rescueAt != 0 && block.timestamp <= rescueAt + RESCUE_MAX_AGE) revert RescueOn();
        if (_debt(a) > 0) {
            (uint256 line,) = linesOf(a);
            if (_data(a).healthFactor < (line > INVEST_HF ? line : INVEST_HF)) revert HealthTooLow();
        }
        uint256 savings = _bal(address(AUSDC), a);
        uint256 keepShort = s.keep > savings ? s.keep - savings : 0;
        if (invest + keepShort + KEEP_BACK > _bal(address(USDC), a)) revert TooMuch();
    }

    /// The mix's free stock at Aave's prices. Targets are taken on the total plus the top-up, so a top-up into a mix
    /// on target buys every stock pro rata (rebalance trap 2).
    function _book(address a, uint112 mix, uint256 invest) internal view returns (Book memory b) {
        b.mix = mix;
        b.invest = invest;
        b.total = invest;
        for (uint256 r; r < 7; ++r) {
            if (_weight(mix, r) == 0) continue;
            b.price[r] = _price(r);
            b.wallet[r] = _bal(_stock(r), a);
            b.total += b.wallet[r] * b.price[r] / 1e10;
        }
    }

    /// A move that sells opens a session when the user set a new mix since the last one, or 20 hours after it opened;
    /// otherwise it must fall within the open session's hour.
    function _pace(address a, uint32 mixSetAt) internal {
        Account storage acc = accounts[a];
        uint256 sessionAt = acc.sessionAt;
        if (mixSetAt > sessionAt || block.timestamp >= sessionAt + REBALANCE_GAP) {
            acc.sessionAt = uint32(block.timestamp);
        } else if (block.timestamp >= sessionAt + REBALANCE_SESSION) {
            revert Paced();
        }
    }

    /// Stock r's weight in the mix, in BPS.
    function _weight(uint112 mix, uint256 r) internal pure returns (uint256) {
        return uint256(mix) >> (16 * r) & type(uint16).max;
    }

    // ------------------------------------------------------------------ CONVERT [k, amountIn]

    /// Turns a dollar coin in the wallet into USDC at no less than 99.5% of its face value (EURC: of its value at
    /// Chainlink's EUR/USD). No pool band: the floor is the bound, the move only goes one way, and PSM3 can't be
    /// sandwiched.
    function _convert(address a, uint256[] calldata args) internal {
        if (args.length != 2 || args[0] > 4) revert BadArgs();
        uint256 k = args[0];
        address coin = k == 0 ? USDT : k == 1 ? USDE : k == 2 ? USDS : k == 3 ? DAI : EURC;
        uint256 amountIn = _min(args[1], _bal(coin, a));
        if (amountIn == 0) revert NothingToMove();
        // Dollars a coin, 8 decimals; USDT and EURC have 6 decimals, the others 18.
        uint256 rate = coin == EURC ? _eurUsd() : 1e8;
        uint256 scale = coin == USDT || coin == EURC ? 1 : 1e12;
        uint256 minOut = _ceilDiv(amountIn * rate * (1e4 - SWAP_FLOOR_BPS), scale * 1e12);
        if (minOut == 0) revert BelowFloor();

        uint256 cashBefore = _bal(address(USDC), a);
        PM.Call[] memory calls = new PM.Call[](2);
        if (k == 1 || k == 3) {
            calls[0] = _approve(coin, UNISWAP_ROUTER, amountIn);
            IUniswapRouter.ExactInputSingleParams memory swap = IUniswapRouter.ExactInputSingleParams({
                tokenIn: coin,
                tokenOut: address(USDC),
                fee: k == 1 ? 500 : 100,
                recipient: a,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            });
            calls[1] = _call(UNISWAP_ROUTER, abi.encodeCall(IUniswapRouter.exactInputSingle, (swap)));
        } else if (k == 2) {
            calls[0] = _approve(coin, PSM3, amountIn);
            calls[1] = _call(PSM3, abi.encodeCall(IPsm3.swapExactIn, (coin, address(USDC), amountIn, minOut, a, 0)));
        } else {
            calls[0] = _approve(coin, AERODROME_V1_ROUTER, amountIn);
            calls[1] = _swapCall(AERODROME_V1_ROUTER, 1, coin, address(USDC), a, amountIn, minOut);
        }
        _execute(a, JOB_ENTRY, calls);
        uint256 cashAfter = _bal(address(USDC), a);
        if (cashAfter < cashBefore + minOut) revert BelowFloor();
        emit EntryConverted(a, coin, amountIn, cashAfter - cashBefore);
    }

    /// EUR/USD, 8 decimals; refused when Chainlink's answer is not positive or older than its hourly heartbeat plus an
    /// hour.
    function _eurUsd() internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = EUR_USD.latestRoundData();
        if (answer <= 0 || updatedAt + EURC_FEED_MAX_AGE < block.timestamp) revert StaleFeed();
        return uint256(answer);
    }

    // ------------------------------------------------------------------ REFRESH []

    /// When Aave raises a collateral factor, a withdraw's config refresh alone would lift health past the target, so
    /// every sale would be refused. This applies the latest config on its own, only when it raises health (spec §4.7).
    /// Only the account may refresh itself (step0-facts.md, fact 5), so it runs under the Protect · sell permission.
    function _refresh(address a) internal {
        if (_debt(a) == 0) revert NothingOwed();
        uint256 hfBefore = _data(a).healthFactor;
        PM.Call[] memory calls = new PM.Call[](1);
        calls[0] = _call(address(SPOKE), abi.encodeCall(ISpoke.updateUserDynamicConfig, (a)));
        _execute(a, JOB_SELL, calls);
        uint256 hfAfter = _data(a).healthFactor;
        if (hfAfter <= hfBefore) revert NoGain();
        emit ConfigRefreshed(a, hfBefore, hfAfter);
    }

    // ------------------------------------------------------------------ END []

    /// Ends a rescue that is finished (nothing owed, or back at the target) or older than 7 days. Anyone may send it.
    function _end(address a) internal {
        Account storage acc = accounts[a];
        uint256 rescueAt = acc.rescueAt;
        if (rescueAt == 0) revert NotNeeded();
        if (block.timestamp <= rescueAt + RESCUE_MAX_AGE && _debt(a) > 0) {
            (, uint256 target) = linesOf(a);
            if (_data(a).healthFactor + DONE_GAP < target) revert RescueOn();
        }
        acc.rescueAt = 0;
        emit RescueEnded(a);
    }

    // ------------------------------------------------------------------ Protect's rule

    /// The gate: something is owed, and health is under the line, or a rescue is on and health is under the target.
    function _protectBefore(address a) internal view returns (Before memory b) {
        b.debt = _debt(a);
        if (b.debt == 0) revert NothingOwed();
        ISpoke.UserAccountData memory d = _data(a);
        (uint256 line, uint256 target) = linesOf(a);
        b.hf = d.healthFactor;
        b.target = target;
        b.rescueAt = accounts[a].rescueAt;
        b.rescuing = b.rescueAt != 0 && block.timestamp <= uint256(b.rescueAt) + RESCUE_MAX_AGE;
        if (b.hf >= line && !(b.rescuing && b.hf + DONE_GAP < target)) revert NotNeeded();
        // The whole credit may be paid off only when what's left at the target would be dust (decision 6).
        uint256 power = d.totalCollateralValue * d.avgCollateralFactor / WAD;
        b.payoffOk = power * WAD / (target + OVERSHOOT) <= DUST * 1e20;
    }

    /// After a Protect batch: the credit fell, health didn't (H6: a sale's refresh may not leave the account weaker on
    /// Aave's own reading), it landed at most 0.01 past the target, and it paid off everything only when allowed.
    /// Then the rescue is kept, started or ended.
    function _protectAfter(address a, Before memory b) internal returns (uint256 hf) {
        uint256 debt = _debt(a);
        if (debt >= b.debt) revert DebtNotLower();
        hf = debt == 0 ? type(uint256).max : _data(a).healthFactor;
        if (hf < b.hf) revert HealthLower();
        if (debt > 0 && hf > b.target + OVERSHOOT) revert Overshoot();
        if (debt == 0 && !b.payoffOk) revert PaidOff();
        bool stillShort = debt > 0 && hf + DONE_GAP < b.target;
        accounts[a].rescueAt = stillShort ? (b.rescuing ? b.rescueAt : uint32(block.timestamp)) : 0;
    }

    // ------------------------------------------------------------------ the permission

    /// Runs `calls` through the manager under the account's newest permission for `job`. The Guard never decodes the
    /// permission: it splices the stored tuple into `executeBatch(permission, calls)` calldata exactly as
    /// `abi.encodeCall` lays it out (GooseGuard.t.sol checks this byte for byte). The manager decodes it and checks it
    /// is approved, not revoked and in its time window.
    function _execute(address a, uint8 job, PM.Call[] memory calls) internal {
        if (accounts[a].jobs & (1 << job) == 0) revert NoGrant();
        bytes memory tuple = SSTORE2.read(perms[a][job].data);
        bytes memory list = abi.encode(calls);
        assembly ("memory-safe") {
            // Drop `list`'s leading offset word: what's left is the array's own encoding (length, then elements).
            let n := sub(mload(list), 0x20)
            list := add(list, 0x20)
            mstore(list, n)
        }
        // Two dynamic arguments: their two offsets, then the permission's tuple, then the calls.
        (bool ok, bytes memory reason) = address(MANAGER).call(
            abi.encodePacked(PM.executeBatch.selector, uint256(0x40), 0x40 + tuple.length, tuple, list)
        );
        if (!ok) {
            // A JAW account wraps a failed call as ExecuteError(index, reason). Pass the call's own reason up, so a
            // refusal says why: Aave's health check, a swap's floor, a token's transfer policy. A call that gave no
            // reason stays ExecuteError, so it never reads as running out of gas (an empty reason).
            if (reason.length >= 4 && bytes4(reason) == EXECUTE_ERROR) {
                assembly ("memory-safe") {
                    // the error's arguments, (uint256 index, bytes reason), start 4 bytes in
                    let args := add(reason, 4)
                    mstore(args, sub(mload(reason), 4))
                    reason := args
                }
                (, bytes memory inner) = abi.decode(reason, (uint256, bytes));
                reason = inner.length >= 4 ? inner : abi.encodePacked(EXECUTE_ERROR);
            }
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    // ================================================================== registration

    /// The account registers its own approved permission for one agent, in the same batch as `manager.approve`:
    /// `permission` is `abi.encode(Permission)`. Only the newest counts: its start must be later than any this agent
    /// had. The Guard reads only the head words it needs (account, spender, start, end); the manager checks the rest
    /// before every batch, so a malformed or unapproved permission only makes its own account's moves refuse.
    function register(uint8 job, bytes calldata permission) external nonReentrant {
        if (job >= JOBS) revert BadJob();
        if (permission.length < 0x100 || permission.length > MAX_PERMISSION) revert TooLong();
        if (!codehashOk[msg.sender.codehash]) revert CodeNotAllowed();
        // abi.encode(Permission): the tuple's offset (0x20), then account, spender, start, end, salt, … .
        if (_word(permission, 0) != 0x20) revert BadArgs();
        if (_word(permission, 1) != uint160(msg.sender)) revert NotAccount();
        if (_word(permission, 2) != uint160(address(this))) revert NotSpender();
        uint256 start = _word(permission, 3);
        uint256 end = _word(permission, 4);
        if (start > block.timestamp) revert FutureStart();
        if (end < block.timestamp || end > type(uint48).max) revert Expired();
        Perm storage g = perms[msg.sender][job];
        if (start <= g.start) revert StaleGrant();
        // Approved in JAW's manager and not revoked: an unusable grant would only fill the Planner's writes with
        // refusals (adversarial review, finding 1). `permission` is exactly the calldata of a one-struct call.
        if (!_managerSays(PM.isApproved.selector, permission) || _managerSays(PM.isRevoked.selector, permission)) {
            revert NotApproved();
        }
        g.data = SSTORE2.write(permission[0x20:]); // the tuple itself, ready to splice into executeBatch
        g.start = uint48(start);

        Account storage acc = accounts[msg.sender];
        if (acc.index == 0) {
            if (members.length >= type(uint24).max) revert TooManyMembers();
            members.push(msg.sender);
            acc.index = uint24(members.length);
        }
        acc.jobs |= uint8(1 << job);
        emit JobOn(msg.sender, job, uint48(start), uint48(end));
    }

    /// The manager's answer to `isApproved(permission)` or `isRevoked(permission)`; false if it can't answer.
    function _managerSays(bytes4 selector, bytes calldata permission) internal view returns (bool) {
        (bool ok, bytes memory ret) = address(MANAGER).staticcall(abi.encodePacked(selector, permission));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    /// Word `i` of `data`.
    function _word(bytes calldata data, uint256 i) internal pure returns (uint256) {
        return uint256(bytes32(data[i * 32:i * 32 + 32]));
    }

    /// Switches an agent off. Its permission stays readable and its start stays the high-water mark.
    function unregister(uint8 job) external nonReentrant {
        if (job >= JOBS) revert BadJob();
        accounts[msg.sender].jobs &= ~uint8(1 << job);
        emit JobOff(msg.sender, job);
    }

    // ================================================================== settings (the account itself)

    /// The account's mix, packed: 7 weights in BPS, 16 bits each, reserve r at bits [16r, 16r + 16). They add up to
    /// 10,000, or all are 0 (no mix).
    function setMix(uint112 mix) external nonReentrant {
        uint256 sum;
        for (uint256 r; r < 7; ++r) {
            sum += _weight(mix, r);
        }
        if (sum != 1e4 && sum != 0) revert BadMix();
        Settings storage s = settings[msg.sender];
        s.mix = mix;
        s.mixSetAt = uint32(block.timestamp);
        emit MixSet(msg.sender, mix);
    }

    function setKeepMix(bool on) external nonReentrant {
        settings[msg.sender].keepMix = on;
        emit KeepMixSet(msg.sender, on);
    }

    function setTopUps(bool on, uint48 keep) external nonReentrant {
        Settings storage s = settings[msg.sender];
        s.topUpsOn = on;
        s.keep = keep;
        emit TopUpsSet(msg.sender, on, keep);
    }

    /// The account's own Protect line and target, in 1e-4 health; (0, 0) = the defaults, 1.03 and 1.12 (decision 3).
    function setProtect(uint16 line, uint16 target) external nonReentrant {
        if (line != 0 || target != 0) {
            if (uint256(line) * 1e14 < LINE_MIN) revert BadLines();
            if (uint256(target) * 1e14 < uint256(line) * 1e14 + TARGET_GAP) revert BadLines();
            if (uint256(target) * 1e14 > TARGET_MAX) revert BadLines();
        }
        Settings storage s = settings[msg.sender];
        s.line = line;
        s.target = target;
        emit ProtectSet(msg.sender, line, target);
    }

    /// The one helper that may send this account's moves, under the same rules (Q2); 0 = none.
    function setRunner(address runner) external nonReentrant {
        accounts[msg.sender].runner = runner;
        emit RunnerSet(msg.sender, runner);
    }

    /// Ends the caller's own rescue at any time; the app sends it whenever the user takes more credit or repays by
    /// hand (decision 5). Does nothing when no rescue is on, so it never fails the user's batch.
    function endRescue() external nonReentrant {
        Account storage acc = accounts[msg.sender];
        if (acc.rescueAt == 0) return;
        acc.rescueAt = 0;
        emit RescueEnded(msg.sender);
    }

    // ================================================================== owner

    /// Stops Save, Rebalance and Turn into cash at once. Never Protect.
    function pause() external onlyOwner {
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Paused(false);
    }

    /// Starts a change's 48-hour wait. `arg` is the address (as bytes32) or the codehash.
    function queueChange(uint8 kind, bytes32 arg) external onlyOwner returns (bytes32 id) {
        _checkChange(kind, arg);
        id = keccak256(abi.encode(kind, arg));
        if (queued[id] != 0) revert AlreadyQueued();
        uint256 eta = block.timestamp + DELAY;
        queued[id] = eta;
        emit ChangeQueued(id, kind, arg, eta);
    }

    function cancelChange(bytes32 id) external onlyOwner {
        if (queued[id] == 0) revert NotQueued();
        delete queued[id];
        emit ChangeCancelled(id);
    }

    /// Anyone may apply a change once its wait is over, except a new owner, who must apply their own.
    function applyChange(uint8 kind, bytes32 arg) external nonReentrant {
        bytes32 id = keccak256(abi.encode(kind, arg));
        uint256 eta = queued[id];
        if (eta == 0) revert NotQueued();
        if (block.timestamp < eta) revert TooEarly(eta);
        _checkChange(kind, arg);
        delete queued[id];
        address who = address(uint160(uint256(arg)));
        if (kind == ADD_RUNNER) {
            isRunner[who] = true;
        } else if (kind == REMOVE_RUNNER) {
            isRunner[who] = false;
        } else if (kind == ALLOW_CODEHASH) {
            codehashOk[arg] = true;
        } else if (kind == DISALLOW_CODEHASH) {
            codehashOk[arg] = false;
        } else {
            if (msg.sender != who) revert NotNewOwner();
            owner = who;
        }
        emit ChangeApplied(id, kind, arg);
    }

    function _checkChange(uint8 kind, bytes32 arg) internal pure {
        if (kind > SET_OWNER) revert BadChange();
        if (kind == ALLOW_CODEHASH || kind == DISALLOW_CODEHASH) return;
        if (arg == 0 || uint256(arg) >> 160 != 0) revert BadChange();
    }

    // ================================================================== views

    /// One read for the app and the Planner: the account's state and its settings. Its permissions, including each
    /// one's start (the high-water mark), come from `permissionOf`.
    function accountOf(address a) external view returns (Account memory, Settings memory) {
        return (accounts[a], settings[a]);
    }

    function membersLength() external view returns (uint256) {
        return members.length;
    }

    /// The account's Protect line and target, WAD.
    function linesOf(address a) public view returns (uint256 line, uint256 target) {
        Settings storage s = settings[a];
        if (s.line == 0) return (DEFAULT_LINE, DEFAULT_TARGET);
        return (uint256(s.line) * 1e14, uint256(s.target) * 1e14);
    }

    /// The account's newest permission for `job`, as it registered it (abi.encode(Permission)); empty if none.
    function permissionOf(address a, uint8 job) external view returns (bytes memory) {
        address data = perms[a][job].data;
        return data == address(0) ? new bytes(0) : bytes.concat(bytes32(uint256(0x20)), SSTORE2.read(data));
    }

    // ================================================================== stocks and pools

    /// The seven stocks, by Aave reserve id (lib/tokens/registry.ts).
    function _stock(uint256 r) internal pure returns (address) {
        if (r == 0) return 0xb200000000000000000000C2e324d24d7eEcd1fb; // AAPLc
        if (r == 1) return 0xb200000000000000000000d9192b6B456483C2E8; // AMZNc
        if (r == 2) return 0xb2000000000000000000002D0BA3164cc74f58B7; // GOOGLc
        if (r == 3) return 0xb2000000000000000000008bC8786B856E61707C; // METAc
        if (r == 4) return 0xB200000000000000000000Ab99cFa739E253872B; // MSFTc
        if (r == 5) return 0xb20000000000000000000078ee7ce2fE4908108C; // NVDAc
        return 0xb2000000000000000000001e800a7f5189430cD0; // TSLAc
    }

    /// Each stock's Aerodrome Slipstream pool with USDC, tick spacing 10 (step0-facts.md; the deploy test checks them
    /// against the factory). USDC is token0 in all seven.
    function _pool(uint256 r) internal pure returns (address) {
        if (r == 0) return 0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0;
        if (r == 1) return 0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b;
        if (r == 2) return 0xB1987CAD1682841b4b641d50E520777eC5Ab5542;
        if (r == 3) return 0xEAF57753BC382E0324a1D43F72E7027705a2273E;
        if (r == 4) return 0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54;
        if (r == 5) return 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;
        return 0x469337fDcc5E8f38e2E4B670B04F57865D13a7BB;
    }

    /// Stock r's pool price in USDC a share, 8 decimals like Aave's (JobBase.priceOf with USDC as token0).
    function _poolPrice(uint256 r) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,) = IAeroPool(_pool(r)).slot0();
        uint256 q = (uint256(1) << 96) * 1e10 / sqrtPriceX96; // √(raw USDC a raw share) × 1e10
        return q * q / 1e10;
    }

    /// What the account owes, in USDC units.
    function _debt(address a) internal view returns (uint256) {
        return SPOKE.getUserTotalDebt(USDC_RESERVE_ID, a);
    }

    /// Aave's reading of the account, on its stored config (the one liquidations use: step0-facts.md, fact 4).
    function _data(address a) internal view returns (ISpoke.UserAccountData memory) {
        return SPOKE.getUserAccountData(a);
    }

    function _bal(address token, address a) internal view returns (uint256) {
        return IERC20(token).balanceOf(a);
    }

    /// One call for the account to make.
    function _call(address target, bytes memory data) internal pure returns (PM.Call memory) {
        return PM.Call(target, 0, data);
    }

    /// `token.approve(spender, amount)` by the account. The manager resets every approval after the batch.
    function _approve(address token, address spender, uint256 amount) internal pure returns (PM.Call memory) {
        return PM.Call(token, 0, abi.encodeCall(IERC20.approve, (spender, amount)));
    }

    /// Aave V4 repays `amount` of the account's own USDC credit.
    function _repayCall(address a, uint256 amount) internal pure returns (PM.Call memory) {
        return PM.Call(address(SPOKE), 0, abi.encodeCall(ISpoke.repay, (USDC_RESERVE_ID, amount, a)));
    }

    function _ceilDiv(uint256 x, uint256 y) internal pure returns (uint256) {
        return (x + y - 1) / y;
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }
}
