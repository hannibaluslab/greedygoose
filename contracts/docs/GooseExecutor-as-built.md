# GooseExecutor as built (M2, then Protect · sell)

What `src/GooseExecutor.sol` does differently from [GooseExecutor.md](./GooseExecutor.md), and why. The spec is unchanged; read the two together.

| Spec | As built | Why |
| --- | --- | --- |
| `PAGE_SIZE = 48` (§6, an estimate) | 32 | Measured cold on a Base fork (`ExecutorPageForkTest`): an account that owes against all seven stocks, sits in Watch with too little savings, and has Protect · sell and Save on too costs about 251k gas to check, so 32 fit under 8.5M. It was 204k (40 a page) with the two Cash jobs in one contract, and 215k (38) once each job's plan became a library call. One stock costs about 119k. |
| A scan starts at the page's first account | It starts one account further on each pass | A page that runs out of gas or fills `MAX_WORK` would otherwise never reach its tail. |
| `checkData = (Lane, stride, offset)` | `(shard, shards)` | One lane in M2, and a new lane means a new contract anyway (§1). Same rotation: the upkeep owns pages with `p % shards == shard`. |
| Protect reads savings, both limits and the status once the trigger fires | Savings first; the limits only with savings | No savings means no repay; saves two reads (about 38k cold). |
| The executor's USDC, aUSDC and ETH are 0 after a move | Not higher than before the move | Anyone can send the executor a token; a 0 check would let one transfer stop every run. |
| Protect's limit left = `min(USDC left, aUSDC left)` | aUSDC left minus 2 units | The manager charges the aUSDC drop, which Aave's rounding can make a unit or two larger than the amount. |
| A newer grant replaces the stored one (§4) | Only one that starts no earlier; the same grant again is a no-op; failures carry over unless the grant is new | So an older grant the user never revoked can't replace a newer one, and re-registering can't reset a failing account's back-off. `checkLog` skips both cases too. |
| `queue` / `apply` / `cancel` (§9) | `queueChange` / `applyChange` / `cancelChange` | `apply` is reserved in Solidity. `ChangeQueued` also carries the nonce `applyChange` needs. |
| Events | Adds `CodehashSet` and `OwnerSet`; a paused run reverts `RunsPaused` | Every admin change is visible on-chain. |
| `runAccount(lane, account) returns (bool)` | `runAccount(account, frozen, preFreeze) returns (bool deferred)`, with all the gas left but `RESERVE_GAS`, up to `MAX_RUN_GAS` (4.2M); an account starts only with `RUN_GAS` (1.3M) left | The calendar is read once per run. A sale needs more than a Cash move; when it doesn't find enough gas left after planning, it is deferred (`RunDeferred`), not failed. The manager batch keeps its own cap (`ACCOUNT_GAS`, `SellJob.SELL_GAS`). |
| Holidays (§7) | None at deploy; added through `queueChange(SetHoliday)` | They wait for Chainlink's 24/5 schedule to be checked (item 6 step 9). |
| One contract (§1) | The core plus one linked library per job (`src/jobs`) | The contract had reached 22.8 KB of the 24 KB limit with two jobs. See "Job modules" below. |

## Job modules

