# GooseExecutor spec

GooseExecutor is the agent contract. It keeps the on-chain list of which accounts have which agent on, runs each agent's rules, builds the calls, sends them through JAW's permission manager and checks the result. Chainlink Automation calls it. There is no server and no database of ours (D12).

This spec covers what M2 builds: registration, the Cash lane (Save and Protect · savings), the run loop, post-checks, events, admin and the New York calendar. Protect · sell, the Rebalancer and Entry come later and are sketched at the end.

Inputs:

- the final build plan (§3 "GooseExecutor", item 1) and the readiness audit;
- `docs/JUSTALAB-DECISIONS.md`: D12 (no server), D13 (test deploys capped at $5), D14 (JAW's screens), D17 (words), D18 (thresholds on-chain with bounds), and product decision 2 (who triggers);
- [MANAGER-NOTES.md](./MANAGER-NOTES.md): how the manager works, with line refs;
- `test/ExecutorSpike.t.sol`: a contract spender on a Base fork, measured.

## 1. Shape

- One contract per chain. Its logic is immutable: no proxy, no way to change a template, a checker, a limit or a bound. A new rule means a new contract, which is a new spender, so a new permission hash, so every user re-grants (the hash covers the spender, `JustaPermissionManager.sol:868-881`).
- It is the `spender` of every GreedyGoose agent permission and the only caller of `MANAGER.executeBatch` for them.
- It never holds money. It has no `receive`, no payable function, and checks its own balances stay at 0 after every move.
- Two kinds of upkeep call it:
  - **Run upkeeps** (conditional, custom logic): `checkUpkeep` finds work, and `performUpkeep` does it. One per lane, more if one can't keep up (§6).
  - **One registration upkeep** (log trigger) on the manager's `PermissionApproved` log (§4).

### What the manager enforces, and what the executor must

Permissions are granted through JAW's screen (D14), and JAW's grant always sets `checker = 0` (MANAGER-NOTES §5). So:

| Guard | Who enforces it |
| --- | --- |
| Which targets and selectors may be called | the manager, from the permission's `calls` |
| Only the executor may use the permission | the manager (`msg.sender == spender`) |
| Daily amount per token | the manager, from `spends` (charged by calldata amount or balance drop, whichever is larger) |
| Approvals don't outlive the batch | the manager |
| **Every argument** (withdraw *to the account*, approve *only the spoke or the pool*, repay or supply *for the account*) | **the executor only**: it builds every call itself, and its post-checks revert anything else |
| Savings can't leave except into the loan | the executor's post-checks, plus an **aUSDC daily limit** in the permission so the manager also caps it |

The aUSDC limit is new compared with Leo's Guardian permission (`lib/guardian/permission.ts:47`). Without it, a withdrawal of savings to someone else is charged nothing (MANAGER-NOTES §1, `test_only_a_savings_limit_bounds_a_withdrawal_to_someone_else`).

## 2. Constants and immutables

```solidity
IJustaPermissionManager public immutable MANAGER;   // 0xf1b4…01D8 (lib/guardian/config.ts:11)
IAaveV3Pool public immutable AAVE_V3_POOL;          // 0xA238…d1c5
ISpoke public immutable SPOKE;                      // 0x1790…7B8D
IERC20 public immutable USDC;                       // 0x8335…2913
IERC20 public immutable AUSDC;                      // 0x4e65…c0AB
uint256 public immutable USDC_RESERVE_ID;           // 7
uint160 public immutable CAP_MAX;                   // most a daily cap may be: 5e6 on test deploys (D13)
uint32 public immutable PAGE_SIZE;                  // accounts per check page (§6), from the fork measurement

uint256 public constant ACCOUNT_GAS = 1_000_000;    // gas cap on each manager batch
uint256 public constant RESERVE_GAS = 300_000;      // kept per account for reads, post-checks, bookkeeping
uint256 public constant CHECK_RESERVE = 1_500_000;  // checkUpkeep stops scanning below this
uint8 public constant MAX_WORK = 8;                 // accounts per performUpkeep
uint48 public constant DELAY = 7 days;              // product decision 2
uint8 public constant MAX_FAILS = 8;
uint48 public constant BASE_COOLDOWN = 10 minutes;
```

The constructor takes every immutable, plus `owner` and the first allowed codehashes (§4). It sets no forwarder (§9).

## 3. Jobs and permission templates

```solidity
enum Job { Save, Protect }   // bit in Account.jobs = 1 << uint8(job). Later: ProtectSell, Rebalance, Entry
enum Lane { Cash }           // one upkeep runs Save and Protect. Later: Rebalance, Entry
```

Each job has one fixed permission template. The app sends exactly these arrays to `useGrantPermissions`, in this order, with `unit: 'day'` (JAW maps it to `Day`, multiplier 1). The user's grant fixes four more values: `start` and `salt` (chosen by JAW's SDK), `end` (the app's `expiry`) and `cap`.

| Job | `calls` (target, selector, checker) | `spends` (token, allowance, unit, multiplier) |
| --- | --- | --- |
| Save | (USDC, `approve` `0x095ea7b3`, 0) · (AAVE_V3_POOL, `supply` `0x617ba037`, 0) | (USDC, cap, Day, 1) |
| Protect | (AAVE_V3_POOL, `withdraw` `0x69328dec`, 0) · (USDC, `approve` `0x095ea7b3`, 0) · (SPOKE, `repay` `0xb1e8f8ef`, 0) | (USDC, cap, Day, 1) · (AUSDC, cap, Day, 1) |

Both of Protect's limits use the same `cap`, so one number is stored. "Per day" means a rolling 24 hours from `start`, not a calendar day (MANAGER-NOTES §1).

```solidity
/// Rebuilds the permission the account approved: template + stored grant + salt.
function permissionOf(address account, Job job) public view returns (IJustaPermissionManager.Permission memory);
```

A test checks that the app's TypeScript builder and `permissionOf` give the same `MANAGER.getHash` for the same inputs. In M2 step 8, the `PermissionApproved` data from one real grant through JAW's popup is added as a test vector, to confirm the popup keeps the order and sets every checker to 0.

## 4. Registry

### Storage

```solidity
struct Grant {          // 1 slot: what the user signed that the template doesn't fix
    uint48 start;
    uint48 end;
    uint160 cap;        // daily allowance in USDC units (6 decimals)
}

struct Account {        // 1 slot
    uint8 jobs;         // bit set of Job
    uint32 index;       // 1 + position in members; 0 = never registered
    uint8 fails;        // failed runs in a row
    uint48 cooldownUntil;
    uint32 savesDay;    // NY day of the last Save (§5.3 daily Save limit)
    uint8 savesToday;
    // 136 bits left (Protect · sell's pending-sale time goes here later)
}

mapping(address account => Account) public accounts;
mapping(address account => mapping(Job => Grant)) public grants;
mapping(address account => mapping(Job => uint256)) public salts;
address[] public members;                   // append-only; page p = members[p*PAGE_SIZE, (p+1)*PAGE_SIZE)
mapping(bytes32 codehash => bool) public allowedCodehash;
```

### Register

```solidity
function register(Job job, address account, uint48 start, uint48 end, uint256 salt, uint160 cap) public nonReentrant;
```

Anyone may call it. It moves no money, and every field is checked on-chain, in this order, each failing with its own error:

1. `job` is a known job (`UnknownJob`).
2. `allowedCodehash[account.codehash]` (`AccountNotAllowed`). The first two hashes, set in the constructor:
   - `0xc79e2c8f…1848`: the ERC-1167 proxy JAW's factory deploys (`0x363d…5bf3`, pointing at JustanAccount `0xbb4f…cBCd`, the factory's `getImplementation()` today);
   - `0xd9f5ead9…1285`: the EIP-7702 delegation `0xef0100 ‖ 0xbb4f…cBCd`.

   This keeps out contracts that only pretend to be accounts. The spike's `FakeAccount` shows what such a contract can do: answer the manager without running anything, or burn all its gas.
