# JustaLab decisions

These records extend Leo's `CLAUDE.md` (D1–D10) and `docs/PARKED.md`. Where they conflict, this file wins.

Full plan: [GreedyGoose final build plan](https://claude.ai/code/artifact/48f85d80-d936-4ed1-a55b-6d49c5dbde8d). Visual reference: the GreedyGoose design canvas (the boards are a reference for the front; they are not edited to track decisions).

## Records

| # | Decision | Replaces |
|---|---|---|
| D11 | **Agents are in scope.** Cash Agent (Save; Protect = repay from savings, then sell backing stock), Entry agent, Rebalancer. Credit Buy, selling, Results and Friends are un-parked. | `CLAUDE.md:11` ("…or run agents"), `PARKED.md` agents, selling, Credit Buy, Results, Friends |
| D12 | **No server, no database.** Agents run in the `GooseExecutor` contract, triggered by Chainlink Automation. The app reads everything from the chain. The only off-chain piece is a stateless price route (and a push service for the heads-up). | D8 (keeper), `docs/guardian.md` keeper hosting |
| D13 | **Test deploys before the audit** are only for throwaway accounts with caps ≤ $5, and are never wired into the production app config. | D10 |
| D14 | **Permissions go through JAW's own screens.** Grant with `useGrantPermissions`, list with `usePermissions`, revoke with `useRevokePermissions`. The spender is `GooseExecutor`. The app sends no raw `addOwnerAddress` or `manager.approve`. The executor builds every call itself and pins "this account only"; JAW enforces the allowed functions and spend caps. | `hooks/useGuardian.ts` raw grant |
| D15 | **Cash is savings.** The cash balance is the Aave V3 savings balance plus wallet USDC. Buys and repays withdraw from savings inside the same Face ID. | D9 |
| D16 | **Navigation:** Home / Invest / Agents / Friends / Pay. Credit is a sheet from Home. Settings sits behind the header menu. | `CLAUDE.md:157` |
| D17 | **Words.** Never show "borrow", "borrowed", "lock", "locked" or "unlock". Use credit, in use, backs, free up. | `CLAUDE.md:34,44,173,175,194` |
| D18 | **Thresholds** live in the executor as on-chain numbers with hard bounds; `config/risk.ts` mirrors them. | D2 (location only) |
| D19 | **No stock APY anywhere.** Stocks earn no yield (`CLAUDE.md:194`). The cash rate stays; "Average yield" is the cash rate. | canvas boards |

## Product decisions (Adrian, 2026-10-14)

1. **More than your cash:** Review is blocked with "That's more than your cash ($X)" and one button, "Use credit for the other $Y". That review is one batch: withdraw savings, take credit, approve, swap.
2. **Who triggers agents:** only the executor's Chainlink forwarders. The owner can pause at once; a new forwarder, backup caller or threshold change waits a public 7-day delay. The very first forwarder is set once at deploy.
3. **Heads-up:** in the app plus a phone notification. Protect acts after 30 minutes even if Sam hasn't seen it.
4. **Yield labels:** see D19.
5. **One Face ID** turns on credit and full Protect (repay from savings and sell backing stock). These stay two permissions, so selling can be switched off alone.

Legal is cleared. No step waits on a legal view.

## Working rules

- Keep Leo's patterns: builders in `lib/`, one write path through `useTx`, the allowlists, the simulation tests. Change his files in place; don't fork new versions of them.
- Don't edit Leo's docs beyond the pointer at the top of `CLAUDE.md`. New decisions go here.
- Real-account tests use our own throwaway JAW account, driven with the JAW CLI (`@jaw.id/cli`), never the test accounts in Leo's suites.
- Never push to Leo's repository. Our remote is `origin` (hannibaluslab/greedygoose).

## From the M2 executor build (2026-10-14)

- **D14 consequences.**
  - Protect · savings has a daily limit on aUSDC as well as USDC, at the same cap. With checker 0 the manager pins no argument, and a savings withdrawal to someone else moves no USDC from the account, so a USDC limit alone would charge it nothing. GooseExecutor builds every call for the account and its post-checks revert anything else.
  - Registration: JAW's grant is one user operation ending in `manager.approve`, so `executor.register` can't ride along. A Chainlink log-trigger upkeep on the manager's `PermissionApproved` registers the grant (the spender is only in the log data, so `checkLog` decodes it); anyone can also call `register` with the grant's values. Until then the app shows the job as "starting".
  - `wallet_grantPermissions` carries one permission, so each agent switched on is its own JAW screen.
- **The keep-back applies only while Save is on.** It exists because Save may sweep wallet USDC above it between simulation and signing. Until Save is on for the account, buys and repays spend wallet USDC first, then savings (`lib/cash.ts`).

## From the Protect · sell build (2026-10-14)

- **Job modules.** GooseExecutor is a core (registry, who may run, pause and delays, paging, try/catch, the "holds nothing" check) plus one linked library per job in `contracts/src/jobs`. Linked libraries can't change after deploy and run as the executor, so nothing the audit relies on moves; there is no proxy and no delegatecall to anything that can change (`contracts/docs/GooseExecutor-as-built.md`, "Job modules").
- **Protect · sell is its own grant** (`Job.ProtectSell`, `sellGrant` in `lib/agents/permissions.ts`). It lists only the stocks Protect may sell, each with its own daily limit in shares, plus USDC and aUSDC at the one cap. A never-sell stock has no `approve`, so JAW's manager refuses any batch that would sell it.
- **It sells on Aerodrome only.** Its stock pools hold $0.44M–1.57M of USDC; Uniswap's hold under $60k.
- **A sale repays its swaps' minimum output** (Aave's price less 1%, 3% in Act). What the swaps pay above it stays in the wallet as cash.
- **"Keep my mix" sells the same share of each holding**, until the Rebalancer's target mix exists (item 9).
- **A sale cut short goes on without a new heads-up** (a run makes six slices; limits and the pool cap can stop it), until the health is back above 1.25.
- **No flash-loan helper.** Slices cover every starting health in one or two runs (1.25: one slice; 1.01: six, then three in the next block). See the as-built doc, "Flash-loan helper: not needed".

