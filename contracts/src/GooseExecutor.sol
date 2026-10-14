// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AutomationCompatibleInterface} from "chainlink/automation/interfaces/AutomationCompatibleInterface.sol";
import {ILogAutomation, Log} from "chainlink/automation/interfaces/ILogAutomation.sol";
import {IJustaPermissionManager as PM} from "./IJustaPermissionManager.sol";
import {IAaveOracle, IAaveV3Pool, IERC20, ISpoke} from "./IProtocols.sol";
import {Amounts, ProtectCase, Thresholds} from "./CashRules.sol";
import {NyCalendar} from "./NyCalendar.sol";
import {SellLimits} from "./SellRules.sol";
import {JobBase} from "./jobs/JobBase.sol";
import {ProtectJob} from "./jobs/ProtectJob.sol";
import {SaveJob} from "./jobs/SaveJob.sol";
import {SellJob} from "./jobs/SellJob.sol";

/// @title GooseExecutor
/// @notice The GreedyGoose agent contract (contracts/docs/GooseExecutor.md). It is the spender of every agent
///         permission an account grants through JAW's own screen (D14), keeps the on-chain list of which accounts have
///         which agent on, runs each agent's rule, builds every call itself, sends it through JAW's permission
///         manager and checks the result. Chainlink Automation calls it; there is no server (D12).
///
///         It runs the Cash Agent: Save (wallet USDC above the keep-back goes to Aave V3 savings), Protect from
///         savings (a loan that slips below the trigger is repaid from savings, and before a price freeze a fragile
///         one is trimmed), and Protect · sell (when savings can't keep the credit Safe, some of the stock that backs
///         it is sold to repay, after a heads-up).
///
///         JAW's screen grants with every checker set to 0, so the manager only enforces targets, selectors, the
///         spender and the daily limits. Every argument is pinned here: each call is built for the account alone, and
///         the post-checks revert any move that does anything else.
///
///         This contract is the core: the registry, who may run, pause and the delayed changes, the paging, the
///         per-account try/catch and the checks every move must pass. Each job's own rule (its permission template,
///         when and how much to move, the calls and its post-checks) is a linked library in src/jobs, so new jobs
///         fit under the 24 KB limit (GooseExecutor-as-built.md, "Job modules").
/// @dev Immutable logic. A new rule is a new contract, so a new spender and a new grant for every user. The job
///      libraries' addresses are linked into this bytecode at deploy and their code can't change.
contract GooseExecutor is AutomationCompatibleInterface, ILogAutomation {
    /// A job's bit in `Account.jobs` is `1 << uint8(job)`.
    enum Job {
        Save,
        Protect,
        ProtectSell
    }

    /// What a `performUpkeep` call carries: a run over listed accounts, or a registration found by `checkLog`.
    enum Mode {
        Run,
        Register
    }

    enum Action {
        None,
        Prune,
        Repay,
        Save,
        Sell,
        HeadsUp,
        ClearHeadsUp,
        Defer // a sale that doesn't fit in the gas left waits for the next run
    }

    enum OffReason {
        Revoked,
        Expired,
        NotOwner,
        Stuck
    }

    enum Change {
        AddForwarder,
        SetThresholds,
        SetAmounts,
        SetHoliday,
        AllowCodehash,
        SetOwner,
        SetSellLimits
    }

    /// What the user signed that the template doesn't fix. One slot.
    struct Grant {
        uint48 start;
        uint48 end;
        uint160 cap; // daily limit in USDC units
    }

    /// One slot.
    struct Account {
        uint8 jobs; // bit set of Job
        uint32 index; // 1 + position in `members`; 0 = never registered
        uint8 fails; // failed runs in a row
        uint48 cooldownUntil;
        uint32 savesDay; // New York day of the last Save
        uint8 savesToday;
        uint48 headsUpAt; // Protect · sell: when the pending heads-up went out; 0 = none. A sale cut short sets it
        // a full delay back, so the rest goes on without a new wait
        bool keepMix; // Protect · sell: the same share of each holding, instead of the most safety per dollar first
    }

    /// What all accounts sold into one stock's pool in the current window (SellJob.POOL_WINDOW). One slot.
    struct PoolUse {
        uint48 start;
        uint208 sold; // USDC units at Aave's price
    }

    /// What a run would do for one account right now.
    struct Plan {
        Action action;
        Job job;
        uint256 amount; // USDC units (Repay, Save; Sell and HeadsUp: what the sale repays)
        uint256 hf; // health factor before the move, WAD, or as the job read it (max: nothing owed)
        uint8 reason; // Repay: a ProtectCase, Watch or WeekendShield. Sell, HeadsUp: 1 when the sale is at once (Act)
        OffReason off; // Prune
    }

    struct Config {
        PM manager;
        IAaveV3Pool aaveV3Pool;
        ISpoke spoke;
        IERC20 usdc;
        IERC20 aUsdc;
        uint256 usdcReserveId;
        IAaveOracle oracle; // the spoke's oracle
        address router; // Aerodrome Slipstream's swap router
        address[7] stocks; // by reserve id
        uint160 capMax;
        uint32 pageSize;
        address owner;
        bytes32[] codehashes;
        Thresholds thresholds;
        Amounts amounts;
        SellLimits sellLimits;
    }

    struct Balances {
        uint256 usdc;
        uint256 aUsdc;
        uint256 eth;
    }

    /// What the core hands a job's library for one account: the grant it signed and the numbers the job may need.
    struct Ctx {
        address account;
        Grant grant;
        uint256 salt;
        uint256 terms;
        bool frozen; // stock prices are held (NyCalendar)
        bool preFreeze; // Weekend Shield's window
        uint256 hf; // Aave's health factor, if a job earlier in the run read it (max: nothing owed); 0 if not
        Thresholds thresholds;
        Amounts amounts;
        SellLimits sellLimits;
    }

    /// The addresses fixed at deploy, handed to the job libraries (which can't read this contract's immutables).
    struct Env {
        PM manager;
        IAaveV3Pool aaveV3Pool;
        ISpoke spoke;
        IERC20 usdc;
        IERC20 aUsdc;
        uint256 usdcReserveId;
        IAaveOracle oracle;
        address router;
        address[7] stocks;
        uint160 capMax;
    }

    // ------------------------------------------------------------------ constants

    /// Most gas the manager's batch may use for one account (one Protect batch measured at about 404k).
    uint256 public constant ACCOUNT_GAS = JobBase.ACCOUNT_GAS;
    /// Kept per account for its reads, post-checks and bookkeeping.
    uint256 internal constant RESERVE_GAS = 300_000;
    /// Most gas one account's Cash run may use, all included: an account starts only with this much left.
    uint256 internal constant RUN_GAS = ACCOUNT_GAS + RESERVE_GAS;
    /// Most gas one account's run may use with a sale: planning it, SellJob's batch, its post-checks. A sale that
    /// doesn't find enough left is deferred to the next run.
    uint256 internal constant MAX_RUN_GAS = 4_200_000;
    /// The jobs, in the order a run tries them: Protect from savings, then by selling, then Save.
    uint8 internal constant JOBS = 3;
    /// `checkUpkeep` stops scanning below this.
    uint256 internal constant CHECK_RESERVE = 1_500_000;
    /// Most accounts per `performUpkeep`.
    uint256 public constant MAX_WORK = 8;
    /// Product decision 2: a new forwarder, threshold, holiday, codehash or owner waits this long, in public.
    uint48 public constant DELAY = 7 days;
    /// Failed runs in a row before an account's jobs are switched off.
    uint8 internal constant MAX_FAILS = 8;
    /// First cooldown after a failure; it doubles with each one (10 min … about 21 h).
    uint48 internal constant BASE_COOLDOWN = 10 minutes;
    /// A holiday may be set at most this many days ahead.
    uint256 internal constant HOLIDAY_HORIZON = 800;
    uint32 internal constant MAX_PAGE_SIZE = 200;

    // ------------------------------------------------------------------ immutables

    PM public immutable MANAGER;
    IAaveV3Pool public immutable AAVE_V3_POOL;
    ISpoke public immutable SPOKE;
    IERC20 public immutable USDC;
    IERC20 public immutable AUSDC;
    uint256 public immutable USDC_RESERVE_ID;
    /// Most a daily limit may be. $5 on test deploys (D13).
    uint160 public immutable CAP_MAX;
    /// Accounts per check page, set from a fork measurement of the worst case.
    uint32 public immutable PAGE_SIZE;
    /// The spoke's price oracle: the only price behind a sale's floor and limits.
    IAaveOracle public immutable ORACLE;
    /// Aerodrome Slipstream's router, where Protect sells: its stock pools hold $0.44M–1.57M of USDC, Uniswap's
    /// under $60k (2026-10-14).
    address public immutable ROUTER;
    // The seven stocks, by reserve id (lib/tokens/registry.ts).
    address internal immutable STOCK0;
    address internal immutable STOCK1;
    address internal immutable STOCK2;
    address internal immutable STOCK3;
    address internal immutable STOCK4;
    address internal immutable STOCK5;
    address internal immutable STOCK6;

    // ------------------------------------------------------------------ storage

    mapping(address account => Account) public accounts;
    mapping(address account => mapping(Job => Grant)) internal grants;
    mapping(address account => mapping(Job => uint256)) internal salts;
    /// What else the user signed, packed by the job: Protect · sell's daily limit per stock (SellJob).
    mapping(address account => mapping(Job => uint256)) internal terms;
    /// Append-only. Page p is members[p * PAGE_SIZE, (p + 1) * PAGE_SIZE).
    address[] public members;
    /// Code an account must run to register: JAW's account proxy, or its EIP-7702 delegation.
    mapping(bytes32 codehash => bool) public allowedCodehash;

    Thresholds public thresholds;
    Amounts public amounts;
    SellLimits public sellLimits;
    /// The app-wide cap on Protect's sales into each stock's pool, by reserve id.
    mapping(uint256 reserveId => PoolUse) public pools;
    /// New York days when the stock prices are held (NyCalendar).
    mapping(uint32 day => bool) public holiday;

    address public owner;
    bool public paused;
    bool public bootstrapped;
    mapping(address => bool) public isForwarder;
    mapping(bytes32 id => uint48 eta) public queued;
    uint256 public changeNonce;

    bool private transient _entered;

    // ------------------------------------------------------------------ events

    event JobOn(address indexed account, Job indexed job, bytes32 permissionHash, uint160 cap, uint48 end);
    event JobOff(address indexed account, Job indexed job, OffReason reason);
    event Saved(address indexed account, uint256 amount);
    event ProtectRepaid(address indexed account, uint256 amount, uint256 hfBefore, uint256 hfAfter, ProtectCase reason);
    /// A sale comes `sellAfter` unless the health is back above the heads-up line by then: the app's "Add $X, or
    /// Protect sells $Y". `sellValue` is the stock it would sell now, in USDC at Aave's price.
    event SellHeadsUp(address indexed account, uint256 hf, uint256 sellValue, uint48 sellAfter);
    event SellHeadsUpCleared(address indexed account, uint256 hf);
    /// `shares` by reserve id; `repaid` in USDC units; `atOnce` when it sold without a heads-up, below the Act line.
    event ProtectSold(
        address indexed account, uint256[7] shares, uint256 repaid, uint256 hfBefore, uint256 hfAfter, bool atOnce
    );
    event KeepMixSet(address indexed account, bool on);
    event RunFailed(address indexed account, bytes4 reason, uint8 fails);
    event RunDeferred(address indexed account);
    event PageOpened(uint32 indexed page);

    event Paused(bool paused);
    event ForwarderSet(address indexed forwarder, bool allowed);
    event CodehashSet(bytes32 indexed codehash, bool allowed);
    event OwnerSet(address indexed owner);
    event HolidaySet(uint32 indexed day, bool on);
    event ChangeQueued(bytes32 indexed id, Change kind, bytes value, uint256 nonce, uint48 eta);
    event ChangeApplied(bytes32 indexed id);
    event ChangeCancelled(bytes32 indexed id);

    // ------------------------------------------------------------------ errors

    error AccountNotAllowed();
    error ManagerNotOwner();
    error CapOutOfBounds();
    error BadWindow();
    error NotApproved();
    error BadTerms();
    error StaleGrant();
    error JobNotOn();
    error StillOn();
    error NotForwarder();
    error OnlySelf();
    error RunsPaused();
    error TooMuchWork();
    error DebtNotLower();
    error HealthLower();
    error HealthNotHigher();
    error StockMoved();
    error BackingMoved();
    error SavingsMoved();
    error CashLower();
    error WrongAmount();
    error SavingsNotUp();
    error ExecutorGotFunds();
    error NotOwner();
    error AlreadyBootstrapped();
    error ZeroValue();
    error OutOfBounds();
    error NotQueued();
    error TooEarly(uint48 eta);
    error Reentered();

    modifier nonReentrant() {
        if (_entered) revert Reentered();
        _entered = true;
        _;
        _entered = false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// No forwarder yet: a forwarder exists only once its upkeep is registered, which needs this address. The owner
    /// adds the first ones once with `bootstrap`.
    constructor(Config memory c) {
        if (
            address(c.manager) == address(0) || address(c.aaveV3Pool) == address(0) || address(c.spoke) == address(0)
                || address(c.usdc) == address(0) || address(c.aUsdc) == address(0) || address(c.oracle) == address(0)
                || c.router == address(0) || c.owner == address(0)
        ) revert ZeroValue();
        for (uint256 r; r < 7; ++r) {
            if (c.stocks[r] == address(0)) revert ZeroValue();
        }
        if (c.capMax == 0 || c.pageSize == 0 || c.pageSize > MAX_PAGE_SIZE) revert OutOfBounds();
        ProtectJob.checkThresholds(c.thresholds);
        SaveJob.checkAmounts(c.amounts);
        SellJob.checkLimits(c.sellLimits);
        MANAGER = c.manager;
        AAVE_V3_POOL = c.aaveV3Pool;
        SPOKE = c.spoke;
        USDC = c.usdc;
        AUSDC = c.aUsdc;
        USDC_RESERVE_ID = c.usdcReserveId;
        CAP_MAX = c.capMax;
        PAGE_SIZE = c.pageSize;
        ORACLE = c.oracle;
        ROUTER = c.router;
        (STOCK0, STOCK1, STOCK2, STOCK3, STOCK4, STOCK5, STOCK6) =
        (c.stocks[0], c.stocks[1], c.stocks[2], c.stocks[3], c.stocks[4], c.stocks[5], c.stocks[6]);
        sellLimits = c.sellLimits;
        owner = c.owner;
        thresholds = c.thresholds;
        amounts = c.amounts;
        for (uint256 i; i < c.codehashes.length; ++i) {
            _setCodehash(c.codehashes[i], true);
        }
        emit OwnerSet(c.owner);
    }

    // ================================================================== registry

    /// Switches `job` on for `account` with the permission it approved through JAW's screen. Anyone may call it: it
    /// moves no money and checks everything on-chain. A newer grant for the same job replaces the stored one; the same
    /// grant again changes nothing. `t` is the job's terms: Protect · sell's daily limit per stock (SellJob), 0 for
    /// the Cash Agent's other jobs.
    function register(Job job, address account, uint48 start, uint48 end, uint256 salt, uint160 cap, uint256 t)
        external
        nonReentrant
    {
        _register(job, account, start, end, salt, cap, t);
    }

    /// "Keep my mix" for Protect · sell: sell the same share of each holding instead of the most safety per dollar
    /// first. Only the account itself sets it, in one Face ID.
    function setKeepMix(bool on) external nonReentrant {
        accounts[msg.sender].keepMix = on;
        emit KeepMixSet(msg.sender, on);
    }

    /// Switches `job` off once its permission is dead: revoked, past its end, or the manager no longer owns the account.
    /// Anyone may call it. Runs do the same when they meet a dead permission.
    function prune(address account, Job job) external nonReentrant {
        if (accounts[account].jobs & _bit(job) == 0) revert JobNotOn();
        Grant memory g = grants[account][job];
        if (block.timestamp > g.end) return _jobOff(account, job, OffReason.Expired);
        (bool alive, OffReason off) =
            JobBase.alive(MANAGER, _permission(job, account, g, salts[account][job], terms[account][job]));
        if (alive) revert StillOn();
        _jobOff(account, job, off);
    }

    /// Log trigger on the manager's PermissionApproved. The spender is only in the log's data, so every JAW grant on
    /// the chain is checked here, off-chain, and only an exact GooseExecutor template becomes work. `performUpkeep`
    /// then registers it through `_register`, which checks everything again on-chain.
    function checkLog(Log calldata log, bytes memory)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        if (log.source != address(MANAGER) || log.topics.length != 2 || log.topics[0] != PM.PermissionApproved.selector)
        {
            return (false, "");
        }
        PM.Permission memory p = abi.decode(log.data, (PM.Permission));
        if (p.spender != address(this) || p.spends.length == 0) return (false, "");
        uint160 cap = p.spends[0].allowance;
        if (cap == 0 || cap > CAP_MAX || p.start >= p.end || block.timestamp > p.end) return (false, "");
        bytes32 signed = keccak256(abi.encode(p));
        for (uint8 j; j < JOBS; ++j) {
            Job job = Job(j);
            uint256 t;
            if (job == Job.ProtectSell) {
                t = SellJob.termsFrom(_env(), p);
                if (!SellJob.termsOk(_env(), t)) continue;
            }
            if (keccak256(abi.encode(_permission(job, p.account, Grant(p.start, p.end, cap), p.salt, t))) != signed) {
                continue;
            }
            if (!_isNewer(job, p.account, p.start, p.salt)) return (false, "");
            return (true, abi.encode(Mode.Register, abi.encode(job, p.account, p.start, p.end, p.salt, cap, t)));
        }
    }

    // ================================================================== running

    /// Finds accounts with work in one page of `members`. `checkData` = abi.encode(uint256 shard, uint256 shards): this
    /// upkeep owns the pages p with p % shards == shard and scans one of them per block, in turn, so one upkeep
    /// serves every page as the list grows. More shards (new upkeeps, each with a forwarder behind the delay) only
    /// if one can't keep up. Each pass over a page starts one account further on, so a page that runs out of gas or
    /// fills MAX_WORK early still gets looked at in full over the next passes. Sales are listed first, lowest health
    /// first, so they have the gas and the pools' room before anything else.
    function checkUpkeep(bytes calldata checkData)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        if (paused) return (false, "");
        (uint256 shard, uint256 shards) = abi.decode(checkData, (uint256, uint256));
        uint256 pages = (members.length + PAGE_SIZE - 1) / PAGE_SIZE;
        if (shard >= shards || shard >= pages) return (false, "");
        uint256 owned = (pages - shard - 1) / shards + 1;
        uint256 from = (shard + shards * (block.number % owned)) * PAGE_SIZE;
        uint256 size = members.length - from < PAGE_SIZE ? members.length - from : PAGE_SIZE;
        uint256 first = block.number / owned % size;

        address[] memory work = new address[](MAX_WORK);
        uint256[] memory order = new uint256[](MAX_WORK);
        uint256 n;
        for (uint256 i; i < size && n < MAX_WORK && gasleft() >= CHECK_RESERVE; ++i) {
            address account = members[from + (first + i) % size];
            if (!_due(accounts[account])) continue;
            // Any revert (an Aave or oracle read) skips this account only.
            try this.planOf(account) returns (Plan memory p) {
                if (p.action == Action.None) continue;
                uint256 key = p.action == Action.Sell ? p.hf : type(uint256).max;
                uint256 k = n++;
                for (; k > 0 && order[k - 1] > key; --k) {
                    (work[k], order[k]) = (work[k - 1], order[k - 1]);
                }
                (work[k], order[k]) = (account, key);
            } catch {}
        }
        if (n == 0) return (false, "");
        assembly ("memory-safe") {
            mstore(work, n)
        }
        return (true, abi.encode(Mode.Run, abi.encode(work)));
    }

    /// Only the forwarders. `performData` is never trusted: a registration is checked again in full, and for a run
    /// only the account addresses are taken from it; every amount is re-read and re-planned.
    function performUpkeep(bytes calldata performData)
        external
        override(AutomationCompatibleInterface, ILogAutomation)
        nonReentrant
    {
        if (!isForwarder[msg.sender]) revert NotForwarder();
        (Mode mode, bytes memory data) = abi.decode(performData, (Mode, bytes));
        if (mode == Mode.Register) {
            (Job job, address account, uint48 start, uint48 end, uint256 salt, uint160 cap, uint256 t) =
                abi.decode(data, (Job, address, uint48, uint48, uint256, uint160, uint256));
            return _register(job, account, start, end, salt, cap, t); // works while paused: it moves no money
        }
        if (paused) revert RunsPaused();
        address[] memory list = abi.decode(data, (address[]));
        if (list.length > MAX_WORK) revert TooMuchWork();
        (bool frozen_, bool preFreeze) = _clock(block.timestamp);
        for (uint256 i; i < list.length; ++i) {
            address account = list[i];
            Account memory a = accounts[account];
            if (!_due(a) || _seenBefore(list, i)) continue;
            if (gasleft() < RUN_GAS + RESERVE_GAS) {
                emit RunDeferred(account); // the next check lists it again
                return;
            }
            // Each account runs in its own capped sub-call: a revert anywhere in it, the manager's spend bookkeeping
            // included, rolls back that account alone. RESERVE_GAS always stays behind for the catch.
            uint256 gas = gasleft() - RESERVE_GAS;
            try this.runAccount{gas: gas < MAX_RUN_GAS ? gas : MAX_RUN_GAS}(account, frozen_, preFreeze) returns (
                bool deferred
            ) {
                if (deferred) {
                    emit RunDeferred(account);
                    return;
                }
                if (a.fails != 0) accounts[account].fails = 0;
            } catch (bytes memory reason) {
                _fail(account, reason);
            }
        }
    }

    /// One account's run: Protect from savings, then by selling, then Save, and at most one move. A dead permission
    /// switches its job off on the way. Returns true when a sale didn't fit in the gas left. Only callable by this
    /// contract, from `performUpkeep`.
    function runAccount(address account, bool frozen_, bool preFreeze) external returns (bool deferred) {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 hf; // read by the first job that needs it, then passed on
        for (uint8 j; j < JOBS; ++j) {
            Job job = _priority(j);
            if (accounts[account].jobs & _bit(job) == 0) continue;
            Grant memory g = grants[account][job];
            if (block.timestamp < g.start) continue; // JAW takes the start from the browser's clock
            if (block.timestamp > g.end) {
                _jobOff(account, job, OffReason.Expired);
                continue;
            }
            Balances memory mine = _ownBalances();
            Plan memory p = _runJob(job, _ctx(account, job, g, frozen_, preFreeze, hf));
            hf = p.hf;
            if (p.action == Action.None) continue;
            if (p.action == Action.Prune) {
                _jobOff(account, job, p.off);
                continue;
            }
            if (p.action == Action.Defer) return true;
            _checkOwnBalances(mine);
            return false;
        }
    }

    /// What a run would do for `account` now: the first job, in priority order, with a move or a dead permission.
    function planOf(address account) external view returns (Plan memory p) {
        (bool frozen_, bool preFreeze) = _clock(block.timestamp);
        uint8 jobs = accounts[account].jobs;
        uint256 hf; // read by the first job that needs it, then passed on
        for (uint8 j; j < JOBS; ++j) {
            Job job = _priority(j);
            if (jobs & _bit(job) == 0) continue;
            p = _planJob(account, job, frozen_, preFreeze, hf);
            if (p.action != Action.None) return p;
            hf = p.hf;
        }
    }

    // ================================================================== views

    /// The account's switches, grants and failure state. Replaces the app's browser-only record.
    function jobsOf(address account)
        external
        view
        returns (uint8 jobs, Grant memory save, Grant memory protect, uint8 fails, uint48 cooldownUntil)
    {
        Account memory a = accounts[account];
        return (a.jobs, grants[account][Job.Save], grants[account][Job.Protect], a.fails, a.cooldownUntil);
    }

    /// The permission the account approved for `job`, rebuilt from the template, its grant, its salt and its terms.
    function permissionOf(address account, Job job) external view returns (PM.Permission memory) {
        return _permission(job, account, grants[account][job], salts[account][job], terms[account][job]);
    }

    /// The seven stocks, by reserve id.
    function stocks() public view returns (address[7] memory) {
        return [STOCK0, STOCK1, STOCK2, STOCK3, STOCK4, STOCK5, STOCK6];
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    /// Whether the stock prices are held at `ts`.
    function frozen(uint256 ts) external view returns (bool) {
        return NyCalendar.frozen(holiday, ts);
    }

    /// When the next price freeze starts (`ts` itself while frozen).
    function nextFreeze(uint256 ts) external view returns (uint256) {
        return NyCalendar.nextFreeze(holiday, ts);
    }

    // ================================================================== admin (product decision 2)

    /// At once.
    function pause() external nonReentrant onlyOwner {
        paused = true;
        emit Paused(true);
    }

    /// At once: it only brings back the same rules.
    function unpause() external nonReentrant onlyOwner {
        paused = false;
        emit Paused(false);
    }

    /// The first forwarders, once, with no delay: the run upkeep's and the registration upkeep's.
    function bootstrap(address[] calldata forwarders) external nonReentrant onlyOwner {
        if (bootstrapped) revert AlreadyBootstrapped();
        bootstrapped = true;
        for (uint256 i; i < forwarders.length; ++i) {
            _setForwarder(forwarders[i]);
        }
    }

    /// At once: it only takes power away.
    function removeForwarder(address forwarder) external nonReentrant onlyOwner {
        isForwarder[forwarder] = false;
        emit ForwarderSet(forwarder, false);
    }

    /// At once: it only stops new registrations.
    function disallowCodehash(bytes32 codehash) external nonReentrant onlyOwner {
        allowedCodehash[codehash] = false;
        emit CodehashSet(codehash, false);
    }

    /// Everything else waits `DELAY` in public. `value` is abi-encoded: an address (AddForwarder, SetOwner), a
    /// Thresholds, an Amounts, (uint32 day, bool on) for SetHoliday, a bytes32 codehash, or a SellLimits.
    function queueChange(Change kind, bytes calldata value)
        external
        nonReentrant
        onlyOwner
        returns (bytes32 id, uint48 eta)
    {
        _checkChange(kind, value);
        uint256 nonce = changeNonce++;
        id = keccak256(abi.encode(kind, value, nonce));
        eta = uint48(block.timestamp) + DELAY;
        queued[id] = eta;
        emit ChangeQueued(id, kind, value, nonce, eta);
    }

    /// Bounds are checked again when the change lands.
    function applyChange(Change kind, bytes calldata value, uint256 nonce) external nonReentrant onlyOwner {
        bytes32 id = keccak256(abi.encode(kind, value, nonce));
        uint48 eta = queued[id];
        if (eta == 0) revert NotQueued();
        if (block.timestamp < eta) revert TooEarly(eta);
        delete queued[id];
        _checkChange(kind, value);
        if (kind == Change.AddForwarder) {
            _setForwarder(abi.decode(value, (address)));
        } else if (kind == Change.SetThresholds) {
            thresholds = abi.decode(value, (Thresholds));
        } else if (kind == Change.SetAmounts) {
            amounts = abi.decode(value, (Amounts));
        } else if (kind == Change.SetHoliday) {
            (uint32 day, bool on) = abi.decode(value, (uint32, bool));
            holiday[day] = on;
            emit HolidaySet(day, on);
        } else if (kind == Change.AllowCodehash) {
            _setCodehash(abi.decode(value, (bytes32)), true);
        } else if (kind == Change.SetSellLimits) {
            sellLimits = abi.decode(value, (SellLimits));
        } else {
            owner = abi.decode(value, (address));
            emit OwnerSet(owner);
        }
        emit ChangeApplied(id);
    }

    function cancelChange(bytes32 id) external nonReentrant onlyOwner {
        if (queued[id] == 0) revert NotQueued();
        delete queued[id];
        emit ChangeCancelled(id);
    }

    // ================================================================== internals: registry

    function _register(Job job, address account, uint48 start, uint48 end, uint256 salt, uint160 cap, uint256 t)
        internal
    {
        if (!allowedCodehash[account.codehash]) revert AccountNotAllowed();
        if (!JobBase.managerOwns(MANAGER, account)) revert ManagerNotOwner();
        if (cap == 0 || cap > CAP_MAX) revert CapOutOfBounds();
        if (start >= end || block.timestamp > end) revert BadWindow();
        if (job == Job.ProtectSell ? !SellJob.termsOk(_env(), t) : t != 0) revert BadTerms();
        Grant memory g = Grant(start, end, cap);
        PM.Permission memory p = _permission(job, account, g, salt, t);
        if (!MANAGER.isApproved(p) || MANAGER.isRevoked(p)) revert NotApproved();
        if (!_isNewer(job, account, start, salt)) {
            if (accounts[account].jobs & _bit(job) != 0 && salts[account][job] == salt) return; // already on
            revert StaleGrant();
        }

        Account storage a = accounts[account];
        bool newGrant = salts[account][job] != salt;
        grants[account][job] = g;
        salts[account][job] = salt;
        terms[account][job] = t;
        a.jobs |= _bit(job);
        // Failures carry over when the same grant comes back (say, after Stuck); a new grant starts clean.
        if (newGrant) {
            a.fails = 0;
            a.cooldownUntil = 0;
        }
        if (a.index == 0) {
            if (members.length % PAGE_SIZE == 0) emit PageOpened(uint32(members.length / PAGE_SIZE));
            members.push(account);
            a.index = uint32(members.length);
        }
        emit JobOn(account, job, MANAGER.getHash(p), cap, end);
    }

    /// A grant can be registered when the job is off, or when it is a different grant that started no earlier than
    /// the stored one. So an older grant the user never revoked can't replace a newer one.
    function _isNewer(Job job, address account, uint48 start, uint256 salt) internal view returns (bool) {
        if (accounts[account].jobs & _bit(job) == 0) return true;
        return salts[account][job] != salt && start >= grants[account][job].start;
    }

    function _jobOff(address account, Job job, OffReason reason) internal {
        accounts[account].jobs &= ~_bit(job);
        emit JobOff(account, job, reason);
    }

    /// The template the user approved for `job`, with checker 0 everywhere as JAW's screen grants it (MANAGER-NOTES
    /// §5), in the same order as the app's grant request (lib/agents/permissions.ts).
    function _permission(Job job, address account, Grant memory g, uint256 salt, uint256 t)
        internal
        view
        returns (PM.Permission memory)
    {
        if (job == Job.Save) return SaveJob.permission(_env(), account, g, salt, t);
        if (job == Job.Protect) return ProtectJob.permission(_env(), account, g, salt, t);
        return SellJob.permission(_env(), account, g, salt, t);
    }

    // ================================================================== internals: rules

    /// What `job` would do for `account` now. A grant that hasn't started waits; one past its end is pruned.
    function _planJob(address account, Job job, bool frozen_, bool preFreeze, uint256 hf)
        internal
        view
        returns (Plan memory p)
    {
        p.job = job;
        Grant memory g = grants[account][job];
        if (block.timestamp < g.start) return p; // JAW takes the start from the browser's clock
        if (block.timestamp > g.end) {
            p.action = Action.Prune;
            p.off = OffReason.Expired;
            return p;
        }
        Ctx memory c = _ctx(account, job, g, frozen_, preFreeze, hf);
        if (job == Job.Save) return SaveJob.plan(_env(), c, accounts[account], pools);
        if (job == Job.Protect) return ProtectJob.plan(_env(), c, accounts[account], pools);
        return SellJob.plan(_env(), c, accounts[account], pools);
    }

    /// Plans the job again from fresh reads and makes its move, if any, through its library.
    function _runJob(Job job, Ctx memory c) internal returns (Plan memory) {
        if (job == Job.Save) return SaveJob.run(_env(), c, accounts[c.account], pools);
        if (job == Job.Protect) return ProtectJob.run(_env(), c, accounts[c.account], pools);
        return SellJob.run(_env(), c, accounts[c.account], pools);
    }

    function _ctx(address account, Job job, Grant memory g, bool frozen_, bool preFreeze, uint256 hf)
        internal
        view
        returns (Ctx memory)
    {
        return Ctx({
            account: account,
            grant: g,
            salt: salts[account][job],
            terms: job == Job.ProtectSell ? terms[account][job] : 0,
            frozen: frozen_,
            preFreeze: preFreeze,
            hf: hf,
            thresholds: thresholds,
            amounts: amounts,
            sellLimits: sellLimits
        });
    }

    function _env() internal view returns (Env memory) {
        return Env(MANAGER, AAVE_V3_POOL, SPOKE, USDC, AUSDC, USDC_RESERVE_ID, ORACLE, ROUTER, stocks(), CAP_MAX);
    }

    /// The order a run tries the jobs in: Protect from savings, then by selling, then Save.
    function _priority(uint8 j) internal pure returns (Job) {
        return j == 0 ? Job.Protect : j == 1 ? Job.ProtectSell : Job.Save;
    }

    /// Whether stock prices are held at `ts`, and whether it is in Weekend Shield's window: prices are live and the
    /// next freeze starts within `weekendWindow`.
    function _clock(uint256 ts) internal view returns (bool frozen_, bool preFreeze) {
        frozen_ = NyCalendar.frozen(holiday, ts);
        preFreeze = !frozen_ && NyCalendar.nextFreeze(holiday, ts) - ts <= amounts.weekendWindow;
    }

    // ================================================================== internals: post-checks

    /// Funds never mix: a move must leave nothing with the executor. Compared with before the move rather than with 0,
    /// so a stray transfer to this contract can't stop every run.
    function _ownBalances() internal view returns (Balances memory) {
        return Balances(USDC.balanceOf(address(this)), AUSDC.balanceOf(address(this)), address(this).balance);
    }

    function _checkOwnBalances(Balances memory before) internal view {
        Balances memory now_ = _ownBalances();
        if (now_.usdc > before.usdc || now_.aUsdc > before.aUsdc || now_.eth > before.eth) revert ExecutorGotFunds();
    }

    /// Back off after a failure: 10 minutes, doubling each time; after MAX_FAILS in a row the jobs go off (Stuck)
    /// until a new grant comes in.
    function _fail(address account, bytes memory reason) internal {
        Account storage a = accounts[account];
        uint8 fails = a.fails < MAX_FAILS ? a.fails + 1 : MAX_FAILS;
        a.fails = fails;
        a.cooldownUntil = uint48(block.timestamp) + (BASE_COOLDOWN << (fails - 1));
        emit RunFailed(account, bytes4(reason), fails);
        if (fails < MAX_FAILS) return;
        for (uint8 j; j < JOBS; ++j) {
            if (a.jobs & _bit(Job(j)) != 0) _jobOff(account, Job(j), OffReason.Stuck);
        }
    }

    function _due(Account memory a) internal view returns (bool) {
        return a.jobs != 0 && a.cooldownUntil <= block.timestamp;
    }

    function _seenBefore(address[] memory list, uint256 i) internal pure returns (bool) {
        for (uint256 k; k < i; ++k) {
            if (list[k] == list[i]) return true;
        }
        return false;
    }

    function _bit(Job job) internal pure returns (uint8) {
        return uint8(1 << uint8(job));
    }

    // ================================================================== internals: admin

    function _setForwarder(address forwarder) internal {
        if (forwarder == address(0)) revert ZeroValue();
        isForwarder[forwarder] = true;
        emit ForwarderSet(forwarder, true);
    }

    function _setCodehash(bytes32 codehash, bool allowed) internal {
        if (codehash == bytes32(0)) revert ZeroValue();
        allowedCodehash[codehash] = allowed;
        emit CodehashSet(codehash, allowed);
    }

    function _checkChange(Change kind, bytes calldata value) internal view {
        if (kind == Change.SetThresholds) return ProtectJob.checkThresholds(abi.decode(value, (Thresholds)));
        if (kind == Change.SetAmounts) return SaveJob.checkAmounts(abi.decode(value, (Amounts)));
        if (kind == Change.SetSellLimits) return SellJob.checkLimits(abi.decode(value, (SellLimits)));
        if (kind == Change.SetHoliday) {
            (uint32 day,) = abi.decode(value, (uint32, bool));
            uint256 today = NyCalendar.day(block.timestamp);
            if (day < today || day > today + HOLIDAY_HORIZON) revert OutOfBounds();
            return;
        }
        if (kind == Change.AllowCodehash) {
            if (abi.decode(value, (bytes32)) == bytes32(0)) revert ZeroValue();
            return;
        }
        if (abi.decode(value, (address)) == address(0)) revert ZeroValue(); // AddForwarder, SetOwner
    }
}