3. `IJustanAccount(account).isOwnerAddress(address(MANAGER))` (`ManagerNotOwner`).
4. `0 < cap <= CAP_MAX` (`CapOutOfBounds`), `start < end` and `block.timestamp <= end` (`BadWindow`). `start` may be in the future, because JAW takes it from the browser's clock. Runs wait until it's reached.
5. `MANAGER.isApproved(p) && !MANAGER.isRevoked(p)` for `p` = the template with these values and `spender = address(this)` (`NotApproved`).

Then it stores `grants`, `salts`, sets the job bit, resets `fails` and `cooldownUntil`, appends the account to `members` if `index == 0` (emitting `PageOpened` when a new page starts), and emits `JobOn`. A newer valid grant for the same job replaces the stored one.

### Registration by log trigger

The grant through JAW's screen is one user operation that ends with `manager.approve`. The app can't add `executor.register` to it (MANAGER-NOTES §5), so a Chainlink log-trigger upkeep does the registration.

- Upkeep filter: emitter `MANAGER`, `topic0` = `PermissionApproved` (`0x84b07255c6c3e177513e059044c77d305a6aecf39fbe512d64dcd3cebb59d5ea`). The spender isn't indexed, so it can't be filtered here. Every JAW grant on Base runs one off-chain `checkLog`, and only ours return true.

