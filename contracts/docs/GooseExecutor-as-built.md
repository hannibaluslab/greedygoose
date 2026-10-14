# GooseExecutor as built (M2)

What `src/GooseExecutor.sol` does differently from [GooseExecutor.md](./GooseExecutor.md), and why. The spec is unchanged; read the two together.

| Spec | As built | Why |
| --- | --- | --- |
| `PAGE_SIZE = 48` (§6, an estimate) | 38 | Measured cold on a Base fork (`ExecutorPageForkTest`): an account that owes against all seven stocks, sits in Watch and has too little savings costs about 215k gas to check, so 38 fit under 8.5M (8.17M). One stock costs about 119k. It was 204k (40 a page) before the job libraries: each job's plan is now a library call. |
| A scan starts at the page's first account | It starts one account further on each pass | A page that runs out of gas or fills `MAX_WORK` would otherwise never reach its tail. |
| `checkData = (Lane, stride, offset)` | `(shard, shards)` | One lane in M2, and a new lane means a new contract anyway (§1). Same rotation: the upkeep owns pages with `p % shards == shard`. |
| Protect reads savings, both limits and the status once the trigger fires | Savings first; the limits only with savings | No savings means no repay; saves two reads (about 38k cold). |
| The executor's USDC, aUSDC and ETH are 0 after a move | Not higher than before the move | Anyone can send the executor a token; a 0 check would let one transfer stop every run. |
| Protect's limit left = `min(USDC left, aUSDC left)` | aUSDC left minus 2 units | The manager charges the aUSDC drop, which Aave's rounding can make a unit or two larger than the amount. |
| A newer grant replaces the stored one (§4) | Only one that starts no earlier; the same grant again is a no-op; failures carry over unless the grant is new | So an older grant the user never revoked can't replace a newer one, and re-registering can't reset a failing account's back-off. `checkLog` skips both cases too. |
| `queue` / `apply` / `cancel` (§9) | `queueChange` / `applyChange` / `cancelChange` | `apply` is reserved in Solidity. `ChangeQueued` also carries the nonce `applyChange` needs. |
| Events | Adds `CodehashSet` and `OwnerSet`; a paused run reverts `RunsPaused` | Every admin change is visible on-chain. |
| `runAccount(lane, account) returns (bool)` | `runAccount(account, preFreeze)`, capped at `RUN_GAS` (1.3M) | The window is computed once per run; the cap holds one account's whole sub-call, not just the manager batch. |
| Holidays (§7) | None at deploy; added through `queueChange(SetHoliday)` | They wait for Chainlink's 24/5 schedule to be checked (item 6 step 9). |
| One contract (§1) | The core plus one linked library per job (`src/jobs`) | The contract had reached 22.8 KB of the 24 KB limit with two jobs. See "Job modules" below. |

## Job modules

`GooseExecutor` keeps what every job shares: the registry, who may run, pause and the delayed changes, the paging and shards, the per-account `try/catch`, and the checks every move must pass (the executor holds nothing afterwards). Each job's own rule lives in a library in `src/jobs`: its permission template, when and how much to move, the calls it builds and its own post-checks. `SaveJob` and `ProtectJob` hold the Cash Agent's two jobs; `JobBase` holds what they share (a permission's status, what is left of a limit). The pure rules stay where the differential tests read them (`CashRules`).

Each job library is linked: its functions are `external`, it is deployed once as its own contract, and its address is written into the executor's bytecode when the executor is deployed. Why a linked library and not an external contract called with `STATICCALL`:

- **Nothing can change it.** A library has no storage, no owner and no constructor, and since Cancun `SELFDESTRUCT` can't remove its code. The address in the executor's bytecode can't be changed either. A new rule is still a new executor, so a new spender and a new grant for every user. There is no proxy and no delegatecall to anything that can change.
- **It is the executor, as before.** A library runs in the executor's context: the manager sees the executor as the spender, events come from the executor's address, and the job reads and writes the executor's storage through the pointers the core hands it. The split changes nothing the audit relies on; it only moves code out of the 24 KB limit.
- **An external contract would buy no isolation.** A job module decides the calls the executor sends as the spender, so even a module that can't write the registry is trusted with the money. What protects users is the same either way: the manager's limits and the post-checks.
- **Less to get wrong.** With a library the job reads what it needs where it lives; a separate contract would need every piece of state passed in and every update passed back.
- **A library refuses to run on its own.** Solidity's call guard reverts any direct call to a state-changing library function, and the library holds nothing to take.

The cost is a library call per job per account: about 10k gas more to check a worst-case account, so a page holds 38 accounts instead of 40. `forge script` deploys the libraries and links them before the executor.

Facts found on the way:

- The manager's daily window includes its last second: at exactly `start + 24 h` the old period still counts.
- With the deploy defaults (trigger 1.50, drop 15%, floor 1.10), Weekend Shield never acts before Watch does: 1.10 / 0.85 = 1.29 < 1.50. The fork test runs it with a 30% drop and a 1.40 floor. Calibration is item 6 step 9.
- The contract only fits under 24 KB through the IR pipeline at 200 runs (`foundry.toml` restricts that to this file). Tests that import it compile the same way, and there `block.timestamp` can be reused after a warp, so they read the time with `vm.getBlockTimestamp()`.
- Measured cold: a run of `MAX_WORK` Protect repays uses 3.8M of Base's 5M perform limit.