`GooseExecutor` keeps what every job shares: the registry, who may run, pause and the delayed changes, the paging and shards, the per-account `try/catch`, and the checks every move must pass (the executor holds nothing afterwards). Each job's own rule lives in a library in `src/jobs`: its permission template, when and how much to move, the calls it builds and its own post-checks. `SaveJob` and `ProtectJob` hold the Cash Agent's two jobs and `SellJob` holds Protect · sell; `JobBase` holds what they share (a permission's status, what is left of a limit, the health factor). The pure rules stay where the differential tests read them (`CashRules`, `SellRules`).

Every job library has the same three functions: `permission(env, account, grant, salt, terms)`, `plan(env, ctx, account, pools)` and `run(env, ctx, account, pools)`. `Env` carries the addresses fixed at deploy (a library can't read the executor's immutables) and `Ctx` the grant, the terms and every number the jobs read. A new job adds a library, a `Job` value and three lines of dispatch. Sizes: core 21.7 KB, `SellJob` 18.3 KB, `ProtectJob` 7.7 KB, `SaveJob` 6.1 KB.

A run plans the jobs in order (Protect from savings, Protect · sell, Save) and the first one to read Aave's health factor passes it on in `Ctx.hf`, so the next doesn't pay for the account data again: about 120k gas an account with seven stocks.

Each job library is linked: its functions are `external`, it is deployed once as its own contract, and its address is written into the executor's bytecode when the executor is deployed. Why a linked library and not an external contract called with `STATICCALL`:

- **Nothing can change it.** A library has no storage, no owner and no constructor, and since Cancun `SELFDESTRUCT` can't remove its code. The address in the executor's bytecode can't be changed either. A new rule is still a new executor, so a new spender and a new grant for every user. There is no proxy and no delegatecall to anything that can change.
- **It is the executor, as before.** A library runs in the executor's context: the manager sees the executor as the spender, events come from the executor's address, and the job reads and writes the executor's storage through the pointers the core hands it. The split changes nothing the audit relies on; it only moves code out of the 24 KB limit.
- **An external contract would buy no isolation.** A job module decides the calls the executor sends as the spender, so even a module that can't write the registry is trusted with the money. What protects users is the same either way: the manager's limits and the post-checks.
- **Less to get wrong.** With a library the job reads what it needs where it lives; a separate contract would need every piece of state passed in and every update passed back.
- **A library refuses to run on its own.** Solidity's call guard reverts any direct call to a state-changing library function, and the library holds nothing to take.

The cost is a library call per job per account. `forge script` deploys the libraries and links them before the executor.

## Protect · sell

Plan item 1, steps 10–12: when savings can't keep the credit Safe, Protect sells some of the stock that backs it and repays. It is its own job (`Job.ProtectSell`) and its own JAW grant, so selling can be switched off alone (decision 5). The rule is `SellRules` (Solidity) and `lib/guardian/sell.ts` (TypeScript): `test/SellRules.t.sol` runs both on 600 sale vectors and 1,000 timing vectors and they agree to the unit.

**What it does.**

- **When** (decision 3): below 1.25 on a weekday, a heads-up (`SellHeadsUp`, with the stock it would sell at Aave's price and when), and the sale 30 minutes later if the health is still below; below 1.10 (Act), at once. Never while prices are held (weekends and holidays, the executor's New York calendar). Back above 1.25, a pending heads-up is cleared (`SellHeadsUpCleared`), so a later fall gets a new one; a sale that gets there clears it too. A sale cut short (a run makes six slices; a limit or the pool cap can stop it) goes on in the next runs without a new wait: `headsUpAt` is set a full delay back. A heads-up is only sent when there is something Protect may sell now.
- **Which stock:** the lowest collateral factor first, the most safety per dollar sold. Factors within one point are a near-tie, and the larger holding goes first. "Keep my mix" (`setKeepMix`, only the account itself) sells the same share of each holding instead. Factors are read from each reserve's current config, the one Aave applies to the whole position on a withdrawal.
- **How much:** the least that brings the health back to 1.4 once the proceeds repay at the floor. Each stock is held to its backing, its daily limit, its pool's window and the USDC limit; what one can't cover spills over to the next.
- **Slices:** each slice is withdraw, swap, repay. Aave's spoke checks health ≥ 1.0 right after every withdrawal, so a slice takes out no more than leaves it at 1.001, and no more than $5,000 at Aave's price (about 1% of a pool's USDC). A run makes at most six slices; the rest waits for the next run.
- **Price floor:** every swap's minimum output is Aave's price less 1% (3% in Act, still under Aave's 5.5% liquidation bonus), and each slice repays exactly that minimum. What the swap pays above it stays in the wallet as cash, which Save puts back in savings.
- **Pool cap:** all accounts together sell at most $10,000 at Aave's price into one stock's pool per 10 minutes (about 2% of the pools' USDC). The check lists sales first, lowest health first, so they get the gas and the pools' room before anything else.
- **Never-sell:** a stock left out of the grant has no `approve` and no limit, so JAW's manager refuses any batch that would sell it.

**The permission** (`SellJob.permission`, `lib/agents/permissions.ts` `sellGrant`): `Spoke.withdraw`, `approve` on each stock for sale, Aerodrome's `exactInputSingle`, `USDC.approve`, `Spoke.repay`, all with checker 0; daily limits on USDC (the repay leg) and aUSDC at the one cap, then each stock's own limit in shares. The grant's `terms` pack each stock's limit in units of 1e-4 share, 32 bits a stock, so they fit one word in the registry, and `register` takes them as its last argument (0 for the Cash jobs). At registration each stock's limit may be worth at most twice `CAP_MAX` at Aave's price, so a $5 test deploy (D13) can't be granted a large stock limit.

**Post-checks** (`SellJob.check`): the debt is lower and the health higher; no stock balance in the wallet moved (exactly what came out of Aave was sold); nothing else that backs the credit moved, so a never-sell stock is untouched; savings didn't move, cash isn't lower, and the executor holds none of the stock. `ExecutorHarness.sellWith` runs any batch under these checks: the fork tests show a sale of free stock (`StockMoved`), a sale to someone else (`CashLower`) and stock taken out and left unsold (`DebtNotLower`) all revert, and the manager itself refuses a never-sell stock and a stock past its limit.

| Plan | As built | Why |
| --- | --- | --- |
| ProtectSellChecker pins every argument | No checker; the executor builds every call and its post-checks revert anything else | D14: JAW's screen grants with checker 0 (GooseExecutor.md §12). |
| Sell on Aerodrome or Uniswap | Aerodrome Slipstream only, tick spacing 10 | Its stock pools hold $0.44M–1.57M of USDC; Uniswap's hold $0–53k (read 2026-10-14). A second router in the grant would be reach that is never used. |
| USDC limit on the repay leg | USDC and aUSDC, at the same cap | The manager meters only the tokens a permission lists. Nothing in a sale touches savings; the aUSDC limit bounds what a batch could move through an allowance the account gave elsewhere. |
| "Keep my mix" from the registry | The same share of each holding for sale, then the usual order for what limits leave | The Rebalancer's target mix doesn't exist yet (item 9). |
| A sale repays what it sold for | It repays the minimum output | The calls are fixed before the swap runs; repaying more would take the user's own cash. |

**Checking cost.** An account with Protect · sell on costs about 36k more to check while it waits above the heads-up line, using the health Protect already read. One below the line whose sale a stock limit or the pool cap blocks pays for the full plan on every check until the limit resets or the window rolls; the scan's gas stop and its rotating start absorb that.

**Fork tests** (`test/ProtectSellFork.t.sol`), against the real manager, the Equities Hub and Aerodrome's pools with their real balances, from fresh JAW accounts backed by NVIDIA:

| Starting health | What happens | Slices | Run gas |
| --- | --- | --- | --- |
| 1.249 | heads-up; sale 30 min later; 1.40 | 1 | 1.37M |
| 1.099 | sale at once at the Act floor; 1.40 | 3 | 1.79M |
| 1.05 | sale at once; 1.40 | 5 | 2.23M |
| 1.01 | six slices, then the next block's run finishes; 1.40 | 6 + 3 | 2.45M + 1.73M |
| any, weekend | nothing | | |
| 1.05, pool 4% under Aave's price | the swap can't meet the Act floor; the run fails, nothing moves | | |
| 1.05 and 1.08 sharing NVIDIA's pool, $1,000 cap | 1.05 first; 1.08 sells what the window leaves, then the rest in the next window | | |

The costliest run, six slices over three stocks, used 2.89M gas, inside `MAX_RUN_GAS` (4.2M) and Base's 5M perform limit. Measured: the manager's batch costs about 660k plus 234k a slice.

## Flash-loan helper: not needed

The panel's open question (eval/protect-panel.json): near 1.0, would the emergency sale need a flash-loan helper, because Aave checks the health right after each withdrawal? Decision: **no helper; slices.**

- **It couldn't work without Aave governance.** The spoke's `withdraw` and `repay` are `onlyPositionManager(onBehalfOf)`. A helper repaying first and withdrawing after would have to be the user's position manager, which needs the user's approval and Aave governance to activate it (`isPositionManagerActive`). And the account can't take a flash loan into its own batch: the manager is `nonReentrant` and the account only runs batches its owners send.
- **Slices cover every starting health within one or two runs.** A slice takes out at most what leaves the health at 1.001. From the fork: 1.25 takes one slice, 1.10 three, 1.05 five, 1.01 nine, as six in one run and three in the next block's (about 2 seconds later on Base). The model in `SellRules` gives the same for factors from 65% to 78%; the worst, Apple at 78% from 1.01, takes 13 slices, three runs.
- **Gas fits.** About 660k plus 234k a slice for the batch; six slices over three stocks used 2.89M for the whole run.
- **Below 1.001 nothing can be sold.** No withdrawal at all fits under Aave's check, so Protect can't act and Aave's liquidation follows its own rules. The heads-up at 1.25 and the immediate sale below 1.10 exist so an account rarely gets there.

Facts found on the way:

- The manager's daily window includes its last second: at exactly `start + 24 h` the old period still counts.
- With the deploy defaults (trigger 1.50, drop 15%, floor 1.10), Weekend Shield never acts before Watch does: 1.10 / 0.85 = 1.29 < 1.50. The fork test runs it with a 30% drop and a 1.40 floor. Calibration is item 6 step 9.
- The contract only fits under 24 KB through the IR pipeline at 200 runs (`foundry.toml` restricts that to this file). Tests that import it compile the same way, and there `block.timestamp` can be reused after a warp, so they read the time with `vm.getBlockTimestamp()`.
- Measured cold: a run of `MAX_WORK` Protect repays uses 3.8M of Base's 5M perform limit.