```solidity
function checkLog(Log calldata log, bytes calldata checkData)
    external view returns (bool upkeepNeeded, bytes memory performData);
```

`checkLog` decodes `log.data` as a `Permission` and returns true only if `log.source == MANAGER`, `spender == address(this)` and `calls`/`spends` match one template exactly (all checkers 0, both Protect caps equal). It returns `performData = abi.encode(Mode.Register, abi.encode(job, account, start, end, salt, cap))` (288 bytes). `performUpkeep` then calls `register`, which checks everything again on-chain, so a forged `performData` can only register a grant the user really approved.

If the log upkeep is down, the app or anyone can call `register` directly with the values from the grant response.

### Switching off

The user switches an agent off with JAW's revoke screen (`useRevokePermissions`). The registry learns of it lazily:

```solidity
function prune(address account, Job job) public nonReentrant;
```

Anyone may call it. It clears the job bit if the permission is revoked, past `end`, or the manager is no longer an owner, and emits `JobOff`. Runs do the same when they meet a dead permission (§6). A revoked account that never needs work costs about 45k gas per scan until someone prunes it.

## 5. Rules

All maths is integer. Units: Aave "Value" (1e26 = $1, `lib/aave/addresses.ts` `VALUE_PER_USD`), WAD (1e18), RAY (1e27), USDC units (1e6 = $1, so 1 USDC unit = 1e20 Value).

Each run makes **at most one move per account**: Protect first, Save only if Protect has nothing to do. That keeps one account's worst case at one manager batch (`ACCOUNT_GAS`), so the run loop's gas guard holds (§6).

### 5.1 Thresholds (D18)

```solidity
struct Thresholds {        // 1 slot
    uint64 triggerHf;      // WAD
    uint64 targetHf;       // WAD
    uint64 stressDrop;     // WAD fraction
    uint64 stressFloorHf;  // WAD
}
struct Amounts {           // 1 slot
    uint64 minRepay;       // USDC units
    uint64 minSave;        // USDC units
    uint64 keepBack;       // USDC units
    uint32 weekendWindow;  // seconds before a price freeze
    uint8 maxSavesPerDay;
}
Thresholds public thresholds;
Amounts public amounts;
```

| Number | Default | Hard bounds (constants) | Source |
| --- | --- | --- | --- |
| `triggerHf` | 1.50 | 1.20 – 2.00 | `plan.ts:33` (`RISK.safeMin`) |
| `targetHf` | 1.65 | `triggerHf + 0.05` – 2.50 | `plan.ts:34` |
| `stressDrop` | 0.15 | 0.05 – 0.30 | `plan.ts:35` |
| `stressFloorHf` | 1.10 | 1.02 – `triggerHf` | `plan.ts:36` (`RISK.watchMin`) |
| `minRepay` | $0.05 | $0.05 – $50 | `plan.ts:37` |
| `minSave` | $1.00 | $0.10 – $100 | new, calibrated in item 6 step 9 |
| `keepBack` | $1.00 | $0 – $5 | plan decision 3 (keep-back $1–2, then $0) |
| `weekendWindow` | 6 h | 1 h – 12 h | `plan.ts:84-89` (Fri 14:00–20:00 ET) |
| `maxSavesPerDay` | 6 | 1 – 24 | item 6 step 7 (griefing) |