## From the Rebalancer and Entry build (2026-10-14)

- **The Rebalancer and Entry are their own jobs and grants** (`Job.Rebalance`, `Job.Entry`; `rebalanceGrant`, `entryGrant` in `lib/agents/permissions.ts`). The Rebalancer's grant has no Aave call; it approves only the stocks it may sell, with a weekly limit each, and USDC for the buys within a weekly limit.
- **The mix lives in the registry** (`setMix`, only the account, in one Face ID). Weights in BPS that add up to 100%.
- **Only the stock that broke out goes back to half its band; the other side comes from the in-band stocks furthest from their target.** Fewer, larger swaps than spreading it over every stock.
- **Every Rebalancer swap gets at least Aave's price less 0.5%**, the same as the pool gap. A batch that can't fill skips the day and isn't a run failure, so it never delays Protect.
- **The buys spend exactly what the sales' minimums bring in.** The rest of the sales' proceeds (about 0.45% of what is traded) stays in the wallet as cash, and Save puts it in savings.
- **Entry's venues:** USDT and USDbC on Aerodrome's first Slipstream deployment, USDe on Uniswap v3 (0.05%), USDS on Spark's PSM3. Each the deepest for its coin on Base; one venue per coin.
- **GHO is not in Entry:** Base has no GHO/USDC liquidity.
- **An Entry swap below 99.5% waits an hour** (`EntryWaiting`) and isn't a run failure; the other coins go on.
- **Entry's coins and venues are fixed in `EntryJob`** (Base mainnet). Another chain gets its own Entry library.

## From the contract follow-ups (Adrian, 2026-10-14)

