// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AutomationCompatibleInterface} from "chainlink/automation/interfaces/AutomationCompatibleInterface.sol";
import {IJustaPermissionManager as PM} from "./IJustaPermissionManager.sol";
import {IAaveOracle, IAaveV3Pool, IERC20, ISpoke} from "./IProtocols.sol";
import {Amounts, ProtectCase, Thresholds, TopUps} from "./CashRules.sol";
import {EntryLimits} from "./EntryRules.sol";
import {NyCalendar} from "./NyCalendar.sol";
import {RebalanceLimits} from "./RebalanceRules.sol";
import {SellLimits} from "./SellRules.sol";
import {EntryJob} from "./jobs/EntryJob.sol";
import {JobBase} from "./jobs/JobBase.sol";
import {ProtectJob} from "./jobs/ProtectJob.sol";
import {RebalanceJob} from "./jobs/RebalanceJob.sol";
import {SaveJob} from "./jobs/SaveJob.sol";
import {SellJob} from "./jobs/SellJob.sol";

/// @title GooseExecutor
/// @notice The GreedyGoose agent contract (contracts/docs/GooseExecutor-as-built.md). It is the spender of every agent
///         permission an account grants through JAW's own screen (D14), keeps the on-chain list of which accounts have
///         which agent on, runs each agent's rule, builds every call itself, sends it through JAW's permission
///         manager and checks the result. Its runners call it: a Chainlink CRE workflow through GooseReceiver, and
///         KeeperHub's wallet as backup; there is no server of ours (D12).
///
///         It runs the Cash Agent: Save (wallet USDC above the keep-back goes to Aave V3 savings), Protect from
///         savings (credit that slips below Protect's line, 1.03, is repaid from savings back to the target, 1.12), and
///         Protect · sell (when savings can't get it there, some of the stock that backs it is sold to repay, at once).
///         Once Protect steps in, the rescue goes on until the credit is back at the target (Adrian, 2026-10-19). It
///         also runs the Rebalancer (once a market day, the mix of free stock is brought back when a stock breaks its
///         band, and with top-ups on, what Save counted as a top-up goes into the mix from savings) and the Entry agent
///         (a whitelisted stablecoin in the wallet becomes USDC at 99.5% of face value or better).
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
contract GooseExecutor is AutomationCompatibleInterface {
    /// A job's bit in `Account.jobs` is `1 << uint8(job)`.
    enum Job {
        Save,
        Protect,
        ProtectSell,
        Rebalance,
        Entry
    }

    enum Action {
        None,
        Prune,
        Repay,
        Save,
        Sell,
        EndRescue, // a rescue that reached the target, or nothing owed: no money moves
        Defer, // a batch that doesn't fit in the gas left waits for the next run
        Rebalance,
        Convert,
        RepayThenSell // run only: Protect's repay ended short of the target, or its batch couldn't run; Protect · sell next
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
        SetSellLimits,
        SetRebalanceLimits,
        SetEntryLimits
    }

    /// What the user signed that the template doesn't fix. One slot.
    struct Grant {
        uint48 start;
        uint48 end;
        uint160 cap; // daily limit in USDC units; Protect's is the largest there is (no amount limit)
    }

    /// One slot.
    struct Account {
        uint8 jobs; // bit set of Job
        uint32 index; // 1 + position in `members`; 0 = never registered
        uint8 fails; // failed runs in a row
        uint48 cooldownUntil;
        uint32 savesDay; // New York day of the last Save
        uint8 savesToday;
        uint48 rescueAt; // Protect: when the rescue under way started; 0 = none. While it lasts, Protect acts below
        // the target, not only below its line, until the credit is back at the target
        bool keepMix; // Protect · sell: the same share of each holding, instead of the most safety per dollar first
        uint32 rebalanceDay; // the Rebalancer: the New York day of its last batch, once a market day
        uint32 protectIndex; // 1 + position in `protectMembers`; 0 = never had Protect on
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
        uint256 amount; // USDC units (Repay, Save; Sell: what the sale repays; Rebalance: what the buys spend;
        // Convert: the least USDC the swap brings in)
        uint256 hf; // health factor before the move, WAD, or as the job read it (max: nothing owed)
        uint8 reason; // Repay: a ProtectCase, Act. Convert: the coin's index in EntryJob. Rebalance: 1 puts top-ups in
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
        RebalanceLimits rebalanceLimits;
        EntryLimits entryLimits;
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
        uint256 hf; // Aave's health factor, if a job earlier in the run read it (max: nothing owed); 0 if not
        Thresholds thresholds;
        Amounts amounts;
        SellLimits sellLimits;
        RebalanceLimits rebalanceLimits;
        EntryLimits entryLimits;
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
    /// doesn't find enough left is deferred to the next run. The costliest, seven stocks behind the credit and six
    /// slices, plans in about 1.4M and runs in about 4.0M, so in a 5M perform it must get nearly all the gas.
    uint256 internal constant MAX_RUN_GAS = 4_600_000;
    /// The jobs, in the order a run tries them: Protect from savings, then by selling, the Rebalancer, Entry, Save.
    uint8 internal constant JOBS = 5;
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
    /// Most a daily limit may be: $5 on test deploys (D13), the largest uint160 in production (no amount limit).
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
    /// What else the user signed, packed by the job: Protect · sell's and the Rebalancer's limit per stock (JobBase),
    /// and whether the Rebalancer's grant takes top-ups from savings (RebalanceJob.TOP_UPS).
    mapping(address account => mapping(Job => uint256)) internal terms;
    /// The Rebalancer's target mix, set only by the account: a weight in BPS per stock, 16 bits each by reserve id.
    mapping(address account => uint256) public mixes;
    /// Entry: when each coin that couldn't meet the floor may be tried again, 32 bits each in EntryJob's order.
    mapping(address account => uint256) public entryWaits;
    /// Top-ups go into my mix: the account's own switch and Keep (`setTopUps`), what Save counted and Rebalance hasn't
    /// put in yet, and the agents' own change (CashRules.TopUps).
    mapping(address account => TopUps) public topUps;
    /// Append-only. Page p is members[p * PAGE_SIZE, (p + 1) * PAGE_SIZE).
    address[] public members;
    /// Append-only, paged the same way: the accounts that ever had Protect or Protect · sell on. A price update scans
    /// only these (`checkProtect`), since only they can need a rescue.
    address[] public protectMembers;
    /// Code an account must run to register: JAW's account proxy, or its EIP-7702 delegation.
    mapping(bytes32 codehash => bool) public allowedCodehash;

    Thresholds public thresholds;
    Amounts public amounts;
    SellLimits public sellLimits;
    RebalanceLimits public rebalanceLimits;
    EntryLimits public entryLimits;
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
    /// `shares` by reserve id; `repaid` in USDC units.
    event ProtectSold(address indexed account, uint256[7] shares, uint256 repaid, uint256 hfBefore, uint256 hfAfter);
    /// A sale whose batch couldn't run (a swap under its floor): nothing moved, and the next run tries again.
    /// `reason`: the failed post-check's error, 0 when the batch itself reverted; `retryAt`: when the sale tries again.
    event SaleSkipped(address indexed account, bytes4 reason, uint32 retryAt);
    /// A repay whose batch couldn't run: nothing moved, and Protect · sell gets its turn in the same run.
    event RepaySkipped(address indexed account);
    /// A save Aave refused (its supply cap, a frozen or paused reserve): nothing moved; it counts as one of today's saves.
    event SaveSkipped(address indexed account, uint256 amount);
    event KeepMixSet(address indexed account, bool on);
    event MixSet(address indexed account, uint16[7] weights);
    event TopUpsSet(address indexed account, bool on, uint48 keep);
    /// Save put away `amount` of top-ups; `waiting` is all that waits to go into the mix.
    event TopUpCounted(address indexed account, uint256 amount, uint256 waiting);
    /// Rebalance put `amount` of top-ups from savings into the mix; `bought` in shares by reserve id.
    event TopUpInvested(address indexed account, uint256 amount, uint256[7] bought);
    /// Shares by reserve id: what the sales sold and the buys bought.
    event Rebalanced(address indexed account, uint256[7] sold, uint256[7] bought);
    /// A batch that couldn't meet its floors: nothing moved, and the Rebalancer is done for the day.
    event RebalanceSkipped(address indexed account);
    event EntryConverted(address indexed account, address indexed coin, uint256 amountIn, uint256 usdcOut);
    /// The coin's swap couldn't meet the floor: nothing moved, and it is tried again at `retryAt`.
    event EntryWaiting(address indexed account, address indexed coin, uint256 amountIn, uint32 retryAt);
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
    error NotApproved();
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
    error Overshoot();
    error StockMoved();
    error BackingMoved();
    error SavingsMoved();
    error CashLower();
    error WrongAmount();
    error SavingsNotUp();
    error BelowFloor();
    error BadMix();
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
        RebalanceJob.checkLimits(c.rebalanceLimits);
        EntryJob.checkLimits(c.entryLimits);
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
        rebalanceLimits = c.rebalanceLimits;
        entryLimits = c.entryLimits;
        owner = c.owner;
        thresholds = c.thresholds;
        amounts = c.amounts;
        for (uint256 i; i < c.codehashes.length; ++i) {
            _setCodehash(c.codehashes[i], true);
        }
        emit OwnerSet(c.owner);
    }

    // ================================================================== registry

    /// Switches a job on from the permission exactly as JAW's manager approved it. `approved` is the manager's
    /// PermissionApproved data as logged, abi.encode(permission): one `bytes` argument, so a runner that can't build a
    /// nested struct (KeeperHub) passes it through as is. Anyone may call it: it moves no money, `_match` finds it to be
    /// exactly a job's template, and `_register` checks the account and the manager's approval on-chain. A newer grant for
    /// the same job replaces the stored one; the same grant again changes nothing.
    function registerApproved(bytes calldata approved) external nonReentrant {
        PM.Permission memory p = abi.decode(approved, (PM.Permission));
        (bool ok, Job job, uint160 cap, uint256 t) = _match(p);
        if (!ok) revert NotApproved();
        _register(job, p, cap, t);
    }

    /// "Keep my mix" for Protect · sell: sell the same share of each holding instead of the most safety per dollar
    /// first. Only the account itself sets it, in one Face ID.
    function setKeepMix(bool on) external nonReentrant {
        accounts[msg.sender].keepMix = on;
        emit KeepMixSet(msg.sender, on);
    }

    /// The Rebalancer's target mix: a weight in BPS per stock, by reserve id, adding up to 100% (all 0 clears it). Only
    /// the account itself sets it, in one Face ID.
    function setMix(uint16[7] calldata weights) external nonReentrant {
        mixes[msg.sender] = RebalanceJob.mixOf(weights);
        emit MixSet(msg.sender, weights);
    }

    /// Top-ups go into my mix, and Keep $X as cash (USDC units). Only the account itself sets it. Switching it on or off
    /// starts the counts again from nothing, and the cash already there stays as it is: what the wallet holds past Save's
    /// keep-back when they go on counts as the agents' own, so Save puts it away without counting it.
    function setTopUps(bool on, uint48 keep) external nonReentrant {
        TopUps storage t = topUps[msg.sender];
        if (t.on != on) {
            delete topUps[msg.sender];
            uint256 cash = USDC.balanceOf(msg.sender);
            if (on && cash > amounts.keepBack) t.own = cash - amounts.keepBack;
        }
        (t.on, t.keep) = (on, keep);
        emit TopUpsSet(msg.sender, on, keep);
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

    // ================================================================== running

    /// Finds accounts with work in one page of `members`: the safety-net round over every job. `checkData` =
    /// abi.encode(uint256 shard, uint256 shards): this caller owns the pages p with p % shards == shard and scans one
    /// of them per block, in turn, so one caller serves every page as the list grows. A runner that wants every page
    /// at once passes shards ≥ the page count, one call per page. Each pass over a page starts one account further on,
    /// so a page that runs out of gas or fills MAX_WORK early still gets looked at in full over the next passes. Sales
    /// and repays are listed first, lowest health first, so they have the gas and the pools' room before anything else.
    function checkUpkeep(bytes calldata checkData)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        (uint256 shard, uint256 shards) = abi.decode(checkData, (uint256, uint256));
        return _check(members, shard, shards);
    }

    /// The same as `checkUpkeep`, over `protectMembers` only: what a runner scans on each stock price update.
    function checkProtect(uint256 shard, uint256 shards)
        external
        view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        return _check(protectMembers, shard, shards);
    }

    function _check(address[] storage list, uint256 shard, uint256 shards)
        internal
        view
        returns (bool, bytes memory)
    {
        if (paused) return (false, "");
        uint256 pages = (list.length + PAGE_SIZE - 1) / PAGE_SIZE;
        if (shard >= shards || shard >= pages) return (false, "");
        uint256 owned = (pages - shard - 1) / shards + 1;
        uint256 from = (shard + shards * (block.number % owned)) * PAGE_SIZE;
        uint256 size = list.length - from < PAGE_SIZE ? list.length - from : PAGE_SIZE;
        uint256 first = _scanStart(block.number / owned, size);

        address[] memory work = new address[](MAX_WORK);
        uint256[] memory order = new uint256[](MAX_WORK);
        uint256 n;
        for (uint256 i; i < size && n < MAX_WORK && gasleft() >= CHECK_RESERVE; ++i) {
            address account = list[from + (first + i) % size];
            if (!_due(accounts[account])) continue;
            // Any revert (an Aave or oracle read) skips this account only.
            try this.planOf(account) returns (Plan memory p) {
                if (p.action == Action.None) continue;
                // Protect first, lowest health first; the other jobs after.
                uint256 key = p.action == Action.Sell || p.action == Action.Repay ? p.hf : type(uint256).max;
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
        return (true, abi.encode(work));
    }

    /// Only the runners (`isForwarder`). `performData` is never trusted: only the account addresses are taken from
    /// it, and every amount is re-read and re-planned.
    function performUpkeep(bytes calldata performData) external override nonReentrant {
        if (!isForwarder[msg.sender]) revert NotForwarder();
        if (paused) revert RunsPaused();
        address[] memory list = abi.decode(performData, (address[]));
        if (list.length > MAX_WORK) revert TooMuchWork();
        bool frozen_ = NyCalendar.frozen(holiday, block.timestamp);
        for (uint256 i; i < list.length; ++i) {
            address account = list[i];
            Account memory a = accounts[account];
            if (!_due(a) || _seenBefore(list, i)) continue;
            // A repay that hands over (2) is followed by Protect · sell alone, in a sub-call of its own: the sale gets
            // its own gas, and a sale that reverts can't undo the repay (H1, H3). runAccount(saleOnly) never returns 2.
            bool saleOnly;
            do {
                if (gasleft() < RUN_GAS + RESERVE_GAS) {
                    emit RunDeferred(account); // the next check lists it again
                    return;
                }
                // Each account runs in its own capped sub-call: a revert anywhere in it, the manager's spend
                // bookkeeping included, rolls back that account alone. RESERVE_GAS always stays behind for the catch.
                uint256 gas = gasleft() - RESERVE_GAS;
                uint8 s;
                try this.runAccount{gas: gas < MAX_RUN_GAS ? gas : MAX_RUN_GAS}(account, frozen_, saleOnly) returns (
                    uint8 r
                ) {
                    s = r;
                    // A deferred sale doesn't hold up the accounts after it: the next check lists it again.
                    if (r == 1) emit RunDeferred(account);
                    else if (a.fails != 0) accounts[account].fails = 0;
                } catch (bytes memory reason) {
                    _fail(account, reason);
                }
                saleOnly = s == 2;
            } while (saleOnly);
        }
    }

    /// One account's run: Protect from savings, then by selling, the Rebalancer, Entry, then Save, and at most one move. A dead permission
    /// switches its job off on the way. Returns true when a sale didn't fit in the gas left. Only callable by this
    /// contract, from `performUpkeep`.
    function runAccount(address account, bool frozen_, bool saleOnly) external returns (uint8) {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 hf; // read by the first job that needs it, then passed on
        for (uint8 j = saleOnly ? 1 : 0; j < (saleOnly ? 2 : JOBS); ++j) {
            Job job = _priority(j);
            if (accounts[account].jobs & _bit(job) == 0) continue;
            Grant memory g = grants[account][job];
            if (block.timestamp < g.start) continue; // JAW takes the start from the browser's clock
            if (block.timestamp > g.end) {
                _jobOff(account, job, OffReason.Expired);
                continue;
            }
            Balances memory mine = _ownBalances();
            Plan memory p = _runJob(job, _ctx(account, job, g, frozen_, hf));
            hf = p.hf;
            if (p.action == Action.None) continue;
            if (p.action == Action.Prune) {
                _jobOff(account, job, p.off);
                continue;
            }
            if (p.action == Action.EndRescue) {
                accounts[account].rescueAt = 0; // bookkeeping only: the run goes on to the next job
                continue;
            }
            if (p.action == Action.Defer) return 1;
            _checkOwnBalances(mine);
            return p.action == Action.RepayThenSell ? 2 : 0;
        }
    }

    /// What a run would do for `account` now: the first job, in priority order, with a move or a dead permission.
    function planOf(address account) external view returns (Plan memory p) {
        bool frozen_ = NyCalendar.frozen(holiday, block.timestamp);
        uint8 jobs = accounts[account].jobs;
        uint256 hf; // read by the first job that needs it, then passed on
        for (uint8 j; j < JOBS; ++j) {
            Job job = _priority(j);
            if (jobs & _bit(job) == 0) continue;
            p = _planJob(account, job, frozen_, hf);
            if (p.action != Action.None) return p;
            hf = p.hf;
        }
    }

    // ================================================================== views

    /// The permission the account approved for `job`, rebuilt from the template, its grant, its salt and its terms.
    function permissionOf(address account, Job job) external view returns (PM.Permission memory) {
        return _permission(job, account, grants[account][job], salts[account][job], terms[account][job]);
    }

    /// Which job a permission the manager approved would switch on, with its cap and terms: what `registerApproved`
    /// accepts, from the same PermissionApproved data. A runner reads it first, so another app's grant costs no write.
    function registrationOf(bytes calldata approved)
        external
        view
        returns (bool ok, Job job, uint160 cap, uint256 t)
    {
        return _match(abi.decode(approved, (PM.Permission)));
    }

    /// The seven stocks, by reserve id.
    function stocks() public view returns (address[7] memory) {
        return [STOCK0, STOCK1, STOCK2, STOCK3, STOCK4, STOCK5, STOCK6];
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    function protectMemberCount() external view returns (uint256) {
        return protectMembers.length;
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
    /// Thresholds, an Amounts, (uint32 day, bool on) for SetHoliday, a bytes32 codehash, a SellLimits, a
    /// RebalanceLimits or an EntryLimits.
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
        } else if (kind == Change.SetRebalanceLimits) {
            rebalanceLimits = abi.decode(value, (RebalanceLimits));
        } else if (kind == Change.SetEntryLimits) {
            entryLimits = abi.decode(value, (EntryLimits));
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

    /// `p` is exactly `job`'s template (`_match`): this spender, a cap within CAP_MAX, a window not over, terms within
    /// their bounds.
    function _register(Job job, PM.Permission memory p, uint160 cap, uint256 t) internal {
        address account = p.account;
        uint256 salt = p.salt;
        // A delegated EOA (EIP-7702, 23 bytes of code) can change its code after it registers: never allowed (H4).
        if (account.code.length == 23 || !allowedCodehash[account.codehash]) revert AccountNotAllowed();
        if (!JobBase.managerOwns(MANAGER, account)) revert ManagerNotOwner();
        if (!MANAGER.isApproved(p) || MANAGER.isRevoked(p)) revert NotApproved();
        if (!_isNewer(job, account, p.start, salt)) {
            if (accounts[account].jobs & _bit(job) != 0 && salts[account][job] == salt) return; // already on
            revert StaleGrant();
        }

        Account storage a = accounts[account];
        bool newGrant = salts[account][job] != salt;
        grants[account][job] = Grant(p.start, p.end, cap);
        salts[account][job] = salt;
        terms[account][job] = t;
        a.jobs |= _bit(job);
        // Failures carry over when the same grant comes back (say, after Stuck); a new grant starts clean.
        if (newGrant) {
            a.fails = 0;
            a.cooldownUntil = 0;
            // A new Protect grant starts from Protect's line, never from a rescue an older grant left under way.
            if (job == Job.Protect || job == Job.ProtectSell) a.rescueAt = 0;
            // A new Rebalance grant starts with no top-up waiting: what was counted before it stays cash.
            else if (job == Job.Rebalance) (topUps[account].ready, topUps[account].today) = (0, 0);
        }
        if (a.index == 0) {
            if (members.length % PAGE_SIZE == 0) emit PageOpened(uint32(members.length / PAGE_SIZE));
            members.push(account);
            a.index = uint32(members.length);
        }
        if (a.protectIndex == 0 && (job == Job.Protect || job == Job.ProtectSell)) {
            protectMembers.push(account);
            a.protectIndex = uint32(protectMembers.length);
        }
        emit JobOn(account, job, MANAGER.getHash(p), cap, p.end);
    }

    /// A grant can be registered when the job is off, or when it is a different grant that started no earlier than
    /// the stored one. So an older grant the user never revoked can't replace a newer one.
    function _isNewer(Job job, address account, uint48 start, uint256 salt) internal view returns (bool) {
        uint48 newest = grants[account][job].start; // never cleared by _jobOff: the newest start this job has seen
        if (start != newest) return start > newest;
        return salts[account][job] == salt && accounts[account].jobs & _bit(job) == 0; // the same grant, back on
    }

    /// Which job, cap and terms a permission approved by the manager is a grant of: the template it matches exactly,
    /// with GooseExecutor as spender, a cap within CAP_MAX and a window not yet over. `ok` is false for anything else
    /// (every other app's JAW grants included).
    function _match(PM.Permission memory p) internal view returns (bool ok, Job job, uint160 cap, uint256 t) {
        if (p.spender != address(this) || p.spends.length == 0) return (false, job, 0, 0);
        cap = p.spends[0].allowance;
        if (cap == 0 || cap > CAP_MAX || p.start >= p.end || p.start > block.timestamp || block.timestamp > p.end) {
            return (false, job, 0, 0);
        }
        bytes32 signed = keccak256(abi.encode(p));
        for (uint8 j; j < JOBS; ++j) {
            job = Job(j);
            t = 0;
            if (job == Job.ProtectSell || job == Job.Rebalance) {
                t = job == Job.ProtectSell ? SellJob.termsFrom(_env(), p) : RebalanceJob.termsFrom(_env(), p);
                if (!_termsOk(job, t)) continue;
            }
            if (keccak256(abi.encode(_permission(job, p.account, Grant(p.start, p.end, cap), p.salt, t))) == signed) {
                return (true, job, cap, t);
            }
        }
        return (false, job, 0, 0);
    }

    /// With neither Protect job left on, a rescue under way ends too: switched back on later, Protect starts from its
    /// line again, not from the target.
    function _jobOff(address account, Job job, OffReason reason) internal {
        Account storage a = accounts[account];
        a.jobs &= ~_bit(job);
        if (a.jobs & (_bit(Job.Protect) | _bit(Job.ProtectSell)) == 0) a.rescueAt = 0;
        emit JobOff(account, job, reason);
    }

    /// The template the user approved for `job`, with checker 0 everywhere as JAW's screen grants it (MANAGER-NOTES
    /// §5), in the same order as the app's grant request (lib/agents/permissions.ts).
    function _permission(Job job, address account, Grant memory g, uint256 salt, uint256 t)
        internal
        view
        returns (PM.Permission memory)
    {
        Env memory e = _env();
        if (job == Job.Save) return SaveJob.permission(e, account, g, salt, t);
        if (job == Job.Protect) return ProtectJob.permission(e, account, g, salt, t);
        if (job == Job.ProtectSell) return SellJob.permission(e, account, g, salt, t);
        if (job == Job.Rebalance) return RebalanceJob.permission(e, account, g, salt, t);
        return EntryJob.permission(e, account, g, salt, t);
    }

    /// Protect · sell and the Rebalancer carry a limit per stock, within its bounds, and the Rebalancer whether it takes
    /// top-ups (RebalanceJob.termsOk); the other jobs none.
    function _termsOk(Job job, uint256 t) internal view returns (bool) {
        if (job == Job.ProtectSell) return SellJob.termsOk(_env(), t);
        if (job == Job.Rebalance) return RebalanceJob.termsOk(_env(), t);
        return t == 0;
    }

    // ================================================================== internals: rules

    /// What `job` would do for `account` now. A grant that hasn't started waits; one past its end is pruned.
    function _planJob(address account, Job job, bool frozen_, uint256 hf) internal view returns (Plan memory p) {
        p.job = job;
        Grant memory g = grants[account][job];
        if (block.timestamp < g.start) return p; // JAW takes the start from the browser's clock
        if (block.timestamp > g.end) {
            p.action = Action.Prune;
            p.off = OffReason.Expired;
            return p;
        }
        Ctx memory c = _ctx(account, job, g, frozen_, hf);
        Env memory e = _env();
        Account storage a = accounts[account];
        if (job == Job.Save) return SaveJob.plan(e, c, a, topUps);
        if (job == Job.Protect) return ProtectJob.plan(e, c, a, topUps);
        if (job == Job.ProtectSell) return SellJob.plan(e, c, a, pools, entryWaits);
        if (job == Job.Rebalance) return RebalanceJob.plan(e, c, a, mixes, topUps);
        return EntryJob.plan(e, c, a, entryWaits);
    }

    /// Plans the job again from fresh reads and makes its move, if any, through its library.
    function _runJob(Job job, Ctx memory c) internal returns (Plan memory) {
        Env memory e = _env();
        Account storage a = accounts[c.account];
        if (job == Job.Save) return SaveJob.run(e, c, a, topUps);
        if (job == Job.Protect) return ProtectJob.run(e, c, a, topUps);
        if (job == Job.ProtectSell) return SellJob.run(e, c, a, pools, topUps, entryWaits);
        if (job == Job.Rebalance) return RebalanceJob.run(e, c, a, mixes, topUps);
        return EntryJob.run(e, c, a, entryWaits);
    }

    function _ctx(address account, Job job, Grant memory g, bool frozen_, uint256 hf)
        internal
        view
        returns (Ctx memory)
    {
        return Ctx({
            account: account,
            grant: g,
            salt: salts[account][job],
            terms: job == Job.ProtectSell || job == Job.Rebalance ? terms[account][job] : 0,
            frozen: frozen_,
            hf: hf,
            thresholds: thresholds,
            amounts: amounts,
            sellLimits: sellLimits,
            rebalanceLimits: rebalanceLimits,
            entryLimits: entryLimits
        });
    }

    function _env() internal view returns (Env memory) {
        return Env(MANAGER, AAVE_V3_POOL, SPOKE, USDC, AUSDC, USDC_RESERVE_ID, ORACLE, ROUTER, stocks(), CAP_MAX);
    }

    /// The order a run tries the jobs in: Protect from savings, then by selling, the Rebalancer, Entry, then Save.
    function _priority(uint8 j) internal pure returns (Job) {
        return j == 0 ? Job.Protect : j == 1 ? Job.ProtectSell : j == 2 ? Job.Rebalance : j == 3 ? Job.Entry : Job.Save;
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
        a.cooldownUntil = uint48(block.timestamp) + (BASE_COOLDOWN << (fails < 3 ? fails - 1 : 2));
        emit RunFailed(account, bytes4(reason), fails);
    }

    /// Where pass `pass` over a page of `size` starts: pass × the golden ratio, scaled to the page (a Weyl sequence), so
    /// any run of passes spreads its starts over the page however far each pass gets (M4).
    function _scanStart(uint256 pass, uint256 size) internal pure returns (uint256 first) {
        unchecked {
            first = (pass * 0x9E3779B9 & 0xffffffff) * size >> 32;
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
        if (kind == Change.SetRebalanceLimits) {
            return RebalanceJob.checkChange(abi.decode(value, (RebalanceLimits)), rebalanceLimits);
        }
        if (kind == Change.SetEntryLimits) return EntryJob.checkLimits(abi.decode(value, (EntryLimits)));
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