The bounds are checked when a change is queued and again when it's applied (§9). `config/risk.ts` mirrors the values; the app reads the live ones with the `thresholds()` and `amounts()` views, and shows queued changes from `ChangeQueued`.

### 5.2 Protect · savings

A port of `planGuardian` (`lib/guardian/plan.ts:40-78`). The TypeScript version stays as the reference.

Reads:

- `d = SPOKE.getUserAccountData(account)`: `C = d.totalCollateralValue` (Value), `cf = d.avgCollateralFactor` (WAD), `Dray = d.totalDebtValueRay` (Value × RAY), `d.healthFactor` (WAD, for the post-check);
- `savings = AUSDC.balanceOf(account)`;
- `capLeft = min(cap − spentUSDC, cap − spentAUSDC)`, each from `MANAGER.getCurrentPeriod(p, p.spends[i]).spend`;
- `weekend = _inPreFreezeWindow(block.timestamp)` (§7).

Decision, line for line with `plan.ts`:

```text
if Dray == 0                                   → none (no-debt)            plan.ts:42
power = C * cf / 1e18                                                      plan.ts:43
debt  = ceilDiv(Dray, 1e27)            // rounds up, like summarize()       lib/aave/math.ts:22
hf    = power * 1e18 / debt                                                plan.ts:44
if hf < triggerHf:
    need = debt − power * 1e18 / targetHf;             reason = Watch      plan.ts:49-51
else if weekend and power * (1e18 − stressDrop) / debt < stressFloorHf:
    need = debt − power * (1e18 − stressDrop) / (stressFloorHf + targetHf − triggerHf)
                                                       reason = WeekendShield   plan.ts:52-55
if no reason or need <= 0                      → none (healthy)            plan.ts:57
if savings == 0                                → none (no-savings)         plan.ts:58
if capLeft == 0                                → none (no-cap)             plan.ts:59
amount = ceilDiv(min(need, debt), 1e20)        // Value → USDC units       plan.ts:61
amount = min(amount, savings, capLeft)                                     plan.ts:63-70
if amount < minRepay                           → none (too-small)          plan.ts:71
→ repay(amount, reason)
```

Calls, built by the executor and pinned to `account`:

```text
AAVE_V3_POOL.withdraw(USDC, amount, account)
USDC.approve(SPOKE, amount)
SPOKE.repay(USDC_RESERVE_ID, amount, account)
```

Post-checks. Any failure reverts this account's run (§6):

- `SPOKE.getUserTotalDebt(USDC_RESERVE_ID, account)` is lower than before;
- `SPOKE.getUserAccountData(account).healthFactor` is not lower;
- the account's aUSDC fell by at most `amount + 2` (aToken rounding);
- the account's USDC is not lower (if the debt was smaller than `amount`, the spoke takes less, and Save sweeps the rest on a later run);
- the executor's own USDC, aUSDC and ETH balances are 0.

Event: `ProtectRepaid(account, amount, hfBefore, hfAfter, reason)`.

Differential test: 1,000 input vectors are run through `planGuardian` by `tsx`, exported to JSON, and read in Forge with `vm.parseJson` (no ffi). The decision kind must match, and the amount must be within 1 cent (10,000 units). The TypeScript side works in float dollars (`summarize`, `lib/aave/math.ts:19-35`), so vectors within 0.0001 of a health-factor threshold are left out of the kind check.

### 5.3 Save

New, so it gets a TypeScript reference first: `planSave` next to `planGuardian` in `lib/guardian/plan.ts`, with unit tests. Solidity must agree with it the same way.

Reads: `cash = USDC.balanceOf(account)`, `capLeft = cap − spentUSDC`, the account's Save count today.

```text
idle = cash > keepBack ? cash − keepBack : 0
if idle < minSave                       → none (too-small)
if capLeft == 0                         → none (no-cap)
if savesToday >= maxSavesPerDay         → none (rate)
amount = min(idle, capLeft)
if amount < minSave                     → none (too-small)
→ save(amount)
```