- **Protect skips a stock whose pool can't fill.** Before a sale or a heads-up, Protect reads each stock's pool and leaves out one more than the floor less 0.25% under Aave's price (0.75% after a heads-up, 2.75% in Act). The sale moves to the next stock. With nothing left to sell there is no move and no heads-up, and the run doesn't fail.
- **Heads-up near the Friday freeze:** it goes out on time. When its 30 minutes end while prices are held, the sale waits for them to reopen and goes then if the health is still below 1.25. The heads-up gives the reopen as its sale time (holidays included), so the app and the phone notification say when.
- **Bounds only tighten.** Entry's floor can't go under 99.5%. The Rebalancer's swap floor and pool gap can only get stricter through the delay. Protect · sell's floors are unchanged (bounded at 0.25% to 5%), since a sale must stay possible.
- **Already as built, unchanged:** GHO isn't in Entry. The Rebalancer takes the other side from the in-band stocks furthest from target (one or two swaps), with a floor of Aave's price less 0.5%. While a pool is off it waits inside the window, and the dust stays as cash for Save. Entry swaps up to $10k a time from $1, and a coin that can't fill waits an hour. These are test defaults, calibrated at go-live.

## From the price build (2026-10-14)

- **JAW first, by each stock's own ticker.** JAW's market data answers by ticker, and a stock's is its registry symbol in capitals: NVDAc → NVDAC, the Coinbase tokenized stock's own. A plain ticker can be another token (JAW's META is about $5).
- **Every market price is checked against Aave's.** It must be within 2% of Aave's price for the stock, and within 10% while US markets are closed (Friday 20:00 to Sunday 20:00 ET): Aave holds Friday's close then while the tokens trade on. Another token is still far outside. A price that fails is never shown. The label stays "Market prices", and on Home and Invest it sits inside the chart, so the layout is the boards'.
- **CoinGecko is the fallback, keyless,** for a stock whose JAW price fails the check or doesn't come. It goes through the app's stateless `/api/prices` route (and `/api/prices/history` for the stock chart), which stores nothing and caches each answer for 2 minutes, since CoinGecko's public API turns callers away after a few calls a minute. The app checks its answer against Aave's the same way.
- **No all-time return until the PnL engine** (plan item 7). It needs what Sam paid, read from the chain; Home leaves the boards' "+$485 all-time return" out until then.
- **GreedyGoose needs its own JAW API key before launch.** One key, `NEXT_PUBLIC_JAW_API_KEY`, serves both the wallet (`lib/jaw/config.ts`) and the market data (`lib/prices/jaw.ts`).

## From the Agents tab build (2026-10-14)

- **The list follows the board's order,** Rebalancer then the Cash Agent, with the Entry agent after them. Each row links to where it is managed (`MANAGE` in `lib/agents/feed.ts`: `/manage`, `/manage/credit`, `/manage/entry`); switching on happens there. Until `NEXT_PUBLIC_GOOSE_EXECUTOR` is set, every agent reads "Not live yet" and one line says switching on opens after the audit.
- **The Cash Agent's pill is the credit's own status** (Safe, Watch, Act) once Protect guards it, as the board's "Protection · Safe". Its line is Protect · sell's daily limit; with selling switched off alone (decision 5) it reads "repays up to $X a day".
- **Agent moves are read from the chain, no indexer:** the executor's events indexed by the account, with getLogs in 5,000-block chunks from `NEXT_PUBLIC_GOOSE_EXECUTOR_BLOCK`, a week at a time ("Show earlier"). The user's own moves older than that week wait for "Show earlier" too, so the two lists cover the same days. The details (You owe, Your cash, Used today, prices) are read at the move's block and the one before, so the RPC must serve past state and `eth_getLogs` (`mainnet.base.org` refuses `eth_getLogs`).
- **Words.** A Save reads "$40 added to your cash" (plan item 1). A repay from savings reads "Your cash: $120 used" (plan §6's "From your cash: $X", in the board's 82px label column). A sale leaves cash "Not touched", or "Not used · +$X" when its swaps brought in more than their floors.
- **"Why" says only what the executor knew:** the status, a sale at once or after the heads-up, the weekend. The board's "Tesla fell 9% overnight" would need price history the event doesn't carry.
- **The heads-up card:** "Add $X" is the repay that brings the health to Protect · sell's target (read live), rounded up; "$Y" is the heads-up's own sale value. "in N min" counts to its `sellAfter`; when the executor's calendar says that falls in a price freeze, it reads "when prices reopen". It shows only while the registry's `headsUpAt` is that heads-up's time, and reads only the spoke's account data, so the warning never waits on the rest of the account.

## From the Manage build (2026-10-14)

- **Manage is two tabs:** Your mix (Manage board) and Credit (ManageCredit). "Every month" (ManageMonthly: Auto buy, Auto top up) stays parked, so the tab control has two. The titles are the boards' own ("Agents" on Your mix, "Manage" on Credit).
- **Saving a tab is at most two Face IDs, each only when needed:** the registry setting through `useTx` (`setMix`, `setKeepMix`), then the job's new JAW grant on JAW's own screen (D14: a grant is its own user operation). A grant replaced this way stays in JAW's list; the executor only runs the newest registered one, and Turn off revokes them all.
- **Stock limits in a grant** (Protect · sell, the Rebalancer) are shares worth twice the dollar limit at Aave's price when granted, held 1% under the executor's registration bound (twice `CAP_MAX`). A stock that falls after the grant can still be sold up to the dollar limit, which is what binds (`stockLimitsRaw`).
- **The Rebalancer's grant** may sell the stocks in the mix. Saving a mix with a stock the grant can't sell asks for a new grant.
- **Protection's "Can sell up to"** is the Protect · sell grant's daily limit. Protect from savings keeps its own $300 a day.
- **The never-sell list is the Protect · sell grant:** the grant lists all seven stocks except the never-sell ones, so a stock bought and used as backing later is covered without a new grant. GooseExecutor has no registry setter for the list; changing it is a new grant.
- **"What happens"** is the Rebalancer's own rule (`lib/guardian/rebalance.ts`) on today's free shares, with a fresh week at the chosen limit. Shares backing credit are left out, and the line says so.
- **"Use credit for buying"** only changes what the Buy sheet offers past your cash (decision 1). It moves nothing, so it lives in this browser and takes no Face ID.
- **Turn off credit:** while anything is owed, it says "Repay the $X first". Once nothing is owed, it revokes both Protect grants.
- **Pause has nothing to call yet:** GooseExecutor has no pause for one account (its `pause` stops every run), so "Pause the Rebalancer" and "Pause Protection" show disabled.

## From the integration of the follow-ups, Agents and Manage (2026-10-14)

- **A heads-up's sale time is the executor's `sellAfter`, as given.** Near a freeze it is the moment prices reopen, holidays included, so the app adds no 30 minutes of its own. The card and the feed ask whether the second before it is frozen; if so they read "when prices reopen", otherwise "in N min" or the time.
- **The Agents list reads the mix where Manage does** (`useAgentSettings`: `mixes`, `accounts` and the executor's live `rebalanceLimits`), so "On target" follows the band the executor runs with. `useAgents` keeps to the jobs and their grants.

## From the Agents redesign: the frame (2026-10-15)

Adrian's spec (eval/agents-redesign.md) replaces the Agents and Manage boards for structure; the kit's look stays. This stage builds the tab and the agent sheet's frame, with Save's and Receive's sheets. It replaces "From the Agents tab build" above (the board's list, its pills and its links to Manage).

- **Four agents, one name each, everywhere on screen:** Save, Protect, Rebalance, Receive (the Entry agent), the activity included; a run that didn't go through is "Agents". The tab is titled "Agents".
- **A row** is the agent, what it does in under six words, its switch, its "next" line, its limit and a chevron to its sheet; Rebalance adds its mix as a bar. Protect's switch is repaying from cash; selling backing stock keeps its own grant and switch (decision 5), and turning Protect off revokes both.
- **"Next"** is the executor's `planOf` for the job it names, and each other agent's TypeScript rule (lib/guardian) on live data: what its grant's limits still allow this period (the manager's `getCurrentPeriod` for each spend of `permissionOf`), today's saves, the Rebalancer's last day, the coins Receive is waiting on and the executor's live numbers. With no executor, the rules run on config/risk.ts and a fresh period. An agent that doesn't run says what it would do ("Would save $40").
- **Limits** (`LIMIT_USD`): Save $250 / $1,000 / $5,000 a day, starting on $1,000; Protect $100 / $300 / $500, starting on $300; Rebalance $250 / $500 / $1,000 a week, starting on $500; Receive $1,000 a day with no other offer. A new limit is a new grant.
- **Every change is a confirm step, then JAW's own screen:** one Face ID for each grant or revoke, said on the confirm. There is no pause for one account, so "Turn off" revokes and switching back on is a new grant. Turning off revokes each grant JAW lists that hasn't ended (an ended one would cost a Face ID for nothing); "Turn off all agents" counts them.
- **Cards only when something needs the user,** most urgent first: the heads-up ("Your credit hit Watch. Add $X, or Protect sells $Y at 3:42 PM.", the time from `sellAfter`, "when prices reopen" near a freeze); three or more failed runs in a row, with when they're tried again; an agent that stopped without the user (its grant ran out, in JAW's list or the registry, or a `JobOff` that isn't a revoke, unless its newest switch is the user's own revoke), with Renew; a grant ending within 7 days, with Renew; a coin waiting for a fair price (`entryWaits`), with its retry time.
- **Renew** is a new grant at the limit the job runs with, or last ran with; a job that sells stock gets limits for the same stocks at today's prices.
- **Rebalance can't be switched on before a mix,** which is saved with its own Face ID (`setMix`); its switch opens its sheet until then.
- **The sheet:** what it does and what it never does, its status and next move, its limit, its settings, "Stops on <date> · Renew", its own moves, and Switch on or Turn off. Receive's settings list the coins it converts, what's in the account and what's waiting. Protect's and Rebalance's settings still open Manage until the next stage moves them into their sheets.
- **Dev gallery** `/dev/ui/agents`: every card, every row state, today's "Not live yet", and each sheet and confirm step, from fixtures run through the app's own rules and words.

