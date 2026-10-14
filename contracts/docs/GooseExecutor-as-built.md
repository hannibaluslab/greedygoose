# GooseExecutor as built (M2, then Protect · sell, the Rebalancer and Entry)

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

`GooseExecutor` keeps what every job shares: the registry, who may run, pause and the delayed changes, the paging and shards, the per-account `try/catch`, and the checks every move must pass (the executor holds nothing afterwards). Each job's own rule lives in a library in `src/jobs`: its permission template, when and how much to move, the calls it builds, its own post-checks and the bounds on its numbers. `SaveJob` and `ProtectJob` hold the Cash Agent's two jobs, `SellJob` Protect · sell, `RebalanceJob` the Rebalancer and `EntryJob` the Entry agent; `JobBase` holds what they share (a permission's status, what is left of a limit, the health factor, the per-stock limits Protect · sell and the Rebalancer pack into a grant's terms, and a stock pool's price, which both read before they trade). The pure rules stay where the differential tests read them (`CashRules`, `SellRules`, `RebalanceRules`, `EntryRules`).

Every job library has the same three functions: `permission(env, account, grant, salt, terms)`, `plan(env, ctx, account, state)` and `run(env, ctx, account, state)`; `SellJob.run` also takes the executor's calendar, for the sale time a heads-up gives. `Env` carries the addresses fixed at deploy (a library can't read the executor's immutables) and `Ctx` the grant, the terms and every number the jobs read. `state` is the one registry mapping the job keeps besides the account's slot: the pools' window for Protect · sell, the mixes for the Rebalancer, the waiting coins for Entry. A new job adds a library, a `Job` value and a line in each dispatch. Sizes: core 23.9 KB (693 bytes left; `ExecutorHarness`, the core plus four test openings, has 95), `SellJob` 19.6 KB, `RebalanceJob` 17.4 KB, `EntryJob` 9.0 KB, `ProtectJob` 8.4 KB, `SaveJob` 6.9 KB. The Cash Agent's bound checks moved into `ProtectJob` and `SaveJob` to make room; a sixth job would need the dispatch itself to shrink.

A run plans the jobs in order (Protect from savings, Protect · sell, the Rebalancer, Entry, Save) and the first one to read Aave's health factor passes it on in `Ctx.hf`, so the next doesn't pay for the account data again: about 120k gas an account with seven stocks.

Each job library is linked: its functions are `external`, it is deployed once as its own contract, and its address is written into the executor's bytecode when the executor is deployed. Why a linked library and not an external contract called with `STATICCALL`:

- **Nothing can change it.** A library has no storage, no owner and no constructor, and since Cancun `SELFDESTRUCT` can't remove its code. The address in the executor's bytecode can't be changed either. A new rule is still a new executor, so a new spender and a new grant for every user. There is no proxy and no delegatecall to anything that can change.
- **It is the executor, as before.** A library runs in the executor's context: the manager sees the executor as the spender, events come from the executor's address, and the job reads and writes the executor's storage through the pointers the core hands it. The split changes nothing the audit relies on; it only moves code out of the 24 KB limit.
- **An external contract would buy no isolation.** A job module decides the calls the executor sends as the spender, so even a module that can't write the registry is trusted with the money. What protects users is the same either way: the manager's limits and the post-checks.
- **Less to get wrong.** With a library the job reads what it needs where it lives; a separate contract would need every piece of state passed in and every update passed back.
- **A library refuses to run on its own.** Solidity's call guard reverts any direct call to a state-changing library function, and the library holds nothing to take.

The cost is a library call per job per account. `forge script` deploys the libraries and links them before the executor.

Tests run a job's post-checks around a batch of their own by calling the library's public `snapshot` and `check` and sending the batch as the executor (`vm.prank`); `ExecutorHarness` only opens the template and the clock. That keeps the harness under 24 KB, which the test EVM enforces when a test deploys it. `DeployExecutor.t.sol` checks the real executor and every library fit.

## Protect · sell

Plan item 1, steps 10–12: when savings can't keep the credit Safe, Protect sells some of the stock that backs it and repays. It is its own job (`Job.ProtectSell`) and its own JAW grant, so selling can be switched off alone (decision 5). The rule is `SellRules` (Solidity) and `lib/guardian/sell.ts` (TypeScript): `test/SellRules.t.sol` runs both on 600 sale vectors and 1,000 timing vectors and they agree to the unit.

**What it does.**

- **When** (decision 3): below 1.25 on a weekday, a heads-up (`SellHeadsUp`, with the stock it would sell at Aave's price and when), and the sale 30 minutes later if the health is still below; below 1.10 (Act), at once. Never while prices are held (weekends and holidays, the executor's New York calendar). Back above 1.25, a pending heads-up is cleared (`SellHeadsUpCleared`), so a later fall gets a new one; a sale that gets there clears it too. A sale cut short (a run makes six slices; a limit or the pool cap can stop it) goes on in the next runs without a new wait: `headsUpAt` is set a full delay back. A heads-up is only sent when there is something Protect may sell now. Near a freeze (decision, 2026-10-14) it still goes out on time: one in the 30 minutes before Friday 20:00 gives the reopen, Sunday 20:00 New York, as its sale time (`NyCalendar.nextOpen`, holidays included), and the sale goes then if the health is still below 1.25.
- **Which stock:** the lowest collateral factor first, the most safety per dollar sold. Factors within one point are a near-tie, and the larger holding goes first. "Keep my mix" (`setKeepMix`, only the account itself) sells the same share of each holding instead. Factors are read from each reserve's current config, the one Aave applies to the whole position on a withdrawal.
- **How much:** the least that brings the health back to 1.4 once the proceeds repay at the floor. Each stock is held to its backing, its daily limit, its pool's window and the USDC limit; what one can't cover spills over to the next.
- **Slices:** each slice is withdraw, swap, repay. Aave's spoke checks health ≥ 1.0 right after every withdrawal, so a slice takes out no more than leaves it at 1.001, and no more than $5,000 at Aave's price (about 1% of a pool's USDC). A run makes at most six slices; the rest waits for the next run.
- **Price floor:** every swap's minimum output is Aave's price less 1% (3% in Act, still under Aave's 5.5% liquidation bonus), and each slice repays exactly that minimum. What the swap pays above it stays in the wallet as cash, which Save puts back in savings.
- **Pools that can't fill** (decision, 2026-10-14): before a sale or a heads-up, each stock's Aerodrome pool is read. A stock whose pool sits more than the floor less 0.25% under Aave's price (0.75% after a heads-up, 2.75% in Act) is left out, and the sale spills over to the next stock as it does at a limit. The 0.25% is room for the pools' 0.05% fee and a slice's price impact (a $5,000 slice moves each stock pool under 0.01%, QuoterV2, 2026-10-14). With nothing left to sell there is no move and no heads-up, so a pool that can't fill is never a run failure.
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
| A swap that can't meet its floor reverts the batch | A stock whose pool is too far under Aave's price isn't sold; the sale moves to the next stock | Decision (Adrian, 2026-10-14). A reverted sale counted as a failed run: the account's cooldown also held Protect from savings and Save, every retry picked the same stock, and eight in a row switched every job off. |

**Checking cost.** An account with Protect · sell on costs about 36k more to check while it waits above the heads-up line, using the health Protect already read. One below the line whose sale a stock limit, the pool cap or a pool that can't fill blocks pays for the full plan on every check until the limit resets or the window rolls; the scan's gas stop and its rotating start absorb that.

**Fork tests** (`test/ProtectSellFork.t.sol`), against the real manager, the Equities Hub and Aerodrome's pools with their real balances, from fresh JAW accounts backed by NVIDIA:

| Starting health | What happens | Slices | Run gas |
| --- | --- | --- | --- |
| 1.249 | heads-up; sale 30 min later; 1.40 | 1 | 1.37M |
| 1.099 | sale at once at the Act floor; 1.40 | 3 | 1.79M |
| 1.05 | sale at once; 1.40 | 5 | 2.23M |
| 1.01 | six slices, then the next block's run finishes; 1.40 | 6 + 3 | 2.45M + 1.73M |
| any, weekend | nothing | | |
| 1.05, NVIDIA's pool 3.8% under Aave's price | NVIDIA can't fill even at the Act floor, so it isn't for sale: nothing to do, and a run that lists the account anyway moves nothing and isn't a failure | | |
| 1.05, Tesla's pool 3.8% under, NVIDIA's in line | Tesla (lowest factor) is left out; NVIDIA sells instead; 1.40 | | |
| 1.20 and 1.08, NVIDIA's pool 1.5% under | no heads-up at 1.20 (too far for the 1% floor); 1.08 sells at once at the Act floor; 1.40 | | |
| 1.20, Friday 19:45 New York | heads-up giving Sunday 20:00 as the sale time; nothing on Friday night or over the weekend; the sale at the reopen; 1.40 | | |
| 1.20, Friday 19:45, backing added on Saturday | the heads-up is cleared while prices are held; nothing sells at the reopen | | |
| 1.05 and 1.08 sharing NVIDIA's pool, $1,000 cap | 1.05 first; 1.08 sells what the window leaves, then the rest in the next window | | |

The costliest run, six slices over three stocks, used 2.93M gas, inside `MAX_RUN_GAS` (4.2M) and Base's 5M perform limit. Measured: the manager's batch costs about 660k plus 234k a slice.

## Flash-loan helper: not needed

The panel's open question (eval/protect-panel.json): near 1.0, would the emergency sale need a flash-loan helper, because Aave checks the health right after each withdrawal? Decision: **no helper; slices.**

- **It couldn't work without Aave governance.** The spoke's `withdraw` and `repay` are `onlyPositionManager(onBehalfOf)`. A helper repaying first and withdrawing after would have to be the user's position manager, which needs the user's approval and Aave governance to activate it (`isPositionManagerActive`). And the account can't take a flash loan into its own batch: the manager is `nonReentrant` and the account only runs batches its owners send.
- **Slices cover every starting health within one or two runs.** A slice takes out at most what leaves the health at 1.001. From the fork: 1.25 takes one slice, 1.10 three, 1.05 five, 1.01 nine, as six in one run and three in the next block's (about 2 seconds later on Base). The model in `SellRules` gives the same for factors from 65% to 78%; the worst, Apple at 78% from 1.01, takes 13 slices, three runs.
- **Gas fits.** About 660k plus 234k a slice for the batch; six slices over three stocks used 2.93M for the whole run.
- **Below 1.001 nothing can be sold.** No withdrawal at all fits under Aave's check, so Protect can't act and Aave's liquidation follows its own rules. The heads-up at 1.25 and the immediate sale below 1.10 exist so an account rarely gets there.

Facts found on the way:

- The manager's daily window includes its last second: at exactly `start + 24 h` the old period still counts.
- With the deploy defaults (trigger 1.50, drop 15%, floor 1.10), Weekend Shield never acts before Watch does: 1.10 / 0.85 = 1.29 < 1.50. The fork test runs it with a 30% drop and a 1.40 floor. Calibration is item 6 step 9.
- The contract only fits under 24 KB through the IR pipeline at 200 runs (`foundry.toml` restricts that to this file). Tests that import it compile the same way, and there `block.timestamp` can be reused after a warp, so they read the time with `vm.getBlockTimestamp()`.
- Measured cold: a run of `MAX_WORK` Protect repays uses 3.8M of Base's 5M perform limit.

## The Rebalancer

Plan item 9, steps 2 and 3: once a market day, 30 to 60 minutes after the open, the Rebalancer brings the account's mix of free stock back when a stock breaks its band, selling what grew too big to buy what fell short. It is its own job (`Job.Rebalance`) and its own JAW grant. The rule is `RebalanceRules` (Solidity) and `lib/guardian/rebalance.ts` (TypeScript): `test/RebalanceRules.t.sol` runs both on 800 vectors and they agree to the unit.

**What it does.**

- **The mix** sits in the registry (`mixes`), a weight in BPS per stock adding up to 100%. Only the account sets it (`setMix`, one Face ID); all 0 clears it. Free stock outside the mix is ignored and never traded.
- **When:** 10:00 to 10:30 New York time on a day prices are live (the executor's calendar), at most one batch a day (`Account.rebalanceDay`). It waits while the credit isn't Safe (health under Protect's trigger, 1.5): Protect first.
- **Band:** a stock breaks out past the smaller of 20% of its target and 5 points. Only a stock that broke out is traded back, to half its band. The other side of the trade goes to the stocks still in their band that are furthest from their target, each up to its target, so sales and buys match at Aave's price.
- **Limits:** a swap is at most $25,000 at Aave's price, and each stock gets at most one a day, so a large drift takes a few days. A sale stays within the stock's weekly limit, the buys within the weekly USDC limit; trades under $20 are skipped and the other side shrinks to match. Nothing to sell or nothing to buy means no trade: it never sells to cash or buys with it.
- **Price:** every swap gets at least Aave's price less 0.5%. A stock whose pool is more than 0.5% off Aave's price, or whose reserve is paused (a corporate action holds its price), holds the whole rebalance while it is so; if it stays off through the window, the day passes.
- **Cash:** the buys spend exactly what the sales' minimums bring in, so the wallet's USDC never goes down. What the sales get above their minimums (about 0.45% of what is traded: $1.57 on the fork's $350) stays in the wallet as cash, and Save puts it in savings.
- **A batch that can't fill** (a swap under its floor) is caught: nothing moves, `RebalanceSkipped` is emitted and the day is done. It isn't a run failure, so a bad pool day can't put Protect into cooldown or, after eight, switch the account's jobs off.

**The permission** (`RebalanceJob.permission`, `lib/agents/permissions.ts` `rebalanceGrant`): `approve` on each stock it may sell, `USDC.approve`, Aerodrome's `exactInputSingle`, all with checker 0; weekly limits on USDC (the buy leg, the boards' "sells up to $X a week") and on each stock it may sell, in shares, packed into the grant's terms like Protect · sell's. No Aave call at all, so savings and backing are out of its reach. A stock in the mix without a limit can be bought, never sold.

**Post-checks** (`RebalanceJob.check`): each stock sold fell by exactly its sale and each stock bought rose by at least its minimum, so only mix stocks were bought and every other balance stayed put; nothing that backs the credit moved; savings didn't move; the wallet's USDC rose by at least the sales' minimums less the buys; the executor holds none of the stock.

| Plan | As built | Why |
| --- | --- | --- |
| RebalanceChecker pins the recipient, the floor and the routers | No checker; the executor builds every call and its post-checks revert anything else | D14 (GooseExecutor.md §12). |
| Floor: Aave's price − 0.3% | Aave's price − 0.5%, the same as the pool gap | With pools allowed 0.5% off, a 0.3% floor would fail every sale into a pool 0.3–0.5% under Aave's price, and every buy out of one as far over. At 0.5% the gap check and the floor agree; a batch that still can't fill skips the day. |
| "Only the stock that broke out" | Only it goes back to half its band; the other side comes from the in-band stocks furthest from target | The backtest (eval rebal/backtest.py) spread the other side over every in-band stock by weight: about seven swaps a rebalance, most under $20. Furthest-first needs one or two, and never moves a stock past its target. |
| Skip the day if the pool is > 0.5% off | It waits while the pool is off; the window ends the day | Recording the skip would cost a run for every account every day a pool is off. A pool that comes back within the window trades at a fair price. |
| Skip while the price feed is paused | Skip while the stock's Aave reserve is paused | The feeds have no paused flag (readiness audit); a corporate action pauses the reserve. |
| Slices ≤ $25k | One swap a stock a day, ≤ $25k | Splitting a sale within one batch gets the same pool price; across days, the pool and Aave's price catch up. |
| The floor and the pool gap change through the delay, within their bounds (D18) | The same, and a change can only make them stricter (`RebalanceJob.checkChange`, when it is queued and again when it lands) | Decision (Adrian, 2026-10-14): no change can loosen what a user's swaps get against Aave's price. |

**Gas, cold** (`RebalanceGasForkTest`, seven stocks, three over their band and four under): the check costs about 539k in the window, the run 2.26M, of which the manager's batch 1.35M (`REBALANCE_GAS` caps it at 2M). Outside the window an account with the Rebalancer on costs only the calendar check. In the window a page of such accounts doesn't fit in one check (32 × about 0.5M); the scan's gas stop and rotating start spread it over the next blocks, which the 30-minute window allows many times over.

**Fork tests** (`test/RebalanceFork.t.sol`), against the real manager and Aerodrome's stock pools with their real balances, Aave's prices set to each pool's own:

| Case | What happens |
| --- | --- |
| 50/50 NVIDIA/Apple at 56/44 | one batch: sells $350 of NVIDIA, buys Apple with the sale's minimum; 52.5/47.5, the wallet's USDC up $1.57, savings untouched |
| 10:29:59, 10:30, Wednesday 9:59:59 and 10:00, a Saturday | lists, doesn't, doesn't, lists, doesn't |
| credit at 1.45, then backed to Safe | waits, then rebalances |
| NVIDIA's pool 0.6% off, then 0.4% | holds, then trades |
| NVIDIA's pool 0.48% under Aave's price | the sale can't meet its floor: nothing moves, `RebalanceSkipped`, no failure, done for the day |
| NVIDIA's weekly limit used up | nothing: Apple isn't over its band |
| seven stocks, three over and four under | one batch of seven swaps |
| a buy for someone else, a buy with the wallet's cash, a sale for someone else, a stock off the plan | `StockMoved`, `CashLower`, `CashLower`, `StockMoved` |
| a stock out of the grant | the manager refuses its `approve` |

## Entry on Base

Plan item 2, steps 1 to 3: a whitelisted dollar stablecoin in the wallet becomes USDC in the same wallet at 99.5% of its face value or better, one capped swap a run. It is its own job (`Job.Entry`) and its own JAW grant. The rule is `EntryRules` (Solidity) and `lib/guardian/entry.ts` (TypeScript): `test/EntryRules.t.sol` runs both on 1,000 vectors and they agree to the unit.

**Coins and venues**, each the deepest for that coin on Base, measured 2026-10-14 (`tests/onchain/entry.test.ts` re-reads them):

| Coin | Venue | USDC there | Quote at $1k, $10k |
| --- | --- | --- | --- |
| USDT (6) | Aerodrome Slipstream, first deployment, tick spacing 1 | $177k | 99.86%, 99.86% |
| USDe (18) | Uniswap v3, 0.05% | $724k | 99.96%, 99.95% |
| USDbC (6) | Aerodrome Slipstream, first deployment, tick spacing 1 | $58k | 99.99%, 99.99% |
| USDS (18) | Spark PSM3, 1:1 | $1.0M | 100%, 100% |

GHO is left out: Base has no GHO/USDC liquidity to speak of ($100 of GHO quotes $0.15). Leo's Aerodrome venue (`AERODROME`, the newer Slipstream deployment where the stock pools are) has no stablecoin pools worth using; the first deployment's router and QuoterV2 are now `AERODROME_V1` in `lib/swap/venues.ts`, with the same `exactInputSingle` shape (selector 0xa026383e in both routers' bytecode).

**What it does.** The first coin in that order that isn't waiting and holds at least $1 of face value within today's limit is swapped, all of it up to $10,000 a run (a larger balance goes over the next runs), for at least 99.5% of its face value, decimals adjusted and rounded up. A swap the venue can't fill at the floor is caught: nothing moves, `EntryWaiting` is emitted with the time of the next try, and that coin waits an hour (`entryWaits`) while the next one converts. It isn't a run failure. `EntryConverted` carries what went in and the USDC that came out. Save takes over from there.

**The permission** (`EntryJob.permission`, `entryGrant`): `approve` on each coin, then the three venues' swaps (Aerodrome's first router, Uniswap's SwapRouter02, PSM3's `swapExactIn`), all with checker 0; a daily limit on each coin, all at the same face value (`cap` USDC units, decimals adjusted), so one number is stored.

**Post-checks** (`EntryJob.check`): the coin fell by exactly what was swapped, the wallet's USDC rose by at least the floor, savings didn't move, and the executor holds none of the coin.

The coins and venues are Base mainnet's, fixed in `EntryJob` and checked against the chain by `DeployExecutor.t.sol`: a Base Sepolia deploy has no Entry, and another chain gets its own Entry library.

| Plan | As built | Why |
| --- | --- | --- |
| EntryChecker pins the recipient, USDC out and the 99.5% floor | No checker; the executor builds every call and its post-checks revert anything else | D14. |
| The check reads the venues' quoters to pick the better one | One venue per coin, the deepest, measured | A quoter runs a swap and reverts, which a view (the check) can't call. The swap's own minimum is the quote: one that can't fill moves nothing and the coin waits. |
| USDT, USDe, USDbC, GHO; USDS through PSM3 | The same, without GHO | No GHO liquidity on Base. |
| minOut ≥ 99.5% | The floor can't be set under 99.5% (`EntryRules.FLOOR_BPS_MAX`); a change can only make it stricter | Decision (Adrian, 2026-10-14). The bound was 99%. |
| "Waiting" below the floor | An event and a one-hour wait per coin; the other coins go on | Without the wait, the check would list the account every block. |

**Gas.** The manager's batch costs 200k–320k (one approve and one swap, under `ACCOUNT_GAS`), a one-account run 750k–890k.

**Fork tests** (`test/EntryFork.t.sol`), against the real manager and venues: each coin from $1,000 to at least $995 of USDC in the same wallet (USDT $998.63, USDe $999.57, USDbC $999.93, USDS $1,000); $25,000 of USDT in three runs; a $1,000 daily limit holding $3,000 of USDbC to $1,000 a day; at a 99.9% floor, USDT waiting while USDbC converts; a swap to someone else (`BelowFloor`); and the manager refusing a coin past its limit and GHO, which the grant doesn't list.