Calls: `USDC.approve(AAVE_V3_POOL, amount)`, then `AAVE_V3_POOL.supply(USDC, amount, account, 0)`.

Post-checks: the account's USDC fell by exactly `amount`; its aUSDC rose by at least `amount − 2`; the executor's balances are 0. Save never leaves the wallet below `keepBack`, by construction.

Event: `Saved(account, amount)`. The daily Save limit applies to Save only. Nothing ever delays Protect.

*(Extended 2026-10-20, GooseExecutor-as-built.md "Rebalance's top-ups": with top-ups on and Rebalance on, what Save puts away, less the agents' own change, is counted as a top-up waiting to go into the mix, after Keep. Save's grant moves to the executor's CAP_MAX, with no daily limit to slow top-ups (P2); the daily number of saves stays.)*

## 6. Running

### checkUpkeep

```solidity
function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData);
// checkData = abi.encode(Lane lane, uint32 stride, uint32 offset); one upkeep per lane uses (Cash, 1, 0)
```

1. Return false while `paused`.
2. Pages: `pageCount = ceilDiv(members.length, PAGE_SIZE)`. This upkeep owns the pages `p` with `p % stride == offset`. It scans one of them per block: the `(block.number % owned)`-th. One upkeep with one forwarder serves every page as the list grows. At 2-second blocks, 20 pages (about 1,000 accounts) are swept every 40 s. If that gets too slow, add upkeeps with `stride > 1`. Each new upkeep's forwarder waits the 7-day delay (§9).
3. For each account in the page, skipping accounts with no jobs or still in cooldown, triage from cheap reads to expensive ones (cold gas from the readiness audit):
   - Protect: `getUserTotalDebt` (28k). Only if there's debt, `getUserAccountData` (113k). Only if the trigger or the pre-freeze stress test fires, `aUSDC.balanceOf` (24k), `getCurrentPeriod` ×2 (19k each) and the permission status (`isApproved`/`isRevoked`, 15k).
   - Save: `USDC.balanceOf` (10.5k). Only if `cash − keepBack >= minSave`, the cap left and the permission status.
   - Every read sits in `try/catch`. An Aave or oracle revert skips that account and doesn't stop the check.
   - An account whose permission turns out revoked or expired is listed too, so the run prunes it.
4. Stop at `MAX_WORK` accounts, or when `gasleft() < CHECK_RESERVE`. `PAGE_SIZE` is sized so the gas stop never fires (below).
5. `performData = abi.encode(Mode.Run, abi.encode(lane, accounts))`, at most `32 × (6 + MAX_WORK)` = 448 bytes, well under Base's 2,000-byte limit.

**Page size.** The worst case is a page where every account has credit open: about 45k (cash, debt, loop, storage) plus 113k (account data), so about 160k per account, plus up to `MAX_WORK` candidates at about 100k. Base's check limit is 10M. With `CHECK_RESERVE` kept back, that gives **`PAGE_SIZE = 48`**. If few accounts have credit, a page costs about 45k per account. The deploy sets `PAGE_SIZE` from a fork measurement. The done-when test: a worst-case page checks in under 8.5M gas.

### performUpkeep

```solidity
enum Mode { Run, Register }
function performUpkeep(bytes calldata performData) external nonReentrant;
```

- `isForwarder[msg.sender]`, or revert `NotForwarder`. This applies to both modes.
- `Mode.Register` → `register(...)` (§4). It works while paused, since it moves no money.
- `Mode.Run` → revert `Paused` if paused. Then for each listed account, skipping duplicates and non-members:
  - if `gasleft() < ACCOUNT_GAS + RESERVE_GAS`, emit `RunDeferred(account)` and stop (the next check lists it again);
  - `try this.runAccount(lane, account) returns (bool moved)`: on success, reset `fails`;
  - `catch (bytes memory reason)`: `fails += 1`, then `cooldownUntil = now + BASE_COOLDOWN << (fails − 1)` (10 min, 20 min, … about 21 h), then emit `RunFailed(account, bytes4(reason), fails)`. At `MAX_FAILS`, clear the account's jobs and emit `JobOff(account, job, Stuck)`. A new grant registers it again.

`performData` is never trusted. Only the account addresses are taken from it. Every amount is re-read and re-planned, so a stale check finds nothing to do and moves nothing.

```solidity
function runAccount(Lane lane, address account) external returns (bool moved);  // reverts OnlySelf unless msg.sender == this
```

For each job in priority order (Protect, then Save):

1. `p = permissionOf(account, job)`. If `block.timestamp < p.start`, skip. If revoked, expired, or the manager isn't an owner, clear the job, emit `JobOff` and continue (not a failure).
2. Read, plan (§5). If there's nothing to do, continue.
3. Snapshot what the post-checks need, build the calls, and call `MANAGER.executeBatch{gas: ACCOUNT_GAS}(p, calls)`.
4. Run the post-checks, update counters, emit the move event, and return true (one move per run).

Because `runAccount` is an external self-call inside `try`, a revert anywhere in it (manager error, out of gas under the cap, failed post-check) rolls back that account alone, including the manager's spend bookkeeping. The other accounts in the run still land. All proved on a fork by the spike (`test_one_failure_rolls_back_only_that_account`, `test_post_check_failure_rolls_back_the_managers_batch`, `test_gas_cap_contains_an_account_that_burns_gas`).

**Gas.** Measured in the spike (cold): the Protect · savings manager batch is about 404k, the per-account sub-call about 473k, and a one-account run about 510k. With Base's 5M perform limit, about 8 typical accounts fit per run (`MAX_WORK`). The gas guard always leaves room for at least 3 accounts even in the worst case.

## 7. New York calendar

The stock prices come from Chainlink 24/5 feeds that update from Sunday 20:00 to Friday 20:00 New York time (`lib/market-hours/index.ts:1-5`). The feeds have no paused flag (readiness audit: no `paused()`, `isPaused()` or `marketStatus()` in either bytecode), so the executor keeps its own calendar.

- Time zone: US rule since 2007. DST runs from the 2nd Sunday of March at 07:00 UTC to the 1st Sunday of November at 06:00 UTC. New York is UTC−4 in DST and UTC−5 otherwise. Computed with Solady's `DateTimeLib` (`nthWeekdayInMonthOfYearTimestamp`, `weekday`, `timestampToDate`), the library the manager itself uses. Vendor it under `contracts/lib/solady` (MIT).
- Holidays: `mapping(uint32 nyDay => bool) public holiday` (days since 1970-01-01, New York date). Changed only through the 7-day queue (§9). Event `HolidaySet(day, on)`.
- Freeze model: prices are held from Friday 20:00 to Sunday 20:00, and from 20:00 the evening before a holiday to 20:00 on the holiday. Check this model against Chainlink's published 24/5 holiday schedule before calibration (item 6 step 9).

```solidity
function frozen(uint256 ts) public view returns (bool);                // prices are being held
function nextFreeze(uint256 ts) public view returns (uint256 start);  // start of the next freeze after ts
function _inPreFreezeWindow(uint256 ts) internal view returns (bool); // !frozen(ts) && nextFreeze(ts) − ts <= weekendWindow
```

With no holidays and a 6 h window, `_inPreFreezeWindow` equals Leo's `inWeekendWindow` (`plan.ts:84-89`, Friday 14:00 to 20:00 ET). Tests: the DST switches on 2026-03-08, 2026-11-01 and 2027-03-14 (one second either side); Friday 13:59, 14:00, 19:59 and 20:00 ET in both summer and winter; agreement with `inWeekendWindow` on 10,000 random timestamps from 2026 to 2030. `lib/market-hours` mirrors the holiday list for the app's "Markets closed" banner.

## 8. Events

Every move is indexed by account, so the app reads one account's history from the chain with no indexer (plan item 1, step 9).

```solidity
event JobOn(address indexed account, Job indexed job, bytes32 permissionHash, uint160 cap, uint48 end);
event JobOff(address indexed account, Job indexed job, OffReason reason); // Revoked, Expired, NotOwner, Stuck
event Saved(address indexed account, uint256 amount);
event ProtectRepaid(address indexed account, uint256 amount, uint256 hfBefore, uint256 hfAfter, RepayReason reason);
                                                                            // RepayReason: Watch, WeekendShield
event RunFailed(address indexed account, bytes4 reason, uint8 fails);
event RunDeferred(address indexed account);
event PageOpened(uint32 indexed page);

event Paused(bool paused);
event ForwarderSet(address indexed forwarder, bool allowed);
event ChangeQueued(bytes32 indexed id, Change kind, bytes value, uint48 eta);
event ChangeApplied(bytes32 indexed id);
event ChangeCancelled(bytes32 indexed id);
event HolidaySet(uint32 indexed day, bool on);
```

App wording (plan item 1; D17, so no "borrow" or "lock"): `Saved` folds into the arrival, "$40 added to your cash"; `ProtectRepaid` reads "Repaid $X from your cash"; the raw move sits under Details.

Views for the app:

```solidity
function jobsOf(address account) external view
    returns (uint8 jobs, Grant memory save, Grant memory protect, uint8 fails, uint48 cooldownUntil);
function permissionOf(address account, Job job) public view returns (IJustaPermissionManager.Permission memory);
function memberCount() external view returns (uint256);
```

`jobsOf` replaces the localStorage record (`lib/guardian/store.ts`), so switches survive a cleared browser. `permissionOf` gives the struct for `isApproved`/`isRevoked`, and for a direct `manager.revoke` if JAW's relay has no record.

## 9. Admin

Product decision 2: only the executor's Chainlink forwarders trigger agents; the owner can pause at once; a new forwarder, backup caller or threshold change waits a public 7-day delay; the first forwarder is set once at deploy.

```solidity
address public owner;                          // GreedyGoose multisig
bool public paused;
mapping(address => bool) public isForwarder;
bool public bootstrapped;

function pause() external onlyOwner;           // at once
function unpause() external onlyOwner;         // at once: it only restores the same audited rules
function bootstrap(address[] calldata forwarders) external onlyOwner;  // once, no delay
function removeForwarder(address forwarder) external onlyOwner;        // at once: it only takes power away
function disallowCodehash(bytes32 codehash) external onlyOwner;        // at once: stops new registrations only

enum Change { AddForwarder, SetThresholds, SetAmounts, SetHoliday, AllowCodehash, SetOwner }
function queue(Change kind, bytes calldata value) external onlyOwner returns (bytes32 id, uint48 eta);
function apply(Change kind, bytes calldata value, uint256 nonce) external onlyOwner;   // only after eta
function cancel(bytes32 id) external onlyOwner;
mapping(bytes32 id => uint48 eta) public queued;   // id = keccak256(abi.encode(kind, value, nonce))
uint256 public changeNonce;
```

**Why `bootstrap`.** A Chainlink forwarder only exists once its upkeep is registered, and registering needs the executor's address. So no forwarder can be passed to the constructor. The deploy script runs deploy, then registers the Cash run upkeep and the registration log upkeep, then calls `bootstrap([runForwarder, logForwarder])` in one session. After that, `bootstrap` is closed for good, and any new forwarder (a second run upkeep, a backup caller) goes through `queue` and waits 7 days.

| `Change` | `value` | Checked at `queue` and at `apply` |
| --- | --- | --- |
| `AddForwarder` | `abi.encode(address)` | non-zero |
| `SetThresholds` | `abi.encode(Thresholds)` | every field within its bounds; `targetHf >= triggerHf + 0.05e18`; `stressFloorHf <= triggerHf` |
| `SetAmounts` | `abi.encode(Amounts)` | every field within its bounds |
| `SetHoliday` | `abi.encode(uint32 day, bool on)` | `day` between today and today + 800 |
| `AllowCodehash` | `abi.encode(bytes32)` | non-zero (needed if JAW ships a new account implementation) |
| `SetOwner` | `abi.encode(address)` | non-zero |

Nothing can change `MANAGER`, the Aave and token addresses, the templates, `CAP_MAX`, the bounds, `ACCOUNT_GAS`, `PAGE_SIZE` or `DELAY`.

## 10. Griefing and safety summary

- **Fake accounts:** codehash allowlist, manager-owner check, and an approved permission with this spender are all needed before an account is scanned.
- **One bad account:** per-account `try/catch`, a gas cap on every manager batch, the gas guard before each account, then cooldown with exponential back-off, then drop after `MAX_FAILS`.
- **Dust and churn:** `minRepay`, `minSave` and `maxSavesPerDay` within bounds, and one move per account per run.
- **Reentrancy:** `nonReentrant` on `performUpkeep`, `register`, `prune` and every admin function. The manager is `nonReentrant` too.
- **Funds never mix:** each move uses one account's own permission on that account's own wallet, every call is pinned to that account, and the post-check keeps the executor's own balances at 0.
- **Forwarder trust:** a forwarder can only ask for a run, and the run re-checks everything. A rogue forwarder can at most trigger a move the rules already allow at that moment.

## 11. Tests (done when)

| Area | Test |
| --- | --- |
| Templates | `permissionOf` hash equals the TypeScript builder's for 50 random (account, start, end, salt, cap); one real JAW grant's log data matches the template (M2 step 8) |
| Registration | succeeds only when every check in §4 passes, and each failure has its own error; after a revoke, a new grant registers; `checkLog` returns true only for our spender and an exact template; a forged `performData` for an unapproved grant reverts `NotApproved` |
| Rules | differential vs `planGuardian` and `planSave` (1,000 vectors each, §5.2); bounds rejected at queue and at apply |
| Calendar | §7 vectors |
| Run (Base fork) | 3 accounts (Save only, Protect only, both) in one run; a revoked and an expired one are pruned; a non-forwarder is rejected; a Protect batch that doesn't lower debt reverts that account only; a gas burner is contained (allowed by a test-only codehash); the worst-case page check uses < 8.5M gas; a run of `MAX_WORK` accounts uses < 5M |
| Admin | `bootstrap` works once; a forwarder added before 7 days reverts; pause stops runs at once and registration keeps working |

Fork tests use `ForkBase.sol`: fresh JAW accounts from JAW's factory, and the stock double for NVDAc (MANAGER-NOTES §8).

## 12. Later jobs (not in M2)

Each adds a `Job`, a template, its rule and its post-checks from plan §3. Two things change compared with the plan, because of D14:

- There are no checkers, so every pin the plan gives ProtectSellChecker, RebalanceChecker and EntryChecker (recipient == account, tokenOut == USDC, router allowlist, oracle price floor) moves into the executor's call builder and post-checks.
- Every token those calls can move needs its own spend limit, or the manager charges nothing for it: each sellable stock for Protect · sell, each mix stock for the Rebalancer.

Protect · sell also uses the spare bits in `Account` for its pending-sale time (heads-up, then sell 30 minutes later, plan item 1).

## 13. If D14 changes

If we go back to Leo's direct `manager.approve` through `wallet_sendCalls` (`hooks/useGuardian.ts:66-80`), these change:

- The permission carries checkers again (GuardianChecker unchanged for Protect · savings), so arguments are pinned twice: by the manager and by the executor.
- The app picks the salt and `start = now − 300`, and can put `executor.register` in the same Face ID. The log-trigger upkeep and `checkLog` go away.
- The grant doesn't show in JAW's permission list and can't be revoked from JAW's screens. The app revokes with a direct `manager.revoke`.
- Whether JAW's signing screen accepts a direct `manager.approve` is still unverified (`docs/guardian.md:44`).

A third option: JAW's relay already stores a checker per call, and only the grant request type drops it (MANAGER-NOTES §7). If JAW's SDK and popup accepted an optional `checker`, we would keep JAW's screens and get the checkers back.

---

**Superseded in part (2026-10-15): Act is the line.** Protect steps in only below 1.10 and brings the credit back to 1.20; Weekend Shield no longer repays (§5.2's `WeekendShield` branch and `_inPreFreezeWindow` in the runs are gone), and the threshold table's defaults and bounds for `triggerHf` and `targetHf` are replaced. See [GooseExecutor-as-built.md](./GooseExecutor-as-built.md), "Act is the line", and JUSTALAB-DECISIONS.md.