## From the Agents redesign: Manage moves into the sheets (2026-10-15)

This replaces "From the Manage build" above for where the settings live (its rules on grants, stock limits and Face IDs stand), and the frame's line that Protect's and Rebalance's settings still open Manage.

- **Manage is gone.** Protect's and Rebalance's settings are the bodies of their agent sheets. `/manage` redirects to `/agents?agent=rebalance` and `/manage/credit` to `/agents?agent=protect` (307, query kept); `/agents?agent=save|protect|rebalance|receive` opens that sheet. The Credit sheet's and Repay's settings buttons, and the Credit sheet's Protect row, open Protect's sheet.
- **One limit and one Face ID button per sheet.** In Protect's and Rebalance's sheets the body carries the limit chips and the Save; the sheet adds no limit line and no "Switch on". While the agent is off, the button reads "Switch on with Face ID", and the line under it counts the Face IDs. A row's switch still opens a confirm at the limit the agent starts on.
- **Protect switches on from its body.** While repaying from cash is off, saving grants it at the limit on screen first, then selling if it's switched on (two Face IDs).
- **"Use credit for buying" is on the Credit sheet,** under Protect. It is about credit, not an agent.
- **Not carried over from Manage:** "Turn off credit" (Turn off Protect in its sheet revokes both of Protect's grants) and the disabled "Pause" buttons (there is no pause for one account; Turn off is the control).
