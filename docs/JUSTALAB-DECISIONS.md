# JustaLab decisions

These records extend Leo's `CLAUDE.md` (D1–D10) and `docs/PARKED.md` (now `docs/archive/mvp-parked.md`). Where they conflict, this file wins.

Full plan: [GreedyGoose final build plan](https://claude.ai/code/artifact/48f85d80-d936-4ed1-a55b-6d49c5dbde8d). Visual reference: the GreedyGoose design canvas (the boards are a reference for the front; they are not edited to track decisions).

## Records

| # | Decision | Replaces |
|---|---|---|
| D11 | **Agents are in scope.** Cash Agent (Save; Protect = repay from savings, then sell backing stock), Entry agent, Rebalancer. Credit Buy, selling, Results and Friends are un-parked. | `CLAUDE.md:11` ("…or run agents"), `PARKED.md` (`docs/archive/mvp-parked.md`) agents, selling, Credit Buy, Results, Friends |
| D12 | **No server, no database.** Agents run in the `GooseExecutor` contract, triggered by Chainlink Automation. The app reads everything from the chain. The only off-chain piece is a stateless price route (and a push service for the heads-up). | D8 (keeper), `docs/archive/guardian-poc.md` keeper hosting |
| D13 | **Test deploys before the audit** are only for throwaway accounts with caps ≤ $5, and are never wired into the production app config. | D10 |
| D14 | **Permissions go through JAW's own screens.** Grant with `useGrantPermissions`, list with `usePermissions`, revoke with `useRevokePermissions`. The spender is `GooseExecutor`. The app sends no raw `addOwnerAddress` or `manager.approve`. The executor builds every call itself and pins "this account only"; JAW enforces the allowed functions and spend caps. | `hooks/useGuardian.ts` raw grant |
| D15 | **Cash is savings.** The cash balance is the Aave V3 savings balance plus wallet USDC. Buys and repays withdraw from savings inside the same Face ID. | D9 |
| D16 | **Navigation:** Home / Invest / Agents / Friends / Pay. Credit is a sheet from Home. Settings sits behind the header menu. | `CLAUDE.md:157` |
| D17 | **Words.** Never show "borrow", "borrowed", "lock", "locked" or "unlock". Use credit, in use, backs, free up. | `CLAUDE.md:34,44,173,175,194` |
| D18 | **Thresholds** live in the executor as on-chain numbers with hard bounds; `config/risk.ts` mirrors them. | D2 (location only) |
| D19 | **No stock APY anywhere.** Stocks earn no yield (`CLAUDE.md:194`). The cash rate stays; "Average yield" is the cash rate. | canvas boards |
| D20 | **Save and Receive are invisible.** Idle cash earning and other dollars becoming cash run under the hood: no agent, row, sheet, switch or card. Earning's grant is asked once at sign-up ("Finish setting up"), the other dollars' grant only when they arrive ("Turn into cash", then "Do this automatically next time?"). The cash is one pot that earns on every screen. | D11 (Save and the Entry agent as agents), D15 (savings shown beside cash), "From the Agents redesign: the frame" (four agents) |

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
- **A sale repays its swaps' minimum output** (Aave's price less 1%, 3% in Act). What the swaps pay above it stays in the wallet as cash. *(Superseded by "Act is the line (Adrian, 2026-10-15)": every sale is in Act now; the 3% floor is for a sale at once, below 1.05.)*
- **"Keep my mix" sells the same share of each holding**, until the Rebalancer's target mix exists (item 9).
- **A sale cut short goes on without a new heads-up** (a run makes six slices; limits and the pool cap can stop it), until the health is back above 1.25. *(Superseded by "Act is the line (Adrian, 2026-10-15)": it goes on only while the credit is still in Act, under 1.10.)*
- **No flash-loan helper.** Slices cover every starting health in one or two runs (1.25: one slice; 1.01: six, then three in the next block). See the as-built doc, "Flash-loan helper: not needed". *(Superseded by "Act is the line (Adrian, 2026-10-15)": back to 1.20, 1.08 takes two slices and 1.01 six, then two in the next block.)*

## From the Rebalancer and Entry build (2026-10-14)

- **The Rebalancer and Entry are their own jobs and grants** (`Job.Rebalance`, `Job.Entry`; `rebalanceGrant`, `entryGrant` in `lib/agents/permissions.ts`). The Rebalancer's grant has no Aave call; it approves only the stocks it may sell, with a weekly limit each, and USDC for the buys within a weekly limit. *(Superseded by "2026-10-20 · Rebalance has no limit, like Protect": the USDC limit is the executor's `CAP_MAX`, with nothing to type; each stock it may sell keeps a limit, at the 32-bit clamp on a deploy with no amount limit.)*
- **The mix lives in the registry** (`setMix`, only the account, in one Face ID). Weights in BPS that add up to 100%.
- **Only the stock that broke out goes back to half its band; the other side comes from the in-band stocks furthest from their target.** Fewer, larger swaps than spreading it over every stock.
- **Every Rebalancer swap gets at least Aave's price less 0.5%**, the same as the pool gap. A batch that can't fill skips the day and isn't a run failure, so it never delays Protect.
- **The buys spend exactly what the sales' minimums bring in.** The rest of the sales' proceeds (about 0.45% of what is traded) stays in the wallet as cash, and Save puts it in savings.
- **Entry's venues:** USDT and USDbC on Aerodrome's first Slipstream deployment, USDe on Uniswap v3 (0.05%), USDS on Spark's PSM3. Each the deepest for its coin on Base; one venue per coin.
- **GHO is not in Entry:** Base has no GHO/USDC liquidity.
- **An Entry swap below 99.5% waits an hour** (`EntryWaiting`) and isn't a run failure; the other coins go on.
- **Entry's coins and venues are fixed in `EntryJob`** (Base mainnet). Another chain gets its own Entry library.

## From the contract follow-ups (Adrian, 2026-10-14)

- **Protect skips a stock whose pool can't fill.** Before a sale or a heads-up, Protect reads each stock's pool and leaves out one more than the floor less 0.25% under Aave's price (0.75% after a heads-up, 2.75% in Act). The sale moves to the next stock. With nothing left to sell there is no move and no heads-up, and the run doesn't fail. *(Superseded by "Act is the line (Adrian, 2026-10-15)": the 2.75% is for a sale at once, below 1.05.)*
- **Heads-up near the Friday freeze:** it goes out on time. When its 30 minutes end while prices are held, the sale waits for them to reopen and goes then if the health is still below 1.25. The heads-up gives the reopen as its sale time (holidays included), so the app and the phone notification say when. *(Superseded by "Act is the line (Adrian, 2026-10-15)": the heads-up goes out only in Act, and the sale at the reopen only if the health is still under 1.10.)*
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
- **Stock limits in a grant** (Protect · sell, the Rebalancer) are shares worth twice the dollar limit at Aave's price when granted, held 1% under the executor's registration bound (twice `CAP_MAX`). A stock that falls after the grant can still be sold up to the dollar limit, which is what binds (`stockLimitsRaw`). *(Superseded in part by "2026-10-20 · Rebalance has no limit, like Protect": the Rebalancer's dollar limit is `CAP_MAX`, so its stock limits come out at the clamp, as Protect · sell's do.)*
- **The Rebalancer's grant** may sell the stocks in the mix. Saving a mix with a stock the grant can't sell asks for a new grant.
- **Protection's "Can sell up to"** is the Protect · sell grant's daily limit. Protect from savings keeps its own $300 a day.
- **The never-sell list is the Protect · sell grant:** the grant lists all seven stocks except the never-sell ones, so a stock bought and used as backing later is covered without a new grant. GooseExecutor has no registry setter for the list; changing it is a new grant.
- **"What happens"** is the Rebalancer's own rule (`lib/guardian/rebalance.ts`) on today's free shares, with a fresh week at the chosen limit. Shares backing credit are left out, and the line says so. *(Superseded in part by "2026-10-20 · Rebalance has no limit, like Protect": a fresh period at `CAP_MAX`, not at a chosen limit.)*
- **"Use credit for buying"** only changes what the Buy sheet offers past your cash (decision 1). It moves nothing, so it lives in this browser and takes no Face ID.
- **Turn off credit:** while anything is owed, it says "Repay the $X first". Once nothing is owed, it revokes both Protect grants.
- **Pause has nothing to call yet:** GooseExecutor has no pause for one account (its `pause` stops every run), so "Pause the Rebalancer" and "Pause Protection" show disabled.

## From the integration of the follow-ups, Agents and Manage (2026-10-14)

- **A heads-up's sale time is the executor's `sellAfter`, as given.** Near a freeze it is the moment prices reopen, holidays included, so the app adds no 30 minutes of its own. The card and the feed ask whether the second before it is frozen; if so they read "when prices reopen", otherwise "in N min" or the time.
- **The Agents list reads the mix where Manage does** (`useAgentSettings`: `mixes`, `accounts` and the executor's live `rebalanceLimits`), so "On target" follows the band the executor runs with. `useAgents` keeps to the jobs and their grants.

## From the Agents redesign: the frame (2026-10-15)

Adrian's spec (eval/agents-redesign.md) replaces the Agents and Manage boards for structure; the kit's look stays. This stage builds the tab and the agent sheet's frame, with Save's and Receive's sheets. It replaces "From the Agents tab build" above (the board's list, its pills and its links to Manage).

- **Four agents, one name each, everywhere on screen:** Save, Protect, Rebalance, Receive (the Entry agent), the activity included; a run that didn't go through is "Agents". The tab is titled "Agents".
- **A row** is the agent, what it does in under six words, its switch, its "next" line, its limit and a chevron to its sheet; Rebalance adds its mix as a bar. Protect's switch is repaying from cash; selling backing stock keeps its own grant and switch (decision 5), and turning Protect off revokes both. *(Superseded in part by "2026-10-20 · Rebalance has no limit, like Protect": no row shows a limit.)*
- **"Next"** is the executor's `planOf` for the job it names, and each other agent's TypeScript rule (lib/guardian) on live data: what its grant's limits still allow this period (the manager's `getCurrentPeriod` for each spend of `permissionOf`), today's saves, the Rebalancer's last day, the coins Receive is waiting on and the executor's live numbers. With no executor, the rules run on config/risk.ts and a fresh period. An agent that doesn't run says what it would do ("Would save $40").
- **Limits** (`LIMIT_USD`): Save $250 / $1,000 / $5,000 a day, starting on $1,000; Protect $100 / $300 / $500, starting on $300; Rebalance $250 / $500 / $1,000 a week, starting on $500; Receive $1,000 a day with no other offer. A new limit is a new grant. *(Superseded in part by "2026-10-20 · Rebalance has no limit, like Protect": the Rebalancer has no limit to choose. Protect's went on 2026-10-19.)*
- **Every change is a confirm step, then JAW's own screen:** one Face ID for each grant or revoke, said on the confirm. There is no pause for one account, so "Turn off" revokes and switching back on is a new grant. Turning off revokes each grant JAW lists that hasn't ended (an ended one would cost a Face ID for nothing); "Turn off all agents" counts them.
- **Cards only when something needs the user,** most urgent first: the heads-up ("Your credit hit Watch. Add $X, or Protect sells $Y at 3:42 PM.", the time from `sellAfter`, "when prices reopen" near a freeze); three or more failed runs in a row, with when they're tried again; an agent that stopped without the user (its grant ran out, in JAW's list or the registry, or a `JobOff` that isn't a revoke, unless its newest switch is the user's own revoke), with Renew; a grant ending within 7 days, with Renew; a coin waiting for a fair price (`entryWaits`), with its retry time. *(Superseded by "Act is the line (Adrian, 2026-10-15)": the heads-up only comes in Act and reads "Your credit hit Act. …"; the weekend heads-up card follows it.)*
- **Renew** is a new grant at the limit the job runs with, or last ran with; a job that sells stock gets limits for the same stocks at today's prices. *(Superseded in part by "2026-10-20 · Rebalance has no limit, like Protect": the Rebalancer renews at `CAP_MAX`, as Protect does, whatever a grant from before carried.)*
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

## D20: Save and Receive are invisible (Adrian, 2026-10-15)

"Idle cash into saving is under the hood, user should not even know", and the same for Receive (other dollars into cash). "Copy should reflect that." This replaces the frame's four agents above with two, and the Agents tab build's words for a Save.

- **The Agents tab is Protect and Rebalance.** Save and Receive have no row, sheet, switch or card, and no "agent" words anywhere; `/agents?agent=save|receive` opens the tab. "Turn off all agents" revokes Protect's two grants and the Rebalancer's; earning and converting stay on, and the app has no switch for them.
- **Their moves are the cash's own events,** under "Cash" with the $ mark and no limit line: a Save reads "$40 added to your cash.", a conversion "120 USDT arrived as $119.83 cash.". Their switches (`JobOn`, `JobOff`) and a coin waiting for a fair price (`EntryWaiting`) make no row. Activity draws the same feed as the Agents tab, the user's own moves with the executor's, so these show there too.
- **Earning (the Save grant) is asked once, at sign-up.** "Create account" goes on to `/setup`: "Finish setting up · Your cash starts earning 3.9%" (Aave V3's live rate, as an APY), one Face ID on JAW's own screen (`useGrantPermissions` with the Save template at $1,000 a day, never above `CAP_MAX`), and a quiet "Later". "Sign in" goes Home. While the account has no Save grant (off, not loading), Home shows one small card, "Finish setting up · Your cash starts earning", with the same Face ID; existing accounts see it too. With no executor configured, neither shows.
- **Other dollars (the Entry grant) are asked about only when they arrive.** USDT, USDe, USDbC or USDS worth $1 or more in the account with no Entry grant (or no executor) puts "120 USDT arrived · Not in your cash yet · Turn into cash" on Home and Pay. "Turn into cash" is a review and one user-signed batch (`lib/swap/entry.ts`): per coin an exact approve to the venue the Entry job uses for it, then the swap into USDC for the user at 99.5% of face value or better (`ENTRY.floorBps`), several coins in one batch. Balances and quotes are read again right before Face ID; a coin under the floor stays as it is. Simulated on Base in `tests/onchain/entry.test.ts`. Then, with an executor and no Entry grant, "Do this automatically next time?": "Yes, with Face ID" is the Entry grant ($1,000 a day), "No" asks again the next time.
- **With an Entry grant the coins convert on their own,** and until they do (the next run, or waiting for a fair price) the Cash card says "120 USDT arriving" and nothing else.
- **The allowlist** lets an Entry coin be approved only to its own venue, and lets Aerodrome's first Slipstream deployment and Spark's PSM3 do nothing but turn an Entry coin into USDC for the user. Uniswap's router also takes USDe into USDC.
- **One pot on every screen.** Activity no longer shows money moving between the wallet and savings: a buy or repay it paid for reads as paid from cash. The buy review no longer names the savings withdrawal (JAW's screen still lists every call). Average yield says "What your cash earns", and that money that just arrived starts earning soon (before earning is set up: it isn't earning yet). Pay says "Send dollars to your name · USDC, USDT, USDe or USDS on Base. They arrive as cash and earn 3.9%.", the rate only once earning is set up. Settings loses Guardian, and Guardian's page (its savings buffer) is gone: `/guardian` opens Protect. The app no longer reads `NEXT_PUBLIC_GUARDIAN_CHECKER` or `NEXT_PUBLIC_GUARDIAN_KEEPER` (the keeper still reads its own).
- **Open:** a Save that sweeps money another row already showed (a conversion, a sale's proceeds, credit taken) also reads "$X added to your cash". The feed can't tell those apart without the wallet's incoming transfers.
- **Open:** "Finish setting up" comes right after sign-up, when a new account holds no USDC, and the grant's network fee is paid in USDC (D4; the app sets no paymaster). Whether JAW can send that grant from an empty account isn't measured yet. If it can't, the step fails with "We couldn't do that right now" and Home's card asks again once money arrives.
- **Open:** Protect repays only from the part of the cash that earns (its job withdraws from savings and reverts if the wallet's USDC goes down). An account that chose "Later" and switches Protect on has cash on screen that Protect can't use; once its credit leaves Safe, Protect's next line reads "No cash to repay with". *(Superseded by "Act is the line (Adrian, 2026-10-15)": the line reads "Act. No cash to repay with" once the credit reaches Act.)*
- **From the review:** earning's grant and the "automatically" grant each retry as themselves (one run each in `useCashSetup`), `/setup` goes Home when the registry can't be read, and the Agents tab's failed-runs card shows only while Protect or Rebalance runs (a run is the whole account's, so with neither on, its failures were earning's or converting's).

## No confirm screens of ours, and limits that read as limits (Adrian, 2026-10-15)

JAW's own sheet shows the Review and asks for Face ID, so the app shows no confirm screen before it. This replaces, in "From the Agents redesign: the frame", "Every change is a confirm step, then JAW's own screen" and the Limits line, and in "Manage moves into the sheets", the "Switch on with Face ID" button, its Face ID count and "A row's switch still opens a confirm".

- **One screen, one plain button, then JAW's sheet.** The last screen of a flow says what matters: what you get, the cost, the status after, the network fee, and every move in small print (D7). Its button opens JAW's sheet straight away, and comes back with the result. Gone: Buy's review (F1-5), Credit Buy's confirm (F2-6, folded into F2-5), Sell's review in the stock sheet, Use credit's review, decision 1's review (its "Use credit for the other $Y" now signs), and the agents' confirm steps for switching on, a new limit, Renew, Turn off and Turn off all agents. Repay and Free up never had one; they now show the fee, and Repay what comes out of savings.
- **The risk tick stays,** on the same screen (D2's extra confirmation, `needsExtraConfirm`), next to the button.
- **Buttons name the action only:** Buy, Credit Buy, Repay, Sell, Free up, Save, Switch on, Turn off, Renew. Never "with Face ID", and no Face ID glyph (`TxButton`). When one tap opens JAW's sheet more than once, a small line under the button says "2 steps" (or n). While JAW's sheet is open, the screen adds nothing of its own; after signing, the button reads "Confirming on Base…".
- **A change that stops part way** says how many went through, in the open sheet, or as a toast from a row, a card or the tab. Trying the same change again runs only what didn't go through.
- **Limits read as limits.** Rows: "Limit $100 a day", "Limit $100 a week". In the sheet the limit is its own card, "Daily limit" or "Weekly limit", with one line: "Protect never moves more than this in a day." (Rebalance: "…in a week"). *(Superseded in part by "2026-10-20 · Rebalance has no limit, like Protect": no "Limit $X a week" and no "Weekly limit" card for the Rebalancer.)*
- **Limit choices for Protect (a day, selling included) and Rebalance (a week):** $25, $50, $100, $200 and Custom, which opens the kit's amount field for any whole number of dollars. Each starts on $100. Save and Receive keep theirs. The executor's `CAP_MAX` still holds every grant ($5 on the D13 test deploy); in dev only, when it bites, the card says "Test version: up to $5". *(Superseded in part by "2026-10-20 · Rebalance has no limit, like Protect": the Rebalancer has no limit choices, and the test deploy's note went with them.)*

## From the integration of D20, the sweep and the welcome (2026-10-15)

- **D20's screens follow the sweep's rules.** "Start earning" (the sign-up's last step and Home's small card) and "Yes" ("Do this automatically next time?") open JAW's sheet straight away, with no "with Face ID", no Face ID glyph and no "One Face ID" line under them; the line says only why a button can't go ahead.
- **"Turn into cash" is one screen.** The "120 USDT arrived" card on Home and Pay carries what the review said: each coin and what it brings now, the least it all brings, the network fee, and every move in small print (D7). Its own "Turn into cash" signs. Once the batch lands, a sheet asks "Do this automatically next time?" (it says what the conversion brought), or, with nothing to ask, says "It's cash now".
- **One pot wins over the sweep's savings lines.** Neither the Buy step's small print nor Repay says what comes out of savings (D20); JAW's sheet still lists every call.
- **The welcome's one Continue still sends a new account to `/setup`.** JAW's frame signs in and signs up alike and doesn't say which, so the app reads the chain: a JAW account has no code on Base until its first move, so an account with none is new and goes on to "Finish setting up"; one with code goes Home. A session JAW restores on load, or a code read that fails, goes Home, where the small card asks instead. An account that chose "Later" and has moved nothing since sees the step again on its next Continue.

## Start earning once money is in (Adrian, 2026-10-14)

- **Earning is asked when money comes in, not at sign-up.** At $0 there's nothing to earn on and nothing to pay JAW's fee with. Sign-up goes straight Home (`/setup` is gone and redirects there). Home's card shows once the account has $1 or more of cash and no Save grant: "Your $100 arrived · Start earning 4.6% on it." with one "Start earning" (board 2g). This replaces "The welcome's one Continue still sends a new account to `/setup`" above. *(Superseded in part by "Start earning moves the cash in the same tap (Adrian, 2026-10-15)": the card shows on idle wallet cash, with or without an executor, and its tap puts that cash in savings.)*
- **The empty portfolio fills Home down to the tab bar:** the board's dashed "add a stock" card, grown, with the seven stocks and one Buy stocks button.
- **Home's round mark is the GreedyGoose logo,** not the name's initial.

## Credit Buy opens on what you can use (Adrian, 2026-10-15)

"Credit buy should open the slider, tell him how much he can borrow and show under the market so he can select which one he wants to buy with a credit."

- **Home's Credit Buy opens the Credit Buy sheet,** the same one as Invest's (`StockSheets`). The Credit sheet still opens from the ⓘ beside Home's Credit (board 2f).
- **F2-3 starts with one number, "You can use up to $X",** then "Your holdings" and "Other stocks". A Credit Buy is backed by one free holding plus what already backs credit (F2-4), so $X is the largest of F2-4's per-stock figures, not their sum (`creditAvailable`, on `planCredit`'s MAX: net of what's owed, within what Aave can lend). F2-4 picks that holding first (`bestBacking`), so F2-5's "Up to" is the same $X; collateral factors differ by stock, so it isn't always the holding with the most free stock.
- **$0 says why in one line** (no stock yet, nothing that can back credit, all in use, new credit paused, nothing to lend), under the label "Credit you can use", and a stock tapped there opens its Buy step with cash; its Back returns to F2-3. With less cash than the smallest buy and its fee, the line says to top up first. Under the $1 minimum buy counts as $0. Opened from a stock's sheet, Credit Buy still starts at F2-4.
- **Credit but no network fee:** with less than $0.50 of cash, the number stays and the line says "Add $0.50 to your cash for the network fee first." (D4: cash pays it, and F2-5 blocks every amount without it).

## Credit Buy goes backing first (Adrian, 2026-10-15)

"Something that is missing in credit buy flow, is selecting and typing the amount of an asset that you put in collateral to actually get the usdc to be able to then select one from the market sheet."

This replaces, in "Credit Buy opens on what you can use" above, the order (F2-3's stocks first, then F2-4), "F2-4 picks that holding first (`bestBacking`), so F2-5's 'Up to' is the same $X" and "Opened from a stock's sheet, Credit Buy still starts at F2-4". Its $0 lines, the fee line and the Credit sheet's ⓘ are unchanged.

- **Four steps, backing first** (`CreditBuySheet`): 1 **Back it with**: the free holdings that can back credit (the one that can back the most is picked first; each shows its free value and what's in use, as before), a row **Already backs credit** with the room left on it when something does, then the holdings that can't, and why. 2 **How much to put in use**: dollars of that holding, MAX for exactly its free shares, the shares under it. 3 The stocks (F2-3's list), opening on "You can use up to $X". 4 The amount to buy (F2-5), up to $X, with its quote, small print, D2 risk tick and Credit Buy button. Home's and Invest's Credit Buy open at step 1.
- **One figure, $X:** `planCredit` with the pick (`backing: { option, raw }`): the most credit the typed backing and what already backs credit allow, at 99.5% of Aave's limit and within what can be lent (Leo's `combinedLoan`, no new formula). Step 2's live line, step 3's number, and step 4's "Up to" and MAX are that one figure. Invest's buying power stays `creditAvailable` (the best holding, all of it), which is step 2's MAX on that holding. *(Superseded in part by "Act is the line (Adrian, 2026-10-15)" below: the figure is at health 1.12, not 99.5% of Aave's limit.)*
- **Step 2 starts empty.** Any amount filled in for Sam would be a credit choice he hasn't made yet (the stock and the amount come after), and "the least that stays Safe" needs a credit figure we'd have to invent. Empty, the live line answers "what does this much give me" from the first digit, MAX is one tap, and an account that already backs credit sees its room at once. Under the line: "Stays Safe up to $Y" and, when something is owed, the status now → with this in use (the backing alone, before new credit), then the risk line. Continue needs $X of at least $1, the minimum buy. More than is free says so in red, and the plan blocks it (`over-free`).
- **Exactly the typed backing goes in,** not autoFill's amount: the batch is still one JAW sheet (put it in use, take the credit, exact approve, swap; savings and cash rules unchanged). `assertCreditBuy` now also checks that each supply is the plan's backing, for the user, approved exactly to the spoke and before the credit, never more than the free shares the screen read, and that the credit is no more than the plan's `limit` (`CreditLimit`: those free shares, and the room with exactly that backing). Decision 1 and Earn with stocks keep autoFill (`planCredit` without `backing`); their batches carry the limit of the backing autoFill chose.
- **Nothing new in use:** picking "Already backs credit" skips step 2 (backing 0), allowed while its room is $1 or more; a holding with nothing typed gives the same figure. Under $1 the row reads "Nothing left to use · Repay".
- **From a stock's sheet:** step 1 opens with that stock remembered and named in the title, and step 3 is skipped. Back from step 4 returns to step 2 (step 1 after "Already backs credit"), and from step 1 to the stock's sheet.
- **$0 to use** (no stock, nothing that can back credit, everything in use with under $1 left, new credit paused, nothing to lend): step 1 is F2-3's zero state as before, the reason and a stock tapped opens its Buy step with cash.
- **The D2 tick** is unchanged (step 4, when the plan ends in Watch or Act). With an explicit backing, more credit on the same backing reaches Watch sooner than autoFill did, since autoFill added backing to stay Safe; the tick and "Status after" say so. *(Superseded in part by "Act is the line (Adrian, 2026-10-15)" below: the tick is for ending in Watch; ending in Act is blocked.)*
- **Tests:** `tests/unit/credit-buy.test.ts` (the limit grows with the backing, MAX is all the free shares, never more than free, 0 uses only what already backs credit, the D2 tick, step 2's figure is step 4's, the batch's limit and backing checks, the allowlist); `tests/onchain/credit-buy.test.ts` simulates explicit backings with `eth_simulateV1`: half the preview account's free Amazon, all of it (none left behind), none at all, and $20 of NVIDIA on an account that never backed credit (the credit capped by it alone).
- **Open:** the risk line and the tick still say "Aave can sell part of it", as they did; Adrian's "no protocol words on screen" for the new copy is kept, the old lines are left for him to call.

## From the Credit Buy backing review (2026-10-15)

- **No padlock on the new row:** "Already backs credit" draws welcome-bg's linked rings (`BacksIcon`, D17), like the holdings it lists.
- **The whole free value typed by hand is all of it** (`isAllFree`): from the cent MAX fills in (or half a cent under, whichever is lower) to half a cent over. Step 2 records it as "all" when it's typed, so a later price move can't turn it into "more than you have free" or leave dust behind. Any other amount becomes shares when it's typed, and those shares are what goes in use: the price moving afterwards changes what they're worth ("You can use up to" moves with it), not how many. Clearly more than is free is still blocked (`over-free`).
- **A new backing clears the amount to buy:** changing step 2's amount or picking another holding empties step 4, so it can't show an amount meant for a bigger backing.
- **A picked holding that can't back credit any more** (under $1 free, paused, or no longer read) doesn't quietly fall back to what already backs credit: steps 2–4 say "{Stock} can't back credit right now" with **Pick again**, and step 1 goes back to its default pick.
- **The D2 tick is asked again when "Status after" changes** (a price refresh from Watch to Act), as in Earn with stocks. *(Superseded in part by "Act is the line (Adrian, 2026-10-15)" below: a refresh into Act now blocks instead of asking again.)*
- **Buy with cash from a Credit Buy keeps its way back:** Back returns to that Credit Buy as it was, with its stock and its way back to the stock's sheet.
- **Step 2 at $0** reads "Credit you can use", as step 1's figure does. While the amount is more than is free, the line under it gives the free shares only, not "X of Y".
- **Free stock too small to back the $1 minimum buy, with nothing backing credit yet,** gets its own reason: "Your free stock is too small to back credit yet." It used to say "Your stocks already back what you owe."
- **Open for Adrian:** the default pick (a dust-sized free holding is picked ahead of "Already backs credit", e.g. the preview account's $1.79 of Amazon over $6,385 left), and the remaining protocol words on screen ("Paused by Aave", "Aave can sell part of it", "over Aave's price").

## The Trade sheet (Adrian, 2026-10-15)

"Trade sheet should be the same as nym where you can swap between any assets you have", and Invest gets "trade cta in between market and credit buy".

- **Home's Trade and Invest's Trade open one sheet,** NYM's MoveSheet in the kit (`TradeSheet`): From (Cash, or a stock's free shares) over To (Cash or any of the seven stocks), a flip button between them, dollars with MAX, what you get and the price, "Network fee · Paid from your cash", one button. Each card's pill opens NYM's in-sheet list ("Trade from", "Trade to"); a tap away or Escape closes the list, not the sheet. The Market sheet stays where it was (Invest's Market, `/buy`, "add a stock").
- **Invest's row is three even pills:** Market · Trade · Credit Buy, Trade in the middle as Adrian asked, the board's 52px pills 8px apart.
- **Three routes, one batch each (`useTrade`):** cash → stock is the Buy step's batch, stock → cash the free-shares sale, and stock → stock sells and then buys in the same batch (`buildTradeCalls`). The buy spends exactly the sale's floor (the quote less 1%, never under Aave's price less 10%), which the router guarantees reaches the user first, so the trade never spends cash the user already had. When the cash is under the $0.50 fee buffer, the buy is the floor less $0.50 and the sale pays the fee. Otherwise the cash pays it (`payFromCash`, a savings withdrawal first when the wallet can't be counted on). What the sale brings above the buy stays as cash ("To your cash · about $X"). Both quotes are read again right before JAW's sheet, and the whole batch is simulated. Simulated on Base in `tests/onchain/trade.test.ts`.
- **Only free shares trade here.** The From card says how much is free and "$X of it backs your credit."; a stock whose shares all back credit, or with under $1 free, is listed and can't be picked. Nothing in the batch touches the spoke, so credit, backing and health can't move.
- **Buttons:** "Buy Apple", "Sell NVIDIA", "Trade". A sale says "Sold … · What the sale paid is in your cash." in the sheet.
- **Words:** the main screen names no protocol: "the stock’s price" stands for Aave's price there, and the small print names the venues and Aave's price (D7).
- **From the review:** MAX keeps selling every free share when To changes or the legs flip back, and an amount at exactly a stock's free value sells all of it, so no dust under a cent is left that could never trade (`tradeForm`, `clampAmount`); more shares arriving after MAX aren't sold unseen. The flip button's tap area is 44px. Close closes the sheet with a list open (only the dim's tap is swallowed). A sale whose stock can't move (STF from the router: what's held changed, or the stock is paused or held by its policy) says so by name instead of "Your cash moved". The From list's Cash row shows what MAX takes, the cash less the network fee's $0.50.

**Builder defaults, pending Adrian.** These were chosen in the build, not by Adrian. Each stays open until he settles it; don't cite one as settled.

- **Market's icon on Invest is a storefront.** The board draws Market with ↑↓, which is Trade's (Home's quick action and the flip button), so this departs from the board on one glyph and needs his call before merge.
- **The row's labels step to 14px under a 390px screen, and the icons drop under 360px.** Measured with Geist: at 360px Credit Buy with its icon is 94.8px in a 101.3px cell; at 340px it no longer fits.
- **About 1% of a stock → stock trade comes back as cash.** The buy spends the sale's floor (the quote less 1%); a tighter floor would cancel more trades in thin pools.
- **A buy or a trade lands on Home with its toast,** even when it started on Invest, as the Buy flow does ("Bought 0.4554 NVDA", "Traded NVDA for 0.0086 AAPL").
- **No credit in Trade.** Typing more than the From card takes snaps to the most it takes (NYM's clamp); Credit Buy stays its own button.
- **Activity shows a stock → stock trade as two rows** (Bought, Sold) from one transaction.

## Cash sheet (Adrian, 2026-10-15)

Adrian asked for two things: "Cash sheet should show you the amount of cash, the part that is borrowed, and activity what was moved or converted, received and sent/pay", and "earn with stocks in the cash sheet, use your stock to add more cash to get yield". Home's Cash card opens it (it went to Pay; Pay stays on the tab bar). The info sheets' kit: one drawer, two steps (Cash, Earn with stocks).

**Everything below is a build choice, not a decision of Adrian's.** Each is open until he settles it; don't cite one as settled.

- **The credit rule: no "part from credit".** Credit enters the cash only when it's taken as cash (Use credit, Earn with stocks); a Credit Buy and decision 1 spend it inside the same batch. Once in, it is the same USDC as the rest: Save sweeps it into the same savings, buys, repays and Protect spend from the one pot, and a repay lowers one debt that mixes every kind of credit. Which dollars are "credit" is a convention nothing on chain records, and min(cash, owed) would say a Credit Buy's debt sits in the cash when none of it ever did. So the sheet shows, from live data only, what's owed in its own card under the cash, not inside it ("You owe on credit $65", rounded up as on Home, with "Repay from your cash any time.") and every time credit came in as its own row ("From credit +$500.00", backed by what). Open: whether that answers "the part that is borrowed".
- **Its activity is the cash's,** the last 7 days, newest 6, then "See all" to Activity: the user's own moves (JAW's history and receipts) and the executor's, plus money someone else sent, read from USDC's Transfer logs to the account in the executor feed's 5,000-block chunks (cached once settled, read only while the sheet is open; a transaction that brought under a cent in all is dropped before its receipt is fetched). Only the first read shows a skeleton; later blocks' reads keep the rows and any notice on screen, and a rate-limited read waits for the next block instead of retrying. Each row is signed by what it did to the cash: "120 USDT became cash +$119.83", "Bought NVIDIA −$100.00" (the cash part; "$300.00 of it on credit" in the details), "Sold", "Repaid credit", "From credit", "Received", "Sent", "Protect repaid credit", and a Protect sale or a Rebalance trade only when it left the cash up. A pure Credit Buy, backing put in use or freed, failed batches and fees make no row. Received rows show no sender (address poisoning).
- **Saves make no row in the sheet** (D20: earning moves nothing in the one pot), and with arrivals read they would count the same money twice. Activity still shows them. Open: whether Activity drops them too (D20's open point on a Save that sweeps money another row showed).
- **JAW's network fee isn't a move.** Measured on JAW receipts: the paymaster takes the USDC fee in its postOp, in the same transaction, to its treasury (not to the paymaster's own address). The decoder leaves out the one transfer of exactly what the paymaster's `UserOperationSponsored` says it took, for the user's operation as EntryPoint v0.8 reports it. Activity loses its stray "Sent $0.01" rows, and a buy's price no longer counts the fee.
- **One cash rate in the sheet:** the lead and the Earn with stocks card both round the cash rate down to a tenth. Home's Yield card rounds to the nearest tenth, so at 4.16% Home says 4.2% and the sheet 4.1%. Open: whether to round down everywhere.
- **Earn with stocks** puts stocks to work as backing and takes credit as cash in one batch (approve, supply and use as backing for each stock the plan picks, then the credit, last; checked by `assertEarn`, nothing else). No new allowlist entry: the credit lands in the wallet and Save moves it.
  - **Offered only when it earns:** earning on (no user-signed savings supply exists), stocks that can back credit, new credit not paused, cash for the network fee, and what the cash earns above what credit costs. Rates are APYs in tenths, the cash's rounded down and the credit's up, so the gap shown is never overstated; at 0.0 or below it isn't offered ("Credit costs more than your cash earns right now."). With earning off the card says "Start earning first. Then Earn with stocks opens." (no button of its own: Home's Start earning card is the one way in). If a read it waits on fails, one line ("We couldn't check this right now. Try again in a moment.") instead of a skeleton.
  - **Capped** at the least of 99.5% of the credit limit (as /use-credit), the USDC available, and what Save's next run moves in full today: its grant's daily USDC left, less wallet USDC already waiting above the keep-back, none once today's saves are used up. Credit above that would sit idle until tomorrow. The smallest amount is $1 (more when Save's smallest save is; then, when the stocks back less than that, the line says so). *(Superseded in part by "Act is the line (Adrian, 2026-10-15)" below: the credit part of the cap is at health 1.12, not 99.5% of the credit limit.)*
  - **The cost at an amount is marginal:** the batch is simulated with the risk premium and the Hub's drawn rate read after it, and the rise in the whole debt's yearly cost is this credit's cost, never less than the rate the credit itself pays after the batch. If the read fails, today's rate.
  - Status before and after, D2's tick for Watch or Act (asked again if a price refresh changes the status it names), the risk line from Protect's state, the weekend line, every move in small print (D7), one button, JAW's sheet. The step stays on screen while the batch confirms. *(Superseded in part by "Act is the line (Adrian, 2026-10-15)" below: the tick is for ending in Watch; ending in Act is blocked.)*

## The Leaderboard (Adrian, 2026-10-15)

"Friends becomes leaderboard." One board, no separate pages: a filter at the top, All | Contacts. This extends D12 (a GooseBoard member list; still no server and no database) and replaces in D16 the Friends tab, and in the plan's item 7 / M8 "the plan only ranks friends" and its opt-in flag.

- **The tab is "Leaderboard"** (it fits the 390px tab bar), at `/leaderboard`; `/friends` redirects to `/leaderboard?filter=contacts` (307). D16 is now Home / Invest / Agents / Leaderboard / Pay. `NEXT_PUBLIC_LEADERBOARD=off` hides it; the old `NEXT_PUBLIC_FRIENDS=off` still does.
- **All** is everyone, ranked: the first 50, your own row lit, and pinned under them after a gap when you're further down (the booth's board). Then everyone not ranked yet. **Contacts** is the same board filtered to the people you added, and you, with their ranks on the whole board; your contacts who aren't on it yet sit below, unranked: "Not on the board yet · Joins with their first move in GreedyGoose."
- **Everyone is on it, from their first move.** GooseBoard (`contracts/src/GooseBoard.sol`): `join()`, `leave()`, `members[]`, `listed`, `joinedAt` (the block of the latest join), Joined and Left. It holds nothing, calls nothing and has no owner; only an account puts itself on or takes itself off. `leave()` isn't in the app yet. The one write path (`useTx`) adds `join()` at the end of any batch from an account whose `joinedAt` is 0 (`lib/board/join.ts`), so every flow carries it and it never costs a prompt of its own; an account that left isn't put back. A failed read leaves the batch as it is. The allowlist takes `join()` alone, its selector and nothing after it, no value. JAW's grant screens aren't batches, so switching an agent on doesn't join; the next move does.
- **Not deployed:** Adrian approves and signs the deploy (`contracts/docs/DEPLOYMENTS.md`, `script/DeployGooseBoard.s.sol`). Until `NEXT_PUBLIC_GOOSE_BOARD` is set the tab says "The leaderboard opens soon." and no batch carries `join()`.
- **The one number: return since joining, percent only** (`lib/board/score.ts`). Net worth = cash (wallet USDC and savings) + other dollar coins at face value + stocks at Aave's price, including those backing credit, − credit owed. Gain = net worth now + money taken out since joining − money put in since − net worth at joining. Return = the lower of gain ÷ own money and gain ÷ (own money + the most credit in use at once), own money being net worth at joining plus money put in. On a gain that is the brief's formula; on a loss, credit kept as cash can't cushion it. So credit never lifts the percent, deposits, withdrawals and payments between members never count as gain, and fees, interest and a liquidation's penalty lower it. Ranked from $20 of own money ("Not ranked yet" under it); ties go to whoever joined first.
- **Money in and out** (`lib/board/flows.ts`): a transfer of USDC, savings (aUSDC), another dollar coin or a stock to or from anyone else, other members included; Aave V4 or V3 acting on the account for someone else (supplied or repaid for it is money in; withdrawn or drawn by someone else, or savings sent elsewhere, is money out). Moves with Aave, the swap pools (read from the venues' factories) and the agents stay inside the account. JAW's network fee is a cost, not money out: its paymaster (`0x8888…2402`, `@jaw.id/core`'s ERC20_PAYMASTER_ADDRESS) records each USDC fee in `UserOperationSponsored` (measured on Base 2026-10-15), and the transfer of that amount in the same transaction is left out. A stock is valued at Aave's price in the block it moved.
- **Read in the browser, from the chain** (`lib/board/read.ts`): members from GooseBoard; per 10,000-block chunk from the first join, four eth_getLogs for every member at once (transfers from, transfers to, Aave V4 position events, Aave V3 savings and the paymaster's fee records); holdings at each join block and now, and Aave's prices at the blocks that need them, which are past state (mainnet.base.org serves it). Chunks the chain is 64 blocks past are kept in memory and this browser's storage. Logs come from `NEXT_PUBLIC_BASE_RPC_URL`, else PublicNode's keyless endpoint (mainnet.base.org refuses eth_getLogs). Any read that fails shows "Couldn't load the board" with Try again, never a partial board. Refreshed every minute.
- **Contacts are on-chain, as in the booth:** the account's EFP follow list on Base, the booth's `src/lib/efp.ts` and `efp-chain.ts` ported to `lib/efp/`. Add one from a row's sheet ("Add to contacts"), several with "Add several" (ticks, then a bar "N selected · Add"), or by name ("sam" means sam.justan.id; a JAW or ENS name resolves through ENS's offchain lookup, its Base address first). The first add mints the list in the same batch. Remove writes EFP's remove op on-chain, which the booth never did. One JAW sheet each; the network fee is paid in USDC like every batch (D4, no paymaster of ours). The list is read again right before JAW's sheet. A list kept elsewhere (another chain or records contract) is never replaced by a new one. The allowlist lets EFP's minter only mint a list on Base in EFP's records contract, lets the records contract take only add/remove ops of one address each (at most 25) on the user's own slot (the one read from Base, or the one minted in the same batch), and gives EFP's registry and account metadata no calls at all.
- **Words:** percent only, never dollars; no Safe / Watch / Act; nothing on the board to buy, sell or take credit with; no EFP, Aave or contract on screen. "Contacts are saved on-chain, under your name." sits in small print.
- **Dev:** `/dev/ui/board` draws every state from fixtures; `scripts/board-e2e.ts` runs it all on an anvil fork of Base (first moves built by the app's code with join() appended, EFP adds and a remove, money moving after joining, the board read back and checked).
- **Open:** PublicNode's keyless endpoint answers eth_getLogs only for about the last 10,000 blocks (measured 2026-10-15; older ranges need its personal token), so without `NEXT_PUBLIC_BASE_RPC_URL` set to an RPC with the board's full log history, the board can't load once its first member joined more than about five hours earlier. Production needs that RPC.
- **Open:** each phone reads every member's history. Past a few hundred members, or months of history, the same functions belong in a cached stateless route (the `/api/prices` pattern), which would need its own decision.
- **Open:** "Ranked from $20 put in." is the board's only dollar figure: the rule, not anyone's money.

## From the Leaderboard review (2026-10-15)

The review showed the score could be lifted with money the member didn't make. This replaces, in "The Leaderboard" above, "Moves with Aave, the swap pools (read from the venues' factories) and the agents stay inside the account" and the open line about "Ranked from $20 put in.".

- **A leg is the member's own only when the same transaction shows the member doing it** (`lib/board/flows.ts`). With Aave V4's hub or spoke, the member's own spoke event for that reserve (it is the caller and the position is its own). With Aave V3's savings, its own Supply, Withdraw, Borrow or Repay; savings minted and burned stay its own. With a swap venue, a leg back from the same venue in the same transaction (Spark's PSM3 and its pocket, read live, are one venue). Anything else is money put in or taken out: someone else's swap paid out to the member, a router's sweep, PSM3 paying out someone else's USDS, and paying a venue that sends nothing back (a swap paid out to someone else). The swap routers, Aave V3's pool, the executor and GooseBoard are no longer treated as part of the account: the app's swaps move tokens between the account and the pool directly, so what a router sends is someone else's money.
- **Credit on Aave V3 is credit.** A JAW account can draw USDC against its savings in another app. Net worth subtracts its Aave V3 USDC debt (`variableDebtBasUSDC`, `AAVE_V3_USDC_DEBT` in `lib/board/tokens.ts`, the pool's `getReserveData(USDC).variableDebtTokenAddress`, read 2026-10-15). Its Aave V3 Borrow, Repay and LiquidationCall are credit steps, so they count in the most credit in use; someone else drawing on the member's credit is money taken out, someone else repaying it is money put in, and a liquidator taking its savings is the liquidation's cost. Credit in another asset isn't in net worth, and reaches the board only once it is turned into something it tracks, as money put in.
- **Savings one member supplies for another net to zero:** money taken out for the one who paid, money put in for the one whose savings grew.
- **No dollar figure on the board.** Not ranked yet reads "Ranked once they’ve put money in." ("you’ve" on your own sheet). The $20 rule is unchanged.
- **Accounts that join and do nothing can't swamp it.** Anyone can join and nobody can remove anyone; the contract stays as it is, and the reads carry the defence. On All, the people not ranked yet are rows only for you and your contacts, and a count for everyone else ("And 12 others."); their names aren't looked up. An account the board saw nothing happen to since joining (no money in or out, no trade, no credit) that holds under $1 now isn't ranked, and its join block isn't read. State reads go four at a time, as the log reads do, and past prices and holdings at joining are kept in this browser's storage. Past a few hundred members, the cached stateless route is still the open question above.
- **Smaller fixes:** a failed contacts read says "Couldn’t load your contacts"; the error line no longer promises "in a moment" (an RPC that refuses old ranges refuses them for good); the footer says money added or taken out "doesn’t count as a gain"; a name outside the app's parent that gives only an Ethereum address says so before Add; name lookups go six at a time; an account read as joined isn't read again in the session; Clear and Find are 44px; the deploy takes forge's wallet flags (`--account`, `--ledger`, `--interactives 1`), so the key stays out of the shell's history, and `NEXT_PUBLIC_BASE_RPC_URL` is set before `NEXT_PUBLIC_GOOSE_BOARD` (`contracts/docs/DEPLOYMENTS.md`).
- **Tests:** `tests/unit/board-logs.test.ts` decodes recorded Base receipts (Aave V4 Supply, Borrow and Repay, Aave V3 Supply, Withdraw, Borrow and Repay, the paymaster's fee); the flows and score tests cover a third-party swap, a router sweep, a PSM3 payout, a payout beside the member's own trade, Aave V3 credit kept as cash or spent on stocks, and savings supplied for another member; `scripts/board-e2e.ts` runs the review's sweep and Aave V3 credit on the fork and checks neither lifts Sam's percent.
- **Open:** trades are valued at Aave's price. A stock bought under it (a thin pool, a weekend's held price) reads as a gain until Aave's price follows, and shares moved out and back over a weekend are valued at the held price both ways. A member could still pass someone else's money through the same pool it trades on, in the same transaction, with a contract of its own in the batch.
- **Open:** the most credit in use between events runs slightly low: a repay takes off what it repaid with its premium, and interest between events isn't added. The effect is small.

## Send replaces Pay (Adrian, 2026-10-15)

"Replace pay by send, and let user send their assets out." This replaces, in D16 and the Leaderboard's navigation line, the Pay tab: the tabs are Home / Invest / Agents / Leaderboard / Send, in that order, the Agents button still the lime centre one.

- **The Send tab is `/send`.** Receive, the address and its QR, which the Pay tab was, stays at `/receive`: Send's header has a "Receive" link to it (its Back then returns to Send), and Home's Top up and the Cash sheet's Top up still open it. `/pay` redirects to `/send` (307). Receive lights the tab its Back returns to: Send when opened from Send's header, else Home (the Send tab means money going out).
- **One screen, NYM's SendSheet on Base only:** You send (Cash, or a stock's free shares, from the Trade sheet's picker, "Send from"), the dollars with MAX, To (a name or a 0x address), the summary (To, They get, Network fee · Paid from your cash), every move in small print (D7: the exact amount and the full address), one button ("Send $25.00", "Send Amazon") that opens JAW's sheet once. No confirm screen of ours. Then "Sent $25.00 to sam.justan.id" (a stock by its name: "Sent 0.0072 Amazon to …"), the transaction on Base, and Done.
- **What can be sent:** the cash, as one pot (D20): when the wallet can't be counted on for the amount and the network fee, the batch first withdraws from savings (`payFromCash`, as buys and repays do). Cash MAX is the cash less the $0.50 fee buffer. A stock sends only its free shares, never what backs credit: the card says "$X of it backs your credit." and a stock that all backs credit is listed and can't be picked. Stock MAX is every free share, exactly; typed dollars become shares at Aave's price, rounded down, and the card says how many ("That’s 0.0072 AMZN."). A stock send needs $0.50 of cash for the fee.
- **To:** "sam" means sam.justan.id; any other name (a .eth name, another JAW parent, 0xfoo.eth too) resolves through ENS's offchain lookup, its Base address first (`addressOfName`, as the Leaderboard's add by name). Only a lookup that says "no Base address" falls back to the Ethereum one; a lookup that fails stops there ("We couldn't look that up right now. Try again."). The address shows shortened under the name before anything is sent; an address with no name shows in full, in fours. A pasted address is taken at once. An address typed in shows its own name only when that name resolves back to it. Editing or clearing the field drops a lookup still running, so an earlier name can't come back as the recipient. Quick picks: Recent (who this device sent to, from Activity's own records) and the first 8 Contacts (the Leaderboard's EFP list); a pick sends to the address alone, and its name shows only once it resolves back to it (a name can point elsewhere since).
- **Guards.** Refused, in plain words: the account itself, the zero address, and any contract the app or its protocols use (`APP_CONTRACTS` in `lib/contracts.ts`: USDC, the stocks, savings and its debt token, the other dollars, Aave V4 and V3, the swap venues, JAW's permission manager, paymaster and fee treasury, the entry points, EFP, Multicall3, the executor and the board once set). Also refused: any other token or trading pool, which APP_CONTRACTS can't list (WETH, the venues' pools): a contract that answers a token's `decimals()` and `totalSupply()` or a pool's `token0()` and `token1()` ("That address is a contract that holds or trades money, not someone’s account."). A raw address must be checksum-valid, all lowercase or all capitals (EIP-55's forms without a checksum) ("This address has a typo in it."). Warned, not blocked: an address Base has never seen used (no code, no transaction sent, no ETH, no USDC: "This address hasn’t been used on Base yet. Check it’s right."), and one Base couldn't be asked about ("We couldn’t check this address on Base right now. Check it’s right."). The button waits for Base's answer, so the warning never lands after the tap. A stock transfer that Base refuses says it's about the address ("This stock can’t go to that address right now…").
- **The allowlist's one way out** (`transferOut` in `lib/allowlist.ts`): ERC-20 `transfer` on USDC and the seven stocks only, value 0, amount over 0, never to the user, the zero address or `APP_CONTRACTS`, and only in a batch whose builder declares who it pays (`assertAllowed(user, calls, { sendTo })`), to that address, once per batch. Every other batch has no transfer at all, as before. `transferFrom` stays out.
- **User-signed only.** No agent grant lists `transfer` or `transferFrom`; `lib/agents/permissions.ts` is unchanged, and `tests/unit/send.test.ts` checks every grant.
- **Activity and the Cash sheet say who** a send went to: the decoder keeps the recipient when one account got it all, and this device's record keeps the name.
- **Tests:** `tests/unit/send.test.ts` (the builder, the transfer rule, the recipient's parsing and guards, the screen's plan); `tests/onchain/send.test.ts` simulates on Base from the dev preview's account a $100 cash send that withdraws savings first (exactly $100 arrives) and a send of every free Amazon share (backing and what's owed don't move; one unit more reverts).

**Builder defaults, pending Adrian.** Chosen in the build, not by Adrian; each stays open until he settles it.

- **Other dollars (USDT, USDe, USDbC, USDS) can't be sent.** They become cash (D20); sending them would mean a coin picker and their own allowlist entries.
- **No smallest send.** Any amount over 0 (a stock to its smallest unit); the network fee can be most of a tiny send.
- **A name that only gives an Ethereum address** (not under justan.id) is refused when that address is a contract on Ethereum with no code on Base ("… is a wallet on Ethereum that isn’t on Base. Ask them for their Base address."), or when Ethereum or Base couldn't be asked; otherwise it's always warned ("This name only gives an Ethereum address. Send only if it’s the same account on Base."), a plain key too, since an exchange's deposit address is one (changed after the review, 2026-10-15; it first went through unwarned).
- **No weekend line on a stock send:** its dollars are only a label at Aave's held price; the shares sent are exact.
- **The Cash sheet has no Send button**; Send is its own tab.

## One tap to JAW's sheet (2026-10-15)

Measured on the iPhone Simulator (Safari, a real account on Base): "Buy Alphabet" said "You cancelled. Nothing was sent." JAW's own error was "Failed to open popup. Please allow popups for this site." On Safari JAW's sheet is a popup: Safari has no IntersectionObserver v2 and the app's host isn't on JAW's trusted-hosts list, so `@jaw.id/core`'s TransportRouter routes to the popup, and Safari lets `window.open` through only inside the tap's own activation. The write read the chain between the tap and `wallet_sendCalls` (the board, a fresh quote, the simulation), so the activation was gone. Sign-in worked because it calls JAW straight from the tap.

- **Every write is prepared before the tap** (`lib/tx/prepared.ts`, `useTx`). While a screen's inputs are valid and it's idle, its batch is built from fresh reads (the quote, the cash, the EFP list, balances), every builder runs the allowlist, `join()` is added when due, and the whole batch is simulated with `eth_simulateV1`. Again every 15 s while the inputs hold, and when the page comes back into view; never while signing, after a batch lands, or while the page is hidden.
- **The tap signs only a batch prepared for exactly the inputs on screen:** the same key (every input that shapes the batch: the account, amounts, legs, the stock, the quote, the credit plan, the risk tick), the same account, simulated OK, under 30 s old. `wallet_sendCalls` is then called before anything is awaited. New inputs drop the batch; a preparation that comes back after the inputs changed is thrown away.
- **"A fresh quote before signing" becomes "quotes refreshed continuously, at most 30 s old at the tap".** This replaces, in the Trade sheet, "Both quotes are read again right before JAW's sheet"; in D20's Turn into cash, "Balances and quotes are read again right before Face ID"; in the Leaderboard, "The list is read again right before JAW's sheet". The on-chain floors are unchanged and still bind at signing: 1% minimum out on buys, a sale's floor under Aave's price, 99.5% of face value for conversions, exact approvals, the 10-minute deadline. A quote that moved past the screen's floor while preparing stops it with the same words, and the screen reads the new amount.
- **The button says "Checking…" and waits** until the batch for the inputs on screen is ready: after typing, a new chip, a tick, or a quote that moved (measured: about 0.7 s). No new screen and no confirm of ours. A simulation that reverts keeps the button off and says why on its usual line, before the tap; Base not answering says so and the tap tries again.
- **Repay All repays what's owed when it's prepared** (the debt and the cash read then, plus the 0.05% buffer), so the interest that accrues every block doesn't make it a new batch each time the position re-reads.
- **Without a fresh batch** (none yet, or over 30 s old: back from the background) the tap builds and simulates first, as before; where JAW opens in its iframe that's fine. If JAW then can't open its popup, the batch is kept for those inputs alone and one plain line says "Tap again to open JAW."; the next tap opens JAW's sheet with it. Any change on screen discards it.
- **Agent grants and revokes** are built in the tap (pure, no reads) and JAW is called before anything is awaited. A change that takes more than one JAW sheet (Protect's Save with "Sells first" and a grant, Renew, Turn off for two grants, Turn off all) opens the first from the tap; on Safari the next one can't open on its own, so it says "1 of 2 went through. Tap again to open JAW." and the next tap goes on with the rest. A turn-off that stopped part way skips the grants it already revoked.
- **Where the inputs live in a child** (the earn step, Protect's and Rebalance's settings bodies, the "arrived" card), the child prepares into the write's store (`usePrepare(tx.prep, plan)`) and its tap signs the same plan.

**Builder defaults, pending Adrian.** The 30 s bound, the 15 s refresh and the 0.3 s settle before a new preparation were chosen in the build.

- **Open:** JAW's revoke reads the permission from JAW's relay before it opens its sheet (`@jaw.id/core` CrossPlatformSigner, `getPermissionFromRelay`), so on Safari a Turn off may still lose the tap's activation inside JAW. Not measured on Safari.
- **Open:** putting the app's host on JAW's trusted-hosts list (`keys.jaw.id/api/trusted-hosts`) would route Safari to JAW's iframe instead of the popup, and no tap would be lost at all, revokes and multi-sheet changes included. Per `trusted-hosts.js` that takes JAW's security review.
- **Open:** checked in desktop Chrome on the dev preview (`?as=`): each screen's button reads "Checking…" then its label, prepares again after an input change and every 15 s, and a tap goes to signing with no screen of ours (the preview never signs). Playwright's WebKit opens every popup, even with no tap, so it can't reproduce Safari's blocker; a real tap on the iPhone Simulator is still to do.

**From the review (2026-10-15).** Added after the section above; where they differ, this wins.

- **What Mobile Safari allows, measured in the review** (iPhone 17 Pro Simulator, iOS 26.5, Block Pop-ups on, a stub page and real taps). `window.open` still opened after microtasks, after one fetch of up to 3 s, after three 400 ms fetches in a row (same-origin and cross-origin), and after a fetch then `setTimeout(0)`. It was blocked, with Safari's Block/Allow prompt, with no tap, after a timer over 1 s (`setTimeout(1500)`, or a fetch then `setTimeout(1200)`), after a MessageChannel hop, and after a 12 s fetch. So the reads alone didn't lose the tap, as the cause above says: the old path most likely lost it to a timer over 1 s (viem's retry backoff on a 429, say), a MessageChannel hop, or more than about 10 s in all. The prepared path awaits nothing before JAW, so it keeps the tap either way. JAW's revoke makes one fetch to its relay before its sheet opens, so Turn off very likely keeps the tap too; still to check with JAW itself.
- **Send is prepared like every other write** (merged from Send replaces Pay): keyed by the account, the token, the recipient's address as resolved and the amount, so a name that resolves late can never be signed for. The batch reads the cash again and builds with `buildSendCalls`; the button says "Checking…" until it's ready.
- **Repay All is keyed by whether it covers what's owed.** When it does, the batch reads the debt and the cash then, as above; if the cash no longer covers it, it stops ("Your cash moved since you started…") and the screen reads again, so "Repaid all your credit" never repays less. When it doesn't ("All cash"), the key carries the dollars on screen to the cent and the batch repays exactly that amount, with the cash read again. This replaces "Repay All repays what's owed when it's prepared". A repay by selling is keyed the same way: by whether the sale's floor covers what's owed, not by what's owed.
- **A write that lands on the page stops every other prepared batch.** When any batch lands or fails on Base, nothing prepared before it may be signed, on any screen of the page: each prepares again at once. A batch whose sheet closed sleeps for 30 s and can wake only for the very same inputs, never after a write landed.
- **Words that can show before any tap:** "The price just moved. Check the new amount." and "We couldn’t check this with Base right now." They no longer ask to try again. This replaces "with the same words" above.
- **Protect's and Rebalance's settings:** after "Sells first" or the mix lands, the write goes back to idle, so a second Save in the same sheet is prepared too. A grant JAW couldn't open after it says "1 of 2 went through. Tap again to open JAW.". Grants revoked in the session are remembered on every screen, so a turn-off that stopped part way goes on from any of them and isn't counted twice.
- **Open:** Buy on the iPhone isn't confirmed end to end yet. It needs one real tap from Adrian's signed-in session: in Simulator Safari, tap Buy, check JAW's sheet opens, and cancel on JAW's sheet so nothing is sent.
- **Open:** Turn into cash prepares every 15 s while its card is on Home or Receive, even if it's never tapped. Production needs `NEXT_PUBLIC_BASE_RPC_URL` set: mainnet.base.org already answers 429.

## Top up and Repay are sheets, and every page has Back (Adrian, 2026-10-15)

"top up and repay should open a sheet not a full page, all pages should have the back button like portfolio page". This replaces, in "Send replaces Pay", "Receive … stays at `/receive`: Send's header has a "Receive" link to it (its Back then returns to Send), and Home's Top up and the Cash sheet's Top up still open it" and "Receive lights the tab its Back returns to".

- **Top up (Receive) and Repay are sheets over the page they open from,** with the content their pages had (`TopUpSheet`, "Add money"; `RepaySheet`, "Repay"). Every signed-in page can open them: `RequireAccount` mounts `MoneySheets`, and `useMoneySheets()` opens one. They open from Home's Top up and Repay, the Cash sheet's Top up and Repay, the Credit sheet's and the Credit page's Repay, Credit Buy's Repay links, the Trade sheet's and Send's Top up, Send's Receive, and Protect's heads-up card (Add cash, Repay). Opened from another sheet, that one slides out as this one slides in. Repay's "Add money" opens Top up in its place.
- **Repay's write is unchanged:** the same chips, All, cash rules and prepared batch (`repayPlan` through `useTx`), prepared only while its sheet is open. A landed repay closes the sheet with its toast, on the page it opened from (the page went Home). "Buy more with credit" goes to the Market at `/buy`, or, opened on a page whose Market is a sheet (Invest's Credit sheet, any Credit Buy), opens that Market in its place. "Turn into cash" in Top up prepares only while the sheet is open.
- **Old links:** `/receive` and `/repay` redirect (307) to `/home?topup` and `/home?repay`, and `/receive?from=send` to `/send?topup`. The sheet opens as the page loads, and the query that opened it is dropped, so a reload doesn't open it again.
- **Back on every page but Home,** Invest's chevron left of the 30px title (`TabHeader back="/home"`): Agents, Leaderboard, Send, Activity, Settings, Use credit, Free up shares and Credit. The centred "Credit" label header (`SubHeader`) is gone; Free up's Back goes Home, not to Invest.

**Builder defaults, pending Adrian.**

- **Top up's title is "Add money"** (the board's and the page's); the buttons that open it still say Top up, Add cash or Receive.
- **Top up and Repay have Close and no Back** when opened from another sheet: they end the hop (SheetShell's rule: Back for a step in a sequence, Close for a leaf).
- **Invest's header sits 4px lower than the others** (its page starts 12px under the status bar, the rest 8px), so its chevron does too. The paddings are left as they were.

## Earn with stocks saves in the same batch (Adrian, 2026-10-15)

"The user should be able to put stocks get cash in saving. Nothing else, at least in the sheet cash." This replaces, in "Cash sheet", the Earn with stocks lines "No new allowlist entry: the credit lands in the wallet and Save moves it", "earning on (no user-signed savings supply exists)", "With earning off the card says 'Start earning first…'" and "Capped at … what Save's next run moves in full today", with the smallest amount raised by Save's smallest save.

- **One user-signed batch, no agent:** put the chosen stock in use (exact approve to the spoke, supply, use as backing, as before), take the credit (same plan, caps and risk rules), then an exact approve of that credit to Aave V3's pool and `supply(USDC, credit, user, 0)`. The credit earns from the moment the batch lands, on the public link too. When the wallet can't be counted on for the network fee, a savings withdrawal of the shortfall goes first (`payFromCash`, as every spend from cash); the credit still goes in whole. Checked by `assertEarn` (`lib/earnWithStocks.ts`).
- **The allowlist's one savings supply** (`saveForUser`, `savingsApprove` in `lib/allowlist.ts`): Aave V3's `supply` only where asset is USDC, onBehalfOf is the user, the referral code is 0, the amount is over 0 and value is 0, once per batch, and only in a batch whose builder declares it saves for the user (`assertAllowed(user, calls, { saveTo: user })`; any other `saveTo` is refused). The USDC approve to the pool must equal that supply exactly, once. Only Earn with stocks' builder declares `saveTo`; Buy, Trade, Send, Credit Buy and every other batch refuse a savings supply as before. Agent grants (`lib/agents/permissions.ts`) are unchanged. *(Superseded in part by "Start earning moves the cash in the same tap (Adrian, 2026-10-15)": Start earning's builder declares it too.)*
- **Offered when** the stocks can back credit, new credit isn't paused, the cash covers the network fee, and what the cash earns is above what credit costs (as shown, in tenths). The cap is the credit's: 99.5% of the limit and the USDC available. The smallest amount is $1. "Start earning first", "starts earning in a moment", "Try again tomorrow" and the test deploy's $5 note are gone from this card. *(Superseded in part by "Act is the line (Adrian, 2026-10-15)" below: the cap is at health 1.12, not 99.5% of the limit.)*
- **The Cash sheet** keeps the cash, what's owed, Earn with stocks and the activity. No other way to put cash into savings by hand, anywhere. *(Superseded in part by "Start earning moves the cash in the same tap (Adrian, 2026-10-15)": Home's Start earning is the other way.)*
- **One row:** the receipt's savings supply for the user, by the user, beside the credit is one move, "Earn with stocks · +$X from credit, earning", in Activity and the Cash sheet (an `earn` item in `lib/activity/decode.ts`); its savings supply isn't money leaving. The step's words: "It starts earning right away." and, in the small print, "$X of credit comes to your cash and starts earning". The toast: "$X is in your cash, earning."
- **Tests:** `tests/unit/earn-with-stocks.test.ts` (the batch's order and amounts, the fee withdrawal, the offer without an agent), `tests/unit/allowlist.test.ts` (the rule and its refusals), `tests/unit/decode.test.ts` and `tests/unit/cash-activity.test.ts` (one row); `tests/onchain/earn.test.ts` simulates on Base with `eth_simulateV1`: the preview account's credit from what already backs it (savings +$25, wallet unchanged, debt +$25), an account that never backed credit (its Microsoft in use, savings +$5), the preview account with its wallet emptied (the $0.50 buffer comes out of savings first), and the batch's own logs read as one `earn` move.

**Open for Adrian.**

- **"Not earning yet" after it.** With no Save grant (the public link), the Cash card says "Not earning yet" and Home's says the same, even once Earn with stocks has put credit in savings, while the Earn with stocks card above says "Your cash earns 3.9%". The line follows the Save grant, not the savings balance. Changing that line is outside "nothing else", so it's left for his call.
- **The credit cap stopping before Act** (jl/credit-cap-act) wasn't on origin when this merged; Earn with stocks uses `planCredit`'s cap, so it picks that up once it lands there. *(Settled by "Act is the line (Adrian, 2026-10-15)" below: merged, Earn with stocks is at that cap.)*

## Act is the line (Adrian, 2026-10-15)

"watch is ok, it is act that is not, also the guardian should only act on act and not take decision and repays under watch"

Two halves, one record. **Taking credit and Free up** (below, branch `jl/credit-cap-act`). **Protect acts only in Act**, never in Watch (no decision, no repay, no sale under Watch) is the guardian half, built on `jl/protect-act-only`; when it lands it goes under this same heading as its own part, "### Protect", not as a second section with this title. Adrian's words are met once both have landed.

### Taking credit and Free up

It replaces, in D2 (`CLAUDE.md`, now marked there and named in its pointer to this file), "The app does not add its own borrow cap below Aave's. Max borrow and withdraw are whatever Aave allows." and, for taking credit and Free up, the confirmation for ending in Act; in "Credit Buy goes backing first", "at 99.5% of Aave's limit" and the D2 tick "when the plan ends in Watch or Act"; in "From the Credit Buy backing review", the tick asked again on a refresh into Act; in "Cash sheet", Earn with stocks' "99.5% of the credit limit (as /use-credit)" and "D2's tick for Watch or Act"; in "Earn with stocks saves in the same batch", "The cap is the credit's: 99.5% of the limit". Those bullets are marked superseded where they stand.

- **Every way of taking credit may end in Watch, never in Act.** Credit Buy, decision 1's "Use credit for the other $Y", Earn with stocks and /use-credit share one cap, `creditCap` in `lib/creditBuy.ts` on `combinedLoan`'s new `maxCredit`: the most credit that keeps the health factor at or above 1.12 (`CREDIT_CAP.minHf` in `config/risk.ts`, next to the bands: the Act line 1.10 plus 0.02), net of what's owed, within what can be lent, rounded down to the cent. It was 99.5% of Aave's limit, a health factor of about 1.005. Simulated on Base: $20 of NVIDIA put in use with the old MAX ($13.92) ended at 1.0059, in Act; with the cap ($12.49), at 1.1210, in Watch.
- **Why 0.02.** Health moves with the backing's price, so 1.12 to 1.10 is a 1.8% fall. Measured on the seven stocks' Chainlink feeds behind Aave's oracle (3,666 updates, 2026-08-05 to 2026-10-15): an update fires at about a 0.5% move; 99% of the falls between weekday updates were 0.80% or less, 99.9% were 1.10% or less. Two single updates fell more than 1.8%, both outside market hours (NVIDIA −1.87% on its earnings evening, Amazon −2.13% overnight); the worst reopening after a weekend was −1.39%. Interest adds about 0.03% of the debt a day at 10% a year. Each 0.01 of margin costs about 0.9% of the credit at the cap.
- **One number.** Invest's buying power, Credit Buy's step 1 pick and its "left to use", step 2's figure, step 3's "You can use up to", step 4's MAX, "Up to" and "Credit left", /use-credit's MAX, "Up to" and Credit limit, Earn with stocks' "Up to", and Home's "Available", the Credit sheet's "Credit available" and "Room", /credit's and the Repay sheet's "Credit available" (`availableUsd`, which was Aave's own limit less what's owed) are all this cap, so no figure promises more than MAX allows. Step 2's line gives the share as the collateral factor over 1.12 ("About 62% of the $X of NVIDIA you put in use", it said 70%), and "less what your credit already needs" when the credit is already under the line.
- **Ending in Act is blocked with one plain line, and no tick lets it through:** "That would put your credit in Act. Try a smaller amount." (`CREDIT_BLOCKED.act`; Free up: "That would put your credit in Act. Free up less, or repay some first."). Between the cap and the Act line the usual "That's more credit than your stocks can back right now." The batch's `limit.maxCreditRaw` is the cap, so `assertCreditBuy` refuses more credit too. `needsExtraConfirm` (`lib/risk/status.ts`) is now Watch only, and `endsInAct` names the block, so no screen can bring back a tick for Act.
- **Aave's own health is checked before JAW's sheet.** The screen plans on the position as last read (every 15 s) and a batch prepared up to 30 s before the tap, while Aave allows credit down to 1.0 and moves every collateral to its reserve's latest collateral factor on borrow and withdraw (`RefreshAllUserDynamicConfig`): every account still holds each reserve's first setting today (key 0), but after a cut, a plan at the cap would pass the screen as Watch and land in Act. So every batch that takes credit (Credit Buy, decision 1, Earn with stocks, /use-credit with credit) or frees backing (Free up) carries a health floor (`TxPlan.healthFloor`: `CREDIT_FLOOR`, `EARN_FLOOR`, `FREE_UP_FLOOR`, at `RISK.watchMin`). `checkPlan` (`lib/tx/prepared.ts`) adds `getUserAccountData` after the batch in its `eth_simulateV1`, and a health under 1.10 stops it with the same line as the screen's, before the tap and at the tap alike; the read is never signed. Without that read the batch isn't signed ("We couldn't check this with Base right now."). Putting stock in use with no credit has no floor: it only lifts the health. Simulated on Base: the old MAX's batch stops, the cap's goes ahead, and a Credit Buy planned on a stale reading (the old MAX shown as Watch) stops.
- **D2's tick stays for ending in Watch** ("I understand this puts my credit in Watch…"). The MAX itself ends in Watch, so it asks for the tick.
- **Already in Act: no more credit.** The cap is $0 while the credit is in Act, whatever new backing comes with it (`in-act`): "Your credit is in Act. Repay some to use more." (one wording for the block and for Credit Buy's step 1, which adds "You can still buy with cash." and no per-holding reasons). Earn with stocks isn't offered. Putting stock in use with no credit (/use-credit's Add backing) still goes ahead: it only lifts the health.
- **Free up stops at the same line.** Its MAX keeps the health at 1.12 (`freeUpCheck` in `lib/freeUp.ts`, `maxWithdrawUsd` at `CREDIT_CAP.minHf`), where it was 99.5% of Aave's limit. Simulated on Base from a position set up in the same simulation ($20 of NVIDIA at a health of 1.75): its MAX ends at 1.1201, the old MAX at 1.0039, and the app's check stops the old one. With something owed and the health already under 1.12, in Act or not, nothing can be freed and one line says so: "Your credit needs all of these shares. Repay some first to free them up." (it no longer shows "Free up less" under it). Repay is unchanged.
- **A repay by selling never pushes into Act.** It repays the sale's floor less the $0.50 fee buffer, so a small sale can repay less than its shares backed: one that would end in Act, lower than it started, is blocked ("That would put your credit in Act. Sell more, or repay from cash.", `planSell`'s `act`). Not on any screen yet (StockSheet and the Trade sheet sell free shares only).
- **/use-credit's meter** is Safe up to the Safe line, then Watch up to the cap; the "Aave limit" and its red part are gone. "Pick enough backing for $X" shows only when all the free stock would bring $X within the cap. Its checks are `loanCheck` in `lib/creditBuy.ts`.
- **Tests:** `tests/unit/credit-buy.test.ts` ("Act is the line": the cap across collateral factors, existing debt and several backings, health 1.12 at the cap to the cent; Act blocked even when ticked; Watch with the tick; in Act already; buying power = step 2 = step 3 = step 4's MAX and "Up to" = Home's Available; the leverage loop, Credit Buys backed by the stock the last one bought, converging at the cap for collateral factors of 50–78%, the health never under 1.12; Free up's MAX; `loanCheck`), `free-up.test.ts`, `prepared-tx.test.ts` (the health read after the batch: Act stops, the line itself and nothing owed pass, no read means no signature, a revert names its own call), `tx-keys.test.ts` (which plans carry a floor), `sell-flows.test.ts`, `status.test.ts`, `earn-with-stocks.test.ts`, `loan.test.ts`; on Base, `tests/onchain/credit-buy.test.ts` (the old MAX and the cap side by side; the app's check on /use-credit's and a stale Credit Buy's batches; two Credit Buys at MAX, the second backed by the NVIDIA the first bought: 1.1210 then 1.1203) and `tests/onchain/flows.test.ts` (Free up at the line, and the app's check). No contract changes: the executor never takes credit.

**Builder defaults, pending Adrian.** Chosen in the build, not by Adrian; each stays open until he settles it.

- **The margin is 0.02** (1.12). 1.13 would have covered every single update measured, for about 0.9% less credit.
- **In Act, credit is blocked even when new backing in the same batch would lift the account out of Act.** Adding backing first (/use-credit) and then taking credit works.
- **The on-chain floor is the Act line (1.10), not the cap (1.12).** A batch the screen planned at 1.12 still goes if the price moved less than 1.8% since; one that would land in Act never does. A batch the screen showed as Safe that lands in Watch goes without the Watch tick; not handled.

### Protect

This replaces, for Protect, D2's use of the Safe line as the trigger in Leo's Guardian (`docs/archive/guardian-poc.md`'s "Watch → repay to HF 1.65; Fri 14–20 ET → Weekend Shield"; its text is Leo's and stays, with a superseded marker, and `CLAUDE.md`'s pointer to this file names this part), plan item 1's sale lines (a heads-up below 1.25, at once below 1.10, back to 1.40), and Weekend Shield's repay. The bullets above marked as superseded by this section keep their meaning for their day.

- **Protect steps in only in Act** (health under 1.10, `RISK.watchMin`). In Safe and in Watch it does nothing: no repay, no heads-up, no sale, no weekend move. In Act it repays from cash first; it sells backing stock only if the cash can't bring the credit out of Act.
- **It brings the credit back to Watch, at 1.20, not to Safe** (`CASH_AGENT.targetHf`, `PROTECT_SELL.targetHf`: one target for a repay and a sale). Why 1.20: it leaves an 8% cushion (1 − 1.10/1.20) before the credit is back in Act, so a normal day's move doesn't set Protect off again on the next run; and it spends far less than reaching Safe: from 1.05 it repays an eighth of what's owed (12.5%) where Safe would take 30%, and the protect-panel sale (Tesla, NVIDIA and Apple behind $6,200 at 1.049) sells $1,839 of stock instead of $3,164 at the old 1.40, and keeps the Apple. Was 1.50 → 1.65 for a repay and 1.40 for a sale.
- **The sale's timing stays inside Act.** Below 1.10 on a weekday a heads-up (`SellHeadsUp`: the app's card and the phone notification), and the sale 30 minutes later if the credit is still in Act; deep in Act, below 1.05 (halfway to Aave's limit at 1.0), at once at the wider 3% floor. A heads-up whose credit is back out of Act is cleared and nothing is sold. A sale cut short (a run's six slices, a limit, the pool's window) goes on without a new heads-up only while the credit is still in Act. A run makes one move, Protect from cash first, so a sale comes only on a run where cash had nothing more to give and the credit is still in Act: cash that reaches 1.20 means no sale, and cash that leaves it in Watch short of 1.20 means no sale either.
- **Weekend Shield is a heads-up card only.** Before a freeze it repaid credit that a 15% drop would take into Act: credit that is outside Act by definition. The executor has no weekend move any more (`ProtectCase.WeekendShield` and the pre-freeze window are gone from the runs). While Protect runs, in the window before the next price freeze on the executor's own calendar (`nextFreeze`, read by `useNextFreeze`; the window is its `weekendWindow`, 6 hours: Friday 14:00 to the 20:00 New York freeze on a plain week, a holiday's eve too, and nothing while prices are already held, as on Good Friday), the Agents tab shows one card (`weekendHeadsUp` in `lib/guardian/plan.ts`, `beforeFreeze` in `lib/agents/next.ts`, on the executor's live stress numbers, which stay on-chain for it): "Prices pause at 8:00 PM. If stocks reopen 15% lower, your credit reaches Act." and "Repaying $X now keeps it in Watch. Protect does nothing before Act.", with Repay and Add cash. $X is the repay that leaves the stressed health at 1.20.
- **The bounds hold it on-chain.** Protect's trigger and Protect · sell's heads-up line are both pinned to the Act line, 1.10 (`CashRules.TRIGGER_HF`, `SellRules.HEADS_UP_HF`; they were 1.20–2.00 and 1.10–1.50). So no threshold change through the 7-day delay can make Protect act in Watch, leave part of Act without it, or put the sale's line above the cash line: a sale with cash still in savings, and the Rebalancer, whose gate is the trigger, trading in Act. The at-once line is 1.05 to 1.08 (was 1.02 up to the heads-up line), so no change can hold the at-once sale back past 1.05; both targets are 1.15 to 1.40 (were up to 2.50 and 2.00), never past Watch toward Safe. `CashRulesTest.test_the_bounds_sit_on_the_apps_bands` ties the pins and the targets' ceiling to `config/risk.ts`'s bands. The deploy defaults: 1.10 → 1.20 (repay), 1.10 / 1.05 → 1.20 (sale).
- **Not deployed.** The D13 test deploy (`0x778d632484499aE6Ad2480b2ff85C164C29eA71b`) still runs the old numbers and the old Weekend Shield, and its bounds can't take a 1.10 trigger. It is throwaway; the next deploy carries the Act-only defaults (`contracts/docs/DEPLOYMENTS.md`). Until then the app reads the live numbers from whichever executor is configured.
- **The Rebalancer waits only while the credit is in Act.** Its gate is Protect's trigger, so it now trades in Watch: it only touches free stock, so it can't move the credit's health. Its next line in Act: "Waits until your credit is out of Act" (was "Waits until your credit is Safe").
- **Words.** Protect's row: "Steps in only at Act". Its sheet and the Credit sheet's Protect row: "Steps in only if your credit reaches Act, and brings it back to Watch." Its never line: "Protect does nothing while your credit is Safe or in Watch. It never sells a stock that doesn't back your credit, and never sells on a weekend." Its next line in Watch: "Watch. Steps in only at Act". The heads-up card: "Your credit hit Act. Add $X, or Protect sells $Y at 3:42 PM." (only while the credit is in Act). The feed: "Credit reached Act. Asked you to repay or add more." ("Your cash couldn't bring it back to Watch."), moves end "Back to Watch." (or "Still in Act." for a sale cut short), a sale at once says "Your credit fell deep into Act", and switching Protect on reads "Protect is on. If your credit reaches Act, it repays from your cash, up to $X a day." Credit Buy's and Earn with stocks' risk lines: "If your credit reaches Act, Protect repays from your cash or sells a little X to bring it back to Watch." Protect's settings: "Repay from your cash · Only in Act, and always first." and "Most safety per dollar · Sells the least it takes to bring your credit back to Watch." Nowhere "keeps your credit Safe", and no borrow, loan, lock or protocol words.
- **From the build:** the pool cap counted each slice rounded up, so two sales into one pool in a window could pass it by a millionth of a dollar; `SellJob` now counts once per stock, as the rule budgets it, so it never passes. Leo's Guardian keeper (`lib/guardian/keeper.ts`) runs the same Act-only rule; its rehearsal (`scripts/guardian-e2e.ts`) now checks that Watch at 1.30 plans nothing and that Act at 1.05 is repaid back into Watch, and the keeper sends its repay with 30% more gas than estimated (a repay estimated at 460k ran out of gas when it landed a block later).
- **From the review (2026-10-15).** The first build bounded the trigger and the heads-up line at 1.05–1.10, which let a change leave 1.05–1.10 without Protect, or set the sale's line above the cash line; both are pinned now (above). Measured as well: on a weekday, a page of 32 accounts all in Act, selling on, with no pool able to fill, takes about 21.2M gas to check (`ExecutorWeekdayPageForkTest`), against 8.32M for the same page with prices held. It doesn't fit one check, but under Base's 10M limit the scan stops at `CHECK_RESERVE` without reverting and starts one account further on each pass, so the page is still covered, in about three passes. That was so before this change too.
- **Tests:** `tests/unit/guardian.test.ts` (nothing at 1.30, a repay at 1.05 back to 1.20, a sale only when the cash can't get there, the weekend card), `protect-sell.test.ts` (the timing inside Act), `agent-next` (the weekend card on the executor's calendar and window: a holiday's eve, Good Friday, a shorter window), `agent-list`, `agent-feed`, `agent-events`, `earn-with-stocks`; `contracts/test/CashRules.t.sol` and `SellRules.t.sol` (the same examples, fuzzing, the bounds and the bands they sit on), `GooseExecutor.t.sol` (the inverted pair refused at deploy and through the delay, the heads-up line moved either way, the at-once line under 1.05), the vectors regenerated (`npm run contracts:vectors`) within the new bounds, Protect's healths now from 0.80 through Watch into Safe (2.00); on a Base fork, `GooseExecutorFork.t.sol` (Watch at 1.30 moves nothing, weekday or Friday afternoon; 1.05 is repaid back to 1.20; no weekend repay outside Act), `ProtectSellFork.t.sol` (a heads-up at 1.08 then the sale; at once at 1.049, 1.04 and 1.01; cash that reaches Watch means no sale; cash short of it, then the sale; the pool cap leaves the bigger sale in Watch and sells no more), `RebalanceFork.t.sol` (waits in Act, trades in Watch).

**Open for Adrian.**

- **"Watch is ok" beyond Protect.** The tick is settled by "Taking credit and Free up" above (it stays for ending in Watch; `needsExtraConfirm` is Watch only). Still as they were: the "Stay under $X to be Safe" hints on /use-credit and Earn with stocks.
- **The Rebalancer now trades in Watch.** A side effect: its gate is Protect's trigger, so it waits only in Act. It only trades free stock, so the credit's health doesn't move; before, it waited until the credit was Safe. Keep, or give it its own gate.
- **The weekend card is the app's only.** It has no phone notification (the push service listens to the executor's `SellHeadsUp`, and the executor no longer moves or speaks before a weekend).
- **Builder defaults:** the at-once line at 1.05 (its floor too) and the 0.02 band it keeps under the heads-up line; the targets' range of 1.15 to 1.40. All wait on calibration (plan item 6). The trigger and the heads-up line are no longer defaults: they are the Act line.
- **A weekday page in Act with no pool able to fill** is covered in about three checks instead of one (above). If that's too slow, a smaller `PAGE_SIZE` for the next deploy (about 12 would fit one check), or reading each pool once per check instead of once per account.

## Repay is one choice: pay with (Adrian, 2026-10-15)

Adrian approved a much simpler Repay sheet: one idea, what you pay with. This replaces, in "Top up and Repay are sheets, and every page has Back", "Repay's write is unchanged: the same chips, All, cash rules…" and "'Buy more with credit' goes to the Market at `/buy`…"; and in "Manage moves into the sheets", Repay's settings button (the Credit sheet's stays).

- **One big number, "You owe $X"** (rounded up to the dollar, as on Home), with the status pill. The status bar, Cost, Credit available, "Buy more with credit" and the Protect gear are gone from Repay; they live on the Credit sheet. `MoneySheets` loses `repayWithMarket`, and Credit Buy its `onMarket`.
- **"Pay with", a choice list in Adrian's order** (`repaySources` in `lib/repay.ts`): the cash, then each stock held free, then each stock that backs the credit; within each group the one that can repay the most first. Each row says what it is ("$1,939.59 in your cash", "$32.67 free", "$2,513.15 backs your credit") and the status the amount on screen would land in (one "After" label heads the pills' column). A row is listed only if it can repay $1, or all of it when less is owed; a stock is judged with its pool up to 1% under Aave's price, so one that only just reaches $1 isn't offered and then quoted under it. The cash is the default when it can repay $1 after the $0.50 fee buffer; otherwise the first row. One small line under the list, only when a backing stock is on it: "Paying with cash or another stock keeps your backing, so it's the safest."
- **Cash** repays as before (`useRepayBatch`: savings first through `payFromCash`, exact approve, allowance back to 0 on a full repay).
- **A stock held free** is a new batch (`buildFreeRepayCalls` in `lib/sell.ts`): approve exactly the shares to the router → swap them to USDC for the user at the sale's floor (`sellMinOut`: the quote less 1%, never under Aave's price less 10%) → approve exactly the repay to the spoke → repay it for the user (→ allowance 0 on a full repay). The repay is exactly that floor (`freeRepayRaw`), less the $0.50 buffer when the cash can't pay the network fee (then the sale pays it, as `saleRepayRaw`), and never more than a full repay. It takes no repay amount: it computes it, and `assertSaleCoversRepay` (`lib/sell/covers.ts`) refuses any batch whose repay is more than the swap's `amountOutMinimum` (less the buffer when the sale pays the fee), whose approve to the spoke isn't exactly the repay, or whose repay comes before a sale into USDC for the user. What the sale brings above the floor stays as cash. Nothing comes out of backing. When the cash pays the fee it's read again and a savings withdrawal goes first if the wallet can't be counted on for it (as the Trade sheet's swap). The batch signs the screen's quote, once its pool is read again and still pays the screen's floor, so "You owe after" and the toast are exactly what it repays.
- **A stock that backs the credit** is the existing repay by selling (`planSell`'s "repay", `buildSaleCalls`): out of backing, sold, the floor less the $0.50 fee repaid, with its near-limit guard (`repaySaleMaxRaw`, now shared with the row's most) and its Act stop. Its fallback no longer names Aave ("the price or your credit may have moved").
- **One amount in dollars**, typed in the kit's AmountField (the numeric keyboard), All by default: all the spendable cash, or what selling every share the row can sell is sure to bring, never more than owed. $25 and $50 are quick picks that fill it, shown while under the most. Typing more than the row can pay or than is owed snaps back to the most, with one plain line under the picks ("That's everything you owe.", "That's the most your cash can repay.", "That's the most Microsoft can repay right now."). The smallest repay is $1 (or all of it). A stock shows the shares it sells under the amount ("Sells 0.0606 MSFT"): the shares whose floor brings the amount, sized from the quote for all the shares the row can sell (a smaller sale in the same pools gets at least that per share), a hair over it (0.01% and 10 units) for the quoter's rounding and a tick between the two quotes, at least a $1 sale, and 0.25% more on a full repay so a price tick still repays all of it.
- **Under it:** "You owe after $Y" (to the cent, rounded up) and "Network fee · Paid from your cash" (or "Paid from the sale"). A stock's sale has its small print (D7: every move, the floor, the repay; it may name the venue and Aave's price). One button, "Repay", opens JAW's sheet with one Face ID; a landed repay closes the sheet with "Repaid $X" (or "Repaid all your credit").
- **Nothing to pay with** (no row can repay $1): the owed card, one line ("Add money to your cash to repay.", or "You need $1.50 in your cash to repay: $0.50 of it stays for the network fee.") and "Add money", which opens Top up in this sheet's place. **Nothing owed:** only "You don't owe anything.", with no list, no amount and no button.
- **Tests:** `tests/unit/repay.test.ts` (the rows, their order and who's listed; the default; All and its caps, the quick picks, the clamp and its line; status after per row; `sharesForRepay`; the free and backing plans; the builder's calls, allowlist, and a repay over the sale's floor refused, also over 200 random quotes); `tests/onchain/repay.test.ts` simulates on Base with `eth_simulateV1` from the dev preview's account the rows, free Microsoft All (every free share sold, exactly the floor repaid, backing unchanged), $2 of it, the same with no cash (the sale pays the fee, $0.50 stays), a repay one unit over the floor refused, and $5 from backing NVIDIA through the sheet's planner.

**Builder defaults, pending Adrian.** Chosen in the build, not by Adrian; each stays open until he settles it.

- **A free stock repays the sale's floor, not the typed dollars.** Its shares are sized so the floor brings the amount, so it repays that amount or a few cents more ($2 typed repaid $2.0000 on Base); the extra is what the floor guarantees. Capping it at the typed amount would leave those cents as cash instead.
- **The safest line shows only when a backing stock is listed,** and the stocks within a group go by what they can repay.
- **"You owe after" is to the cent** (the big number stays rounded up to the dollar): at the dollar, $1 repaid of $3.00 read "$3".
- **A stock's sale keeps its small print** under the summary (D7), though the sheet is "one idea".
- **No D2 tick on Repay.** A repay from cash or a free stock only lowers what's owed; from backing it ends healthier except for a tiny sale, and `planSell` blocks ending lower in Act.

## Repay fits one screen, and $0.10 for the fee (Adrian, 2026-10-15)

Three changes Adrian approved. This replaces, in "Repay is one choice: pay with", "'Pay with', a choice list…" (the rows stay, behind one pill) and "One small line under the list"; the Credit sheet everywhere it's named above ("Manage moves into the sheets", "Credit Buy opens on what you can use", "Top up and Repay are sheets…", "Act is the line"); and each "$0.50" network-fee buffer in the records above, which now reads $0.10 ($1.10 where it was $1.50).

- **One screen.** Top to bottom: "You owe $X" with its status; "Pay with" and one pill naming the source (cash's "$" and "Cash", or the stock's logo and name, ▾), the Trade sheet's From picker (`AssetPicker`); the amount (typed, $25 · $50 · All); "You owe after" and the network fee; Repay. At 390×844 the sheet's scroll area is 522px for the cash case, with nothing to scroll. A stock's small print sits under the button and may run past the fold (by 11px for the preview account's NVIDIA).
- **The list** behind the pill has the same rows in the same order (`repaySources`): each row's mark, name, what it can pay and its status-after pill, under one "After" label. The "safest" line is its footer, shown only when a backing stock is listed. Picking a row closes the list and starts on All, as before. Escape and a tap on the dim close the list first, then the sheet (the Trade sheet's rule). The list is as wide as the content (`wide`), and when it has to scroll it stops halfway through a row (`peek`). Both are new optional props, so Trade and Send are unchanged.
- **One credit sheet: Repay's.** Home's Credit ⓘ and Invest's status pill open the Repay sheet; with nothing owed it says only "You don't owe anything.". The Credit sheet is removed (`CreditSheet`), with its status bar, cost, credit available, Buy more, Protect row and "Use credit for buying" switch. Protect stays on the Agents tab. With the switch gone, the Buy step always offers credit for what the cash can't pay. Its "Credit for buying is off. Switch it on in Credit." line pointed at a switch that no longer exists, so it's gone, and so is the setting (`useCreditForBuying`).
- **$0.10 network-fee buffer, app-wide** (`CASH.feeBufferUsd` in `config/risk.ts`). That's ten times the largest fee measured on Base mainnet ($0.0095, $0.007 and under a cent). At $0.50, an account with $1.36 of cash and $4 owed couldn't repay at all. Every figure and line that names the buffer reads it from there, so cash MAX is the cash less $0.10 (Trade, Send, Buy, Repay). Some lines now read: "You need $1.10 in your cash to repay: $0.10 of it stays for the network fee.", "Add $0.10 to your cash for the network fee first.", "Leave $0.10 for the network fee.", "You need at least $1.10 in your cash to buy." The smallest stock-to-stock trade when the sale pays the fee is $1.20 (it was $1.60). Oulina's account (cash $1.34, about $4 owed, in the preview) now opens on Cash, All $1.23.
- **A repay by selling can no longer end in Act at $0.10** ("Act is the line": "A repay by selling never pushes into Act"). From Watch, a sale of v dollars ends in Act only if v < 1.1 × buffer ÷ (1.1 × what the floor keeps − collateral factor). At $0.10 that's under about $0.30 at 70% and under $0.53 at worst (78%, pool at the 10% floor), so always under the $1 smallest sale. The stop stays in `planSell`.
- **Tests** compute from `CASH.feeBufferUsd`: repay, trade, send, credit-buy, earn-with-stocks, cash-activity and sell-flows. `repay.test.ts` adds the $1.36 / $4 case, which now repays $1.26 from cash. `sell-flows.test.ts` checks the Act stop with the buffer mocked at $0.50, and that the same $1.20 sale ends in Watch at today's buffer. On Base (`eth_simulateV1`), repay and send pass in full. Trade's and earn's newcomer cases fail, as do the credit-buy, flows and sell cases on accounts that no longer hold free NVIDIA. The base commit fails exactly the same set.

**Builder defaults, pending Adrian.**

- **The pill shows the name only, as approved.** So a stock held both free and as backing reads the same on the pill ("Microsoft" twice). The list, the fee row ("Paid from the sale") and the small print ("comes out of backing") tell them apart, and the pill's accessible name carries the row's line ("Pay with: Microsoft, $3.51 free").
- **The list opens under the pill,** capped to the room left on screen: about 3.5 rows on the preview account. It scrolls inside.
- **The `/credit` page stays.** Nothing in the app links to it now (the UI kit's page header points at `/repay`), but it still opens by URL.
- **The Cash sheet's line under what's owed** still says "Repay from your cash any time." when the cash is over the buffer, though Repay needs $1 over it.

## Start earning moves the cash in the same tap (Adrian, 2026-10-15)

"Start earning" moves the user's cash into savings in a batch the user signs, so cash earns without the Save agent, the public link included (no `NEXT_PUBLIC_GOOSE_EXECUTOR`), where before the card never showed and cash never earned. This replaces, in "Start earning once money is in", "Home's card shows once the account has $1 or more of cash and no Save grant" and the card's one Save grant; in D20, "With no executor configured, neither shows"; in "Earn with stocks saves in the same batch", "Only Earn with stocks' builder declares `saveTo`" and "No other way to put cash into savings by hand, anywhere". Those bullets are marked where they stand.

- **One user-signed batch** (`buildStartEarningCalls`, `lib/startEarning.ts`): an exact USDC approve to Aave V3's pool, then `supply(USDC, amount, user, 0)`, the amount being the wallet's USDC less the fee buffer (`CASH.feeBufferUsd`, read from config), which stays in the wallet for JAW's network fee. `assertStartEarning` refuses anything else (two calls, no value, the approve equal to the supply, for the user, referral 0). It goes through the allowlist's one savings rule (`saveForUser`, `savingsApprove`, `saveTo: user`), unchanged but for its comments; only Earn with stocks' and Start earning's builders declare `saveTo`, and a unit test reads the code to keep it so. The batch is prepared while the card shows, keyed by the account and the wallet USDC on screen (`startEarningPlan`, `useStartEarning` through `useTx`), so the tap opens JAW's sheet at once. No confirm screen of ours.
- **With an executor and no Save grant,** the same tap does the batch first, then JAW's own screen for the Save grant (`useGrantPermissions`, the Save template at its starting limit): a grant can't share a batch (D14). The button reads "Start earning" with "2 steps" under it. Where JAW's second sheet can't open by itself (Safari's popup rule), the card stays and says "1 of 2 went through. Tap again to open JAW."; the next tap opens the grant alone (`useAgentRun` counts the batch as the first of two, `prior`). Without an executor it's the batch alone, one step.
- **When it shows** (`startEarningShown` in `lib/cashSetup.ts`): the wallet's USDC, not savings, is at least $1 plus the fee buffer (`startEarningMinRaw`: $1.50 at today's $0.50 buffer, $1.10 at $0.10); with an executor only while the Save grant is off (not loading, starting or on); without one whenever that much sits idle. The faded Cash and Yield cards (board 2g) follow the same rule.
- **Words:** with nothing in savings, "Your $X arrived · Start earning X% on it."; beside savings that already earn, "$X isn't earning · Start earning X% on it.". $X is the wallet's USDC to the cent. Once the batch lands (and, with an executor, the grant): the toast "Your cash is earning X%", the card goes once Home reads the wallet again, the Cash and Yield cards stop being faded, and the Cash line reads "$X earning" (`earningLine`, on savings).
- **Activity:** the batch reads as one row, "Started earning · $X into savings", in Activity and the Cash sheet's activity (a `save` item in `lib/activity/decode.ts`: the user's own savings supply for itself with no credit beside it; `ownCashRow` in `lib/cashActivity.ts`), not as money leaving. The Save agent's sweeps still make no row in the Cash sheet.
- **Tests:** `tests/unit/start-earning.test.ts` (the builder: approve exact = supply, onBehalfOf the user, the buffer kept, the $1 minimum, the plan's key, refusals; the show rule with and without an executor, the thresholds, savings already present; the words and steps; the decoder and the Cash sheet's row; other flows can't carry the supply; only the two builders declare `saveTo`), `cash-setup.test.ts`, `agent-run.test.ts`; `tests/onchain/start-earning.test.ts` simulates on Base with `eth_simulateV1` from the dev preview's account (its idle $42.25: savings rise by the amount to 3 units, the wallet ends on exactly the buffer, the logs read as one `save`), the smallest wallet that qualifies, the app's own `checkPlan` path, one unit over the wallet reverting, and oulina's account against the rule.

**Builder defaults, pending Adrian.** Chosen in the build, not by Adrian; each stays open until he settles it.

- **"$X isn't earning" keeps the second line** "Start earning X% on it.", as "Your $X arrived" does, where the brief wrote "$X isn't earning · Start earning".
- **$X is the whole wallet,** buffer included ($42.24 on the card, $41.74 goes in); the buffer is there to pay the fee.
- **One toast, at the end:** with an executor it comes after the grant; if the grant stops, the card's line says "1 of 2 went through" and no toast is shown, though the cash already earns.
- **The pill reads "Confirming on Base…"** while the batch confirms, as every button does; for those seconds the card's words wrap beside it.

**Open for Adrian.**

- **oulina (`0xFf13…eE1F`, $1.34 in the wallet) doesn't qualify at today's $0.50 buffer** (the threshold is $1.50); she does once jl/repay-simple's $0.10 lands ($1.10).
- **An executor account with Save off and all its cash in savings** sees no card, so the Save grant isn't asked until new cash sits idle (the rule as asked).
- **The Cash sheet's lead still follows the Save grant** (`cashLead`: "Ready to spend." without "earning X% a year" on the public link, even once Start earning put the cash in savings); not changed, as it wasn't named. The Yield sheet already counts savings.


## Copy clean-up: no AI slop, never longer (Adrian, 2026-10-19)

The no-ai-slop pass on every on-screen string (report: ~/Marketing Claude/greedygoose-copy-slop-report-2026-10-19.md). Adrian: "as long as we are not making a copy longer i'm good to move forward". Every change keeps a string the same length or shorter.

- **No em dashes in copy.** A dash joining two sentences becomes a period ("Preview mode. Sign in to do this.", "You’d pay 1.2% over Aave’s price. The market for Apple is small."). A lone "—" for an empty value stays.
- **A colon is for labels and lists,** not for joining two sentences ("Too big for the market right now. You’d pay…"). "In one go: …" stays: it lists what the signature moves.
- **Top up is the one name for adding money.** This replaces, in "Top up and Repay are sheets", "Top up's title is 'Add money'": the sheet is titled Top up, Protect's heads-up button says Top up, and "Top up your cash to repay." replaces "Add money to your cash to repay."
- **Minimums read "Minimum X is $Y."** (buy, sale, trade, repay, amount).
- **No "savings" on screen:** Start earning's row reads "$X earning", and "Nothing earning yet, so nothing earned."
- **No "lend":** "Aave doesn’t have enough USDC right now."
- **Curly apostrophes everywhere,** including the eligibility attestation and the Agents feed.

**Not changed, and why.**

- **"Credit ready", "Credit available" and "Credit you can use" stay.** They are different numbers in the spec (Credit Buy's step 1 is the credit on what already backs it).
- **Trade and Repay keep "the stock’s price".** The Trade sheet's main screen names no protocol (see "the Trade sheet").
- **"Interest still accrues." and "Prices were off today" stay.** The clearer wording is longer.
- **"Finish in JAW" stays** until Adrian decides: the spec keeps JAW to the trust mark.

## 2026-10-19 · Protect's line and the runner switch

Adrian approved Protect's new rules and ten copy decisions on 2026-10-19, with the runner switch (`jl/runner-switch`). This replaces, in "Act is the line", the whole "### Protect" part (the trigger at the Act line, the target at 1.20, the heads-up and the 30-minute wait, the at-once line at 1.05 and the 1% / 3% floors, the Rebalancer's gate on Protect's trigger, its words), in "No confirm screens of ours, and limits that read as limits", Protect's "Limit $100 a day", its "Daily limit" card and its limit choices (the Rebalancer's stay), wherever a record above names a daily limit for Protect or its selling, and D3's "No alerts in the MVP" (`CLAUDE.md`, now marked there). Those records keep their meaning for their day.

**The rules.**

- **Protect does nothing above 1.03,** Protect's line (`CASH_AGENT.triggerHf`, pinned on-chain by `CashRules.TRIGGER_HF`): as late as is safe before Aave's line at 1.0, a 2.9% fall, where the feeds move in steps of about 0.5% and the largest single update measured was −2.13%.
- **Act (under 1.1) is a warning only:** a card on the Agents tab from a plain health check, and a push the runner sends (outside this repo). No move.
- **Below 1.03 Protect repays from cash back to 1.12;** if cash runs short it sells backing stock, also back to 1.12, at once: no heads-up, no wait. 1.12 is the line credit is capped at (`CREDIT_CAP.minHf`), so Protect puts the account back where it was allowed to be.
- **Once started, the rescue goes on,** above 1.03 too, until the credit is back at 1.12 (the executor's `rescueAt`; `planProtect`'s and `sellsNow`'s `rescuing`). A move that reaches the target, or leaves nothing owed, ends it (`EndRescue`, which moves no money).
- **Never sells while prices are held** (weekends and holidays, the executor's own calendar). The repay from cash still runs.
- **Sale floor: 3% under Aave's price,** every sale (`PROTECT_SELL.floorBps`). There is no 1% floor any more.
- **No amount limit,** as at DeFi Saver: Protect is limited by what it does, not by how much. No typed limit for Protect or its selling, no limit advice, no "Daily limit" field. The app grants Protect's and Protect · sell's spends at the executor's `CAP_MAX` (read from the executor, `capMaxRaw`; $5 on the test deploy, the largest uint160 on a deploy with `EXECUTOR_CAPS=none`). Each stock's sell limit is still twice the dollar amount at Aave's price (`stockLimitsRaw`), held to what the grant's terms can hold: 32 bits of 1e-4 share a stock. The Rebalancer keeps its one typed weekly limit. *(The last sentence is superseded by "2026-10-20 · Rebalance has no limit, like Protect".)*
- **The Rebalancer waits while the credit is in Act** (under 1.1, `RebalanceJob.ACT_HF`; the app's next line gates on `RISK.watchMin`), not down to Protect's line.

**The ten copy decisions** (as built):

1. **The 1.1 warning:** a card from a plain health check (`actWarning` in `lib/agents/next.ts`, `useActWarning`): credit owing, health under 1.1 and at or over 1.03, Protect on or off, with Top up and Repay. "Your credit is in Act." and "Protect steps in at 1.03. Repaying $X now brings it back to Watch." ("Protect is off. Repaying $X now brings it back to Watch." while it's off). $X is the repay back to 1.12, in whole dollars, rounded up. It replaces the heads-up card (`useHeadsUp`, the executor's `SellHeadsUp` and `headsUpAt`). The push is the runner's.
2. **Between 1.1 and 1.03,** Protect's next line: "Act. Protect steps in at 1.03" (in Watch, "Watch. Protect steps in at 1.03"). Protect's row: "Steps in under 1.03". Its rule: "Steps in only if your credit falls under 1.03, and brings it back to 1.12." Its never line: "Protect does nothing until your credit falls under 1.03. It never sells a stock that doesn’t back your credit, and never sells on a weekend."
3. **The weekend card stays,** warning about Aave's line: "Prices pause at 8:00 PM. If stocks reopen 15% lower, Aave can sell part of them." and "Repaying $X now keeps your credit over Aave’s line." ($X from `weekendHeadsUp`, now against 1.0). "Protect does nothing before Act" is gone.
4. **Sales on weekends: still never** ("never sells on a weekend" stays in the never line).
5. **Sale floor: 3% under Aave's price,** with no 1% vs 3% anywhere.
6. **Sell order** (Most safety per dollar / Keep my mix): as it was.
7. **The Rebalancer's pause stays at 1.1:** "Waits until your credit is out of Act", gated on `RISK.watchMin`.
8. **"My credit status"** (`CreditStatusSheet`): the Act row reads "A warning. Protect steps in at 1.03.", and a new row under it, in the same style with Act's pill: "Under 1.03 · Protect repays from your cash, then sells if needed."
9. **Credit Buy's risk line** says Protect sells only while its selling is on, as Earn with stocks' does: "If your credit falls under 1.03, Protect repays from your cash, then sells a little X to bring it back to Watch." or "…Protect repays from your cash. Protect won’t sell your stock." Earn with stocks: "If your credit falls under 1.03, Protect repays from it, then sells a little X…" / "…Protect repays from it. Protect won’t sell your stock."
10. **No limit in code:** JAW spends at `CAP_MAX`; "Used today" and "Today’s limit is used" are gone for Protect and selling; the row chip, the settings' "Daily limit" card and "up to $X a day" are gone. The Rebalancer keeps its limit, so the shared words are now its own: the Agents footer "Rebalance’s limit is signed with Face ID." (or "You approve each agent with Face ID."), the limit's line "Rebalance never moves more than this in a week.", and SPEC's "one typed amount, a week". *(Superseded in part by "2026-10-20 · Rebalance has no limit, like Protect": the limit's line and SPEC's "one typed amount, a week" are gone. The footer's "Rebalance’s limit is signed with Face ID." goes when the overview is rebuilt.)*

**Other words.** Protect's settings: "Repay from your cash · Only under 1.03, and always first. Your cash pays before any stock is sold." and "Sell stock if cash isn’t enough · Only stock that backs your credit". Saving lists "Repay from your cash: on", "Selling: on", "Never sell: …". The feed: "Protect is on. If your credit falls under 1.03, it repays from your cash." and "Protect can sell backing stock."; a repay's or a sale's "Why" is "Your credit fell under 1.03." or, for a rescue going on above the line, "Protect went on until 1.12."; "Back to Watch." stays (1.12 is in Watch). With no cash, the next line is "Next: sells backing stock to repay" when selling is on, "Act. Sells backing stock when prices reopen" while prices are held, "Act. No cash to repay with" when it's off. A used-up limit can only be a capped test deploy's: "Act. Repays on its next run".

**The contract changed** (GooseExecutor, a new deploy and a new grant for every user):

- **The rescue:** `Account.rescueAt` (was `headsUpAt`) is when a rescue started; while it lasts Protect acts below the target, not only below its line. Action `EndRescue` clears it (bookkeeping, no money). `HeadsUp`, `ClearHeadsUp`, `SellHeadsUp`, `SellHeadsUpCleared` and `ProtectSold`'s `atOnce` are gone; `SellLimits` is `{floorBps, poolCap, maxSlice}`.
- **The overshoot check:** a Protect move that leaves credit owing may not land above the target plus 0.01 (`CashRules.OVERSHOOT_HF`, `Overshoot()`), so having no amount limit never means an oversized move.
- **The Protect list:** `protectMembers` / `protectMemberCount` and `checkProtect(shard, shards)`, the same check as `checkUpkeep` over the accounts with Protect on: what a runner scans on each stock price update.
- **Registration:** `registerApproved(permission)` takes the permission exactly as JAW's manager approved it (a runner passes the `PermissionApproved` event's data), and `registrationOf(permission)` says first, as a view, whether it would take it. Chainlink Automation's log trigger (`checkLog`) and the `Mode` wrapper are gone: `performUpkeep` takes `abi.encode(address[])`.
- **GooseReceiver:** where Chainlink CRE delivers the runner's reports (Base's KeystoneForwarder → `onReport`), one of the executor's forwarders, allowed exactly two calls: a run (`performUpkeep`) or a registration (`registerApproved`).
- **The Rebalancer's gate** is its own Act line (`RebalanceJob.ACT_HF`, 1.1), no longer Protect's trigger.

**In this repo:** `lib/agents/events.ts` reads no heads-up and no `atOnce` (and no `reason`: only Act repays); `useAgentSettings` reads `rescueAt` (`rescuing`) and no sell limits; `useAgentFeed` keeps no heads-up; `lib/agents/permissions.ts` has `NO_LIMIT_JOBS`, `hasLimit` and `startCapRaw` (CAP_MAX for Protect's two jobs) and `LIMIT_USD` for Save, Entry and the Rebalancer only; `lib/agents/protect.ts` has no limit to choose (`ProtectSaved.repayOn`); the rehearsal's `run-agents.ts` registers through `registrationOf` and `registerApproved` and decodes the plain address list; `prove.ts`'s shock step drops sam to about 1.02 and checks Protect's repay.

**Tests:** `agent-list`, `agent-next` (the new lines, the rescue, no cash with and without selling and while prices are held, the Act warning, the weekend card against Aave's line, the Rebalancer at 1.077, `EndRescue` saying nothing), `agent-feed`, `agent-events`, `protect-settings` (grants at CAP_MAX, the 32-bit clamp on a deploy with no amount limit), `agents` (the limit parts), `earn-with-stocks`, `cash-activity`. `protect-rules`, `protect-sell`, the vectors and the contract tests are the lead's.

**Open for Adrian.**

- **Under 1.03 with Protect off there is no card:** the warning shows from 1.1 down to 1.03 as decided, Protect on or off; below 1.03 with Protect off nothing on the Agents tab says so (Home's status still reads Act).
- **"Watch: Nothing is sold."** on the status sheet: a rescue that started under 1.03 can sell between 1.10 and 1.12, in Watch, on its way back to 1.12.
- **The weekend card shows only while Protect runs,** as Weekend Shield did; with Protect off, nobody acts, yet no card.

## 2026-10-20 · The app registers each grant (runner switch, option 1)

Adrian (2026-10-20, "ok tell him go"): KeeperHub's free tier can't watch the manager's `PermissionApproved` events, so no runner registers a grant. The app does it, from the user's own account, right after each JAW grant: one more Face ID when an agent is switched on.

- **Right after the grant:** `useAgents.turnOn` reads JAW's grant response (`listedFromGrant` → `readAgentGrant`), rebuilds the exact on-chain permission with the job's own builder (`grantPermission`) and sends `registerApproved(abi.encode(permission))` on JAW's sheet (`lib/agents/register.ts`), checked and simulated first like every write (the allowlist's `registersOwnGrant`: the permission's account is the user and its spender the executor). It waits for Base and reads the registry again.
- **Trying again never grants twice:** a job granted on the same terms and only waiting for its registration (a sheet JAW couldn't open on Safari, one cancelled) is registered alone; a sheet JAW couldn't open keeps its checked batch for 30 s, and the next tap sends it before anything is awaited.
- **Every count says it:** a grant is two JAW sheets (`GRANT_SHEETS`): Start earning's "3 steps", Protect's and Rebalance's step notes, and "1 of 3 went through" after a stop (`RegisterStopped` counts a grant that landed when only its registration didn't).
- **The Finish card** (Agents tab, after the warnings): any job JAW granted that the executor doesn't run yet (status "starting"), with one Finish button that registers them all in one sheet, prepared in the background (useTx with `useAgents.finishPlan`). "Protect isn’t running yet." / "One more Face ID finishes turning it on." Earning and Turning other dollars into cash are named there too: a grant of theirs left unregistered has nowhere else to finish.
- **Proof:** `test_templates_hash_like_the_apps_builder` (fork) checks the app's registration bytes for each kind equal abi.encode of the executor's own template (`permissions.json` `registrations`); `tests/unit/register.test.ts` covers the bytes, the allowlist, the plan's key and the counts.

**Open for Adrian.** Home's "Ready to spend. It starts earning in a moment." still shows for a Save grant waiting on its registration; the Finish card is on the Agents tab only.

## 2026-10-20 · One batch per change: settings ride with the registrations

Adrian (2026-10-20, "Batch those into one"): a change's registry settings and its grants' registrations go in one JAW sheet. This supersedes, in the entry above, "registered alone" and "a grant is two JAW sheets (`GRANT_SHEETS`)… (`RegisterStopped`…)".

- **The order:** each grant (and revoke) on JAW's own sheet, then one atomic batch with the change's settings (`setMix`, `setKeepMix`) followed by one `registerApproved` per job it granted (`useAgents.grantJob` + `registerJobs`, `buildRegisterCalls(user, permissions, settings)`). A sheet per grant plus one (`changeSheets`): Rebalance with a new grant and a mix change is 2 (was 3), Protect switching on with selling and "Sells first" is 3 (was 5), Start earning stays 3. A settings-only save is still its own prepared batch.
- **What a batch registers:** only the grants of its own change, or of this sheet's change whose batch didn't go through (`registering`); a grant left from anywhere else is the Finish card's, so it can never block an unrelated save. The Finish card sends the settings the stopped batch carried, unless a later save set them alone (`forgetSettings`). A reload forgets those settings: Finish then registers alone.
- **After it lands:** every read on the page is fetched again, as useTx does, so the sheet shows the new mix and "Sells first" at once.
- **Words:** a stop the app explains (its simulation's reason, a batch that failed on Base) is said as it is (`AgentStop`); a cancelled batch says "You cancelled. Nothing changed."; progress counts a revoke once per sell grant, as the button does.
- **Proof:** `register.test.ts` (settings first, then registrations; plan keyed by settings; counts), `protect-settings.test.ts` (`withRegistration`), `rebalance-settings.test.ts` (`rebalanceSteps`: what Save runs is what it counts). An adversarial review (3 lenses, each finding verified) found 13 issues in the first cut, fixed here. Two limits stay: a settings change between a blocked batch and the next tap needs one more "Tap again" on Safari (the kept batch is for the same settings), and ProtectSettings' Save state has no component test (its parts, `withRegistration` and `stepCount`, do).

## 2026-10-20 · Rebalance has no limit, like Protect

Adrian (2026-10-20): no weekly cap on the Rebalancer. Like Protect, it is limited by its rules, not by an amount. This replaces, in "From the Rebalancer and Entry build", its weekly USDC limit (:59); in "From the Manage build", its stock limits at twice a chosen limit and the fresh week at it (:97, :101); in "From the Agents redesign: the frame", its limit on the row, in `LIMIT_USD` and at Renew (:116, :118, :121); in "No confirm screens of ours, and limits that read as limits", its "Limit $X a week", its "Weekly limit" card and its limit choices (:160-161); and in "2026-10-19 · Protect's line and the runner switch", "The Rebalancer keeps its one typed weekly limit" and decision 10's Rebalance words (:515, :529). Those bullets are marked where they stand and keep their meaning for their day.

**The rules.**

- **No amount limit, Protect's way.** The Rebalancer's grant carries the executor's `CAP_MAX` on its USDC spend (read from the executor, `capMaxRaw`), with no field to type. Each stock it may sell keeps its own limit (`stockLimitsRaw`), which on a deploy with no amount limit sits at what the grant's terms hold: 32 bits of 1e-4 share a stock.
- **Its rules are the limit:** once a market day, only a stock past its band, partway back, each swap within the executor's largest slice and at Aave's price less 0.5% or better; it waits while the credit is in Act.
- **The template doesn't change.** The spends stay `PeriodUnit.Week`, so every template hash, the vectors and the contracts are as they were. No contract change.
- **Old capped grants:** a Rebalancer grant below `CAP_MAX` is from before this, and the next Save grants it again at `CAP_MAX` (Save shows "2 steps", even with the mix unchanged). Renew grants at `CAP_MAX` too.

**In this repo:** `lib/agents/permissions.ts` has `rebalance` in `NO_LIMIT_JOBS`, `LIMIT_USD` for Save and Entry only, and no `parseLimitUsd`, `MAX_LIMIT_USD` or `testCapNote`; `components/gg/kit/LimitField.tsx` is gone; the Rebalance sheet has no "Weekly limit" card, and its preview and grant use `capMaxRaw` (`rebalanceSave` takes no limit); the feed's switch line is "Rebalance is on." and a rebalance row has no "Used this week" (`limitOf` and the period read in `lib/agents/history.ts` are gone); no agent row carries a limit; the guide says "You set Rebalance’s mix."

**Tests:** `agents` (Rebalance in `NO_LIMIT_JOBS`, a new grant at `CAP_MAX` with each stock at the clamp), `rebalance-settings` (a capped grant from before needs a new grant at `CAP_MAX`), `agent-feed`, `agent-list`, `agent-next`, `manage`, `rebalance`.

**Left for the overview's rebuild** (another session owns `app/agents/page.tsx` and `components/gg/Agents.tsx`): the footer still says "Rebalance’s limit is signed with Face ID." once a Rebalancer grant exists, and the page's `switchCap` and `renewCapRaw` still read `limitUsd` and `hasLimit` (both now give `CAP_MAX` for the Rebalancer). `AgentItem.limit` and `limitUsd` stay, always null, until the page stops reading them.

## 2026-10-20 · Top-ups go into my mix (to build)

Adrian approved top-ups going into the mix on 2026-10-20, and took the builder's defaults for P1 to P7 the same day (the build plan for Rebalance's top-ups, milestones M1 to M5). Nothing in this section is built yet: SPEC's two top-ups bullets say "(to build)" until the new executor (M4) and the app's wiring (M5) land, and the proof is added here then. *(Superseded by "2026-10-20 · Top-ups wired in the app (M5)": built, with the proof there; P2 is still to build.)*

**The rules.**

- **A Rebalance setting,** off by default: Top-ups go into my mix, with Keep $X as cash ($500 by default, whole dollars, $0 allowed, at most $1,000,000 in the app).
- **What a top-up is:** money from outside, USDC sent to the account and other dollar coins turned into cash. A sale's proceeds and credit taken as cash are not: they go into savings inside the user's own batch.
- **Keep $X first:** a top-up fills cash up to Keep $X, and only the part above goes into the mix. It goes in at the next market morning's check, never the day it arrived, and earns until then. On a day it invests, band trades wait for the next market day.
- **Buys only:** the stock furthest below its target first, then pro rata to the mix. No amount cap. It waits while the credit is in Act and invests only at health 1.1 or above.
- **It takes both:** the account's own `setTopUps(on)` and the grant's top-ups flag. Anyone can register a grant, so the grant alone never turns it on.
- **Counts from before the registered grant's start day are dropped:** that money stays cash.

**Adrian's answers (2026-10-20): the defaults taken.**

- **P1. The agents' own change is left out exactly:** the executor keeps an own-cash count written by Rebalance, Protect and Sell. The change from the user's own sales (about 1%) counts as a top-up.
- **P2. Save has no amount limit either:** its grant moves to `CAP_MAX`, like Protect's and Rebalance's. Everyone grants again for the new executor anyway.
- **P3. Turning top-ups on also turns on earning** (the Save grant), in the same single signature, since only Save counts top-ups. If one signature isn't available, the switch is greyed with "Turn on earning first."
- **P4. The stricter rule:** a fall in cash after a top-up is counted comes out of the waiting top-up first. Rises never add to it, so Protect's repays shrink it on their own.
- **P5** (the overview's layout, attention cards, "Turn off all agents") is the overview session's (`jl/agents-overview`).
- **P6. The Rebalance sheet keeps only my mix and the top-ups setting:** "Its next trades", "When it runs", "What it did" and the shield "never" line leave the sheet. Activity stays on the overview.
- **P7. Turning top-ups off doesn't revoke the grant it replaces:** the executor only runs the newest registered grant, and the old one goes with "Turn off Rebalance", as every replaced grant does.

**Builder defaults, pending Adrian (copy).** The switch until the new executor is live: "Not available yet." The sheet's button while Rebalance is off: "Turn on · 2 steps". The never line with top-ups on: "Rebalance never touches the stocks backing your credit." The feed row: "Put $300 of top-ups into your mix." The card while agents aren't live: the pill "Coming soon".

## 2026-10-20 · One signature per change: D14 dropped

Adrian (2026-10-20): "drop D14 and do the permission, the cash move and the registration in one signature like Leo's Guardian, with a clear line on our card and the permission recorded in JAW's list. Prove it on a fork first." The fork proof passed (contracts/test/OneTapGrantFork.t.sol, 13/13, and the app's own bytes match JAW SDK 1.6.3's `grantPermissions` for all five jobs). This supersedes D14 (:14), "D14 consequences" (:41-44), "Saving a tab is at most two Face IDs" (:96), Start earning's "2 steps" (:464), "The app registers each grant" (:552) and "One batch per change" (:564), each for what it says about grants; those entries keep their meaning for their day.

- **One batch per change, one Face ID** (useAgents `changePlan`, lib/tx/plans/agents.ts `agentChangePlan`), through the one write path (useTx), prepared while its sheet shows so the tap opens JAW's sheet at once: what goes first (Start earning's supply), each grant it takes back (`manager.revoke`), `addOwnerAddress(manager)` when the manager doesn't own the account, each new grant's `manager.approve`, the registry settings (`setMix`, `setKeepMix`), then each new grant's `registerApproved`. Atomic: a batch that doesn't land changes nothing, so the "starting" grants, the stopped settings and the Finish card of the two-step flow no longer arise (Finish stays for grants made on JAW's sheet before today).
- **Turning off is the app's own batch too:** `manager.revoke` of every live grant of the job, in one Face ID, never JAW's revoke sheet (JAW revokes by the relay's record, which anyone with the app's public key can write). A new grant revokes the one it replaces in the same batch, so nothing old stays approved for anyone to register once the job is off.
- **Recorded in JAW's list** after the batch lands, as JAW's own grant records it (the same POST to its relay, under the permission's id read off the receipt), and taken out after a revoke (the same DELETE). A record that didn't save is never fixed by sending the batch again (on Start earning that would move the money twice): any screen puts it back from the registry's own copy (catch-up), never one revoked on that page, and only after Base reads it as approved and not revoked.
- **Whether an agent runs is read on Base:** registered in the executor, not past its end, not revoked in the manager, and the manager still an owner of the account. JAW's list only counts a record whose id is the manager's hash of it and that the manager has approved and not revoked.
- **The allowlist** holds what JAW's batch sheet doesn't show: `manager.approve` only for the user's own grant to GooseExecutor, exactly one job's template, a year long from a start no later than now, each registered later in the same batch, one a job; `manager.revoke` only for the user's own agent grants; `addOwnerAddress` only on the user's account, only for the manager, once, before an approve.
- **Starts and salts** are picked once per account, job and terms (lib/agents/picks.ts), five minutes behind the device's clock and always after the grant the executor holds (no StaleGrant, no equal-start swap). Stock limits follow Aave's prices held steady within half a percent (`useSteadyPrices`), so a prepared batch isn't rebuilt on every price read.
- **The clear line:** each card says what its Face ID allows before the tap. Protect: "Protect can repay from your cash if your credit falls under 1.03, for a year. You can turn it off here." and, with selling, "If cash isn't enough, it can also sell stock that backs your credit, never Tesla." Rebalance: "Rebalance can trade your stocks toward your mix, for a year. It never spends your cash. You can turn it off here." (with top-ups on, it names them instead). Start earning: "New cash that arrives moves into savings on its own, up to $1,000 a day." *(Without "up to $1,000 a day" since Save has no limit: "2026-10-20 · Top-ups polish, and Save with no limit (P2)".)* Convert automatically: "…up to $1,000 a day, at 99.5% of face value or better." (Copy to confirm with Adrian.)
- **One exception, two Face IDs:** an account JAW hasn't deployed yet (money arrived, nothing ever signed) can't have an agent registration simulated: the executor checks the account's code, which JAW's factory puts there inside the same user operation. Every batch is simulated before it's signed, so on that account's first Start earning the supply goes first and earning's grant right after ("2 steps"). Doing it in one would mean signing a registration nobody simulated; that's Adrian's call. *(Adrian chose one: "One Face ID for a never-used account too", below.)*
- **Still to see on a real phone:** that JAW's batch sheet accepts `manager.approve`, `manager.revoke` and `addOwnerAddress`; that the relay takes the app's POST and DELETE from the app's origin; that JAW's list then shows the grant; fee sponsorship.

## 2026-10-20 · Rebalance's new sheet in one signature (merge of jl/agent-one-tap)

"One signature per change: D14 dropped" (above) now covers Rebalance's new sheet from "Top-ups go into my mix" (above). It supersedes, in that section, P7 and the builder default "Turn on · 2 steps", each for what it says about grants; those entries keep their meaning for their day.

- **Save is one batch, one Face ID** (`rebalanceSave`, useManageSave `planFor`, prepared in render): the settings that changed and a new grant when one is needed. Save and Turn on carry no "2 steps", and Turn off Rebalance has no steps line.
- **Turning top-ups off revokes the grant it replaces in the same batch,** as every new grant does (useAgents `changePlan`). P7 left it for Turn off only because a revoke took another JAW sheet. Adrian to confirm.
- **The allows line** (`rebalanceAllows`, `SavePlan.allows`) stands above Save only while Save grants, and not while Keep as cash is empty.
- **Still for M5:** `setTopUps` in Save's batch (useManageSave), the grant's top-ups flag through `changePlan` and Renew (useAgents, the Agents page), and the Agents page rendering `RebalanceSheet` for Rebalance. Until then the switch says "Not available yet." *(Done: "2026-10-20 · Top-ups wired in the app (M5)".)*

## 2026-10-20 · Top-ups wired in the app (M5)

"Top-ups go into my mix" (above) is built end to end on `jl/rebalance-topups`, for the next executor (contracts/docs/DEPLOYMENTS.md, "The next deploy carries top-ups into the mix"). Nothing is deployed; the executor live today keeps working, and its switch says "Not available yet."

- **One signature turns them on (P3 as updated):** Save on Rebalance's sheet sends one batch, [earning's grant when earning is off, the Rebalancer's grant with the savings withdraw and aUSDC's limit, `setMix` when the mix changed, `setTopUps(true, Keep)`, a registration for each grant], with any grant it replaces revoked (`rebalanceChange`, useManageSave `planFor`, useAgents `changePlan`). Earning rides in any batch whose Rebalancer grant carries top-ups while earning is off (turning them on, or a new grant with them on), since only Save counts top-ups; the allows line then adds Start earning's own words. "Turn on earning first." stays in the card's model for a batch that can't carry earning; none of today's can't, so it doesn't show. While earning's state is still loading, the batch waits.
- **Keep alone is the setting only:** `setTopUps(true, Keep)` in a batch with no approve and no grant. Switching top-ups off is a new Rebalancer grant without the withdraw, the old one revoked in the same batch (as decided in "Rebalance's new sheet in one signature"), with `setTopUps(false, Keep)`.
- **Turn off Rebalance switches top-ups off too,** in its one batch: every live grant revoked and `setTopUps(false, Keep)`, so nothing is left counting for a Rebalancer that's gone. Renew keeps the grant's shape (with or without the withdraw).
- **The allowlist** takes `setTopUps` on GooseExecutor only, with a switch, Keep from $0 to $1,000,000 in USDC units and no value; it rides in a batch with or without grants.
- **Read on Base** (`topUps(account)` with `allowFailure`, `readTopUps`): a revert means the executor doesn't count top-ups ("Not available yet."); otherwise the switch, Keep, and what waits with when it goes in, worked out the executor's way (`waitingRaw`: today's count rolls once its New York day is over, a fall since the count comes out of it, never more than savings above Keep), at the next check for what's ready and the next market day's after today for today's count.
- **Grants in both shapes:** a Rebalancer grant with top-ups carries aUSDC's limit right after USDC's (`carriesTopUps`), so its stock limits start one later; JAW's list, the registry and the allowlist read both, and a Protect · sell grant never reads as one, nor the reverse.
- **Words (copy, pending Adrian):** the feed says "Put $300 of top-ups into your mix." (Why: "Top-ups above what you keep as cash go into your mix.", Bought, My cash "$300 used"), "Top-ups above $500 go into your mix.", "Every top-up goes into your mix." and "Top-ups stay in your cash."; a count makes no row (its arrival already has one). The Cash sheet's activity shows "Top-ups went into your mix" as cash out. The Guide's Rebalance lines stay as they are: still true, and a copy edit never makes a string longer.
- **Not built: P2.** The app still grants Save at $1,000 a day (Start earning's words say so), so a top-up over that is counted over several days. Moving Save to CAP_MAX changes Start earning's words too: Adrian's call. *(Decided by Adrian and built for Rebalance's Save: "2026-10-20 · Top-ups polish, and Save with no limit (P2)".)*

**Proof.** `contracts/test/TopUpsAppFork.t.sol` runs the bytes the app's own TypeScript builds (scripts/fork/top-ups-batch.ts: `rebalanceSave`, `rebalanceChange`, the grants as `changePlan` makes them, `agentChangePlan` with the allowlist) as JAW user operations on a Base fork against the next executor, 3/3 on a public RPC: one batch turns earning and the Rebalancer with top-ups on, sets the mix and the switch and registers both (the registry holds exactly the approved structs); a $300 top-up at 3 PM Tuesday is counted by Save, nothing goes in at 9:59:59 Wednesday, and at 10:00 it buys NVIDIA from savings (savings −$300 ±2 units, the wallet's cash and Apple unchanged, the executor holds nothing); with earning on the batch grants the Rebalancer alone; Turn off is one batch, [revoke, `setTopUps(false)`], after which a top-up is counted by nobody and nothing goes in. It needs `--ffi` and `APP_BYTES=1`, so CI skips it. Unit tests: both grant shapes, the allowlist rule and its refusals, the pairing, the reader, `rebalanceChange`, the feed and Cash rows.

## 2026-10-20 · Top-ups polish, and Save with no limit (P2)

Adrian decided P2 on 2026-10-20: Save has no amount limit, like Protect and Rebalance. The rest polishes the M5 sheet and card after the UI and money reviews, on `jl/rebalance-topups`.

- **Save at CAP_MAX:** `save` joins `NO_LIMIT_JOBS`, so `startCapRaw("save")` is the executor's CAP_MAX. Its period stays a day, so the template and its hash are the ones the executor rebuilds (no vector changes). Rebalance's Save grants earning so (P3), and its allows line names no amount. Start earning and Cash setup still grant $1,000 a day (`LIMIT_USD.save`, kept only for them) and say so, until hooks/useCashSetup.ts and hooks/useStartEarning.ts move to `startCapRaw`.
- **The allows line ends on the turn-off.** With earning's words in the same line, "You can turn Rebalance off here." comes last; alone, it stays "You can turn it off here."
- **Save waits for the switch.** While the running grant carries top-ups and the switch isn't read (or its read failed), a Save that grants says "One moment…" with no allows line, so the line never says "It never spends your cash." over a grant with the withdraw.
- **A waiting top-up is said before the tap.** A new Rebalancer grant, or the switch flipped, starts the executor's counts again, so Save says "The $300 waiting stays as cash."
- **Top-ups off once Rebalance has stopped** (its grant ran out or the executor stopped it) are the setting alone, `[setTopUps(false, Keep)]`, with Save, not Turn on.
- **The toast** says what was saved: "Your mix is saved" only when the mix changed, "Top-ups saved" for the switch or Keep alone, "Rebalance is on" when the Save turned it on, else "Saved" (copy pending Adrian).
- **A top-up going in shows on the card and the sheet's line,** worked out with the contract's rule (`investDue`: what was counted before the check's day, within savings above Keep and the grant's limits, then `investTrades`): BUY marks on the stocks it buys, "$300 going in" and the time; "$300 going in tomorrow 10:00 AM. Buys NVIDIA." When band trades are due too, the invest shows, since the executor puts it in first and band trades wait a day. In Act it's Paused.

## 2026-10-20 · Three more top-ups calls (Adrian)

Adrian took the three defaults offered after the M4 and M3 reviews ("Yes, take your defaults on all 3"):

- **P4 is exact only when the executor looks.** A fall in cash comes out of the waiting top-up at each Save count and each Rebalance run. A spend from savings and a sale landing between two looks net out, so some sale money can go into the mix. Accepted: the executor looks about every 10 minutes, and an exact count needs every spend batch to call the executor, which the core has no bytes for.
- **"Repay all" leaves Aave's buffer in the wallet** (0.05%, about $25 on $50,000 owed), and Save counts it as a top-up. Accepted: it is small and stays the user's own money, now in their mix.
- **Renew shows in the grant's last week whatever else the sheet shows** (trades due, top-ups going in, paused in Act), so a grant never runs out unnoticed. Built: `RebalanceCardModel.endsSoon`, `sheetLine` returns `renew` from it.
- **P7's update** (turning top-ups off revokes the grant it replaces in the same batch) was told to Adrian on 2026-10-20: the extra JAW sheet it once needed is gone with the one signature.

## 2026-10-20 · One Face ID for a never-used account too

Adrian (2026-10-20): "go with just one face id to earn, on agent". An account JAW hasn't deployed yet (money arrived, nothing ever sent) now starts earning in one Face ID like everyone else: the supply and earning's grant in one batch, JAW's factory deploying the account first in the same user operation. This supersedes "One exception, two Face IDs" above.

- **What can't be simulated, and how it's covered:** the batch is simulated without its `registerApproved` calls when the account has no code (`TxPlan.simulated`, lib/tx/plans/agents.ts), since the executor's checks on the account (its code is allowed, the manager owns it) can't pass from a bare address. What those checks need was read on Base on 2026-10-20 instead, through a keyless public RPC: `allowedCodehash` of JAW's account clone (0xc79e2c8f…1848, the EIP-1167 clone of 0xbb4f7d54…cBCd) is true on the executor live today (0x778d), and JAW's factory's `initCodeHash` is still the v1 recipe's, whose owners are the passkey and the permission manager (core accountRecord.js `ACCOUNT_RECIPE_V1`). The supply, its approve and the grant's approve are still simulated.
- **If it ever failed** (a new executor that doesn't allow JAW's clone, a recipe change at JAW), the whole batch reverts on Base: no money moves, the user pays the network fee and sees the error. The next executor must allow the same codehash.
- The same holds for any agent change from an account JAW hasn't deployed yet, though in practice Start earning is that account's first batch.

## 2026-10-20 · Turn into cash means next time automatically

Adrian (2026-10-20): "Turn into cash and 'Do this automatically next time' should be one Face ID too", and, on how the card asks: "abstract the switch, turn into cash means next time automatically". This supersedes "Do this automatically next time?" in D20's row (:20), "Other dollars…" (:143), "D20's screens follow the sweep's rules" (:165) and "'Turn into cash' is one screen" (:166), for that question; those keep their meaning for their day.

- **One batch, one Face ID:** while the agents are live and nothing converts on its own yet (`askAutomatic`), "Turn into cash" signs the conversion and the Entry grant together (useCashSetup `automaticPlan`, the conversion as the change's first calls). No switch, no second question, no opt-out on the card.
- **The card says it before the tap**, above its button: "Next time it happens on its own, up to $1,000 a day." (Entry's limit as its grant carries it). Once it lands: "It's cash now · About $119.83 is in your cash. Next time it happens on its own." *(Superseded the same day by "One card, nothing else": no line above the button.)*
- Otherwise (agents not live, or the next ones already convert on their own) the card and its batch are as before: the conversion alone.

## 2026-10-20 · One card, nothing else

Adrian (2026-10-20, on Turn into cash): "the ui is horrible, just the same card, you received, finish set up, cta. that is it". Turn into cash takes Start earning's card exactly (board 2g): an icon, "You received 120 USDT", one line, and its button. Both cards share one component (`SetupCard`, components/gg/cash/CashSetup.tsx).

- **Turn into cash:** "You received 120 USDT" · "Finish setting up" while its one Face ID also has the next ones convert on their own, else "Not in your cash yet" · "Turn into cash". The coins and what they bring, the least it all brings, the small print of every move (D7's) and the note on a coin under 99.5% are no longer on the card; the batch still holds each coin to 99.5% of face value or better, and a coin under it stays as it is. Under the card only an error, or why it can't go ahead.
- **Start earning** loses the line added under it today ("New cash that arrives moves into savings on its own."): the card is board 2g as approved. This takes back, for these two cards, "The clear line" in "One signature per change" above; Protect's and Rebalance's sheets keep theirs.

## 2026-10-20 · "You received" waits in the menu, with a number over it

Adrian (2026-10-20): "this should be placed in the burger menu you received usdt", and "we need something like a notification point or number over the burger menu icon when something is needed from the user". Turn into cash leaves Home: its card ("You received 120 USDT · Finish setting up · Turn into cash") sits at the top of Home's menu, above Activity, Guide and Settings, and the menu button carries a number while it waits (1 today; anything else that needs the user counts there too). Its tap goes to JAW's sheet and closes the menu; "It's cash now" opens over Home once it lands. Its state lives on Home (`useTurnIntoCash`), so closing the menu while JAW's sheet confirms loses nothing. The Top up sheet keeps its own Turn into cash card.

## 2026-10-20 · A $0.50 fuel tank, filled from cash

Adrian (2026-10-20): "a user needs to be able to fill up the fuel tank from cash when he needs to, and the tank should be 0.5 not 0.1". This supersedes the $0.10 of "the fuel tank" (config/risk.ts `CASH.feeBufferUsd`, 2026-10-15) and SPEC's fuel tank line.

- **$0.50,** about fifty of the largest fees measured on Base. Every spend from cash leaves it in the wallet, as before. The $0.10 was set after $0.50 had left an account with $1.36 of cash and $4 owed unable to repay at all; that holds again for such an account, and filling up doesn't change it (the tank is part of the cash).
- **What the tank shows is the wallet's USDC up to $0.50** (lib/fuelTank.ts `tankLevelUsd`), on Home's Cash card, the Cash sheet and Settings: each fee takes a little out, and a batch that moves no cash (an agent's settings, a turn-off) can only pay from it.
- **Fill up:** one batch, savings back into the wallet up to a full tank plus two cents for its own fee (`fillTankPlan`, through useTx), in Settings whenever the tank isn't full, and in Home's menu while it's under half full, counted in the number over the menu button.

## 2026-10-20 · CLAUDE.md rewritten, outdated docs archived

Adrian (2026-10-20, "clean it up as proposed"): `CLAUDE.md` is rewritten to the rules still true in the code and SPEC.md, and four outdated docs move to `docs/archive/` (`docs/archive/README.md` lists each and what supersedes it). This supersedes "Don't edit Leo's docs beyond the pointer at the top of `CLAUDE.md`" (Working rules) for `CLAUDE.md` and the archived docs.

- **Leo's `CLAUDE.md` stays in git** (54fae99 and before). The `CLAUDE.md:NN` citations in this log, its D1–D10 table and the markers this log put on D2 and D3 refer to that version. The rules in force from it are in the new `CLAUDE.md`.

## 2026-10-20 · The team-only preview runs the uncapped executor

Adrian (2026-10-20): "deploy the contract and runner for a team-only preview. Production waits for the audit or my go", asked right after "what you think of the no limit contract, is it safe?". The other session pointed out that this contract has no amount cap, and that D13 limits test deploys before the audit to caps ≤ $5. Asked whether the preview should cap agent permissions at $5 until the review is done, Adrian answered: "Keep the preview uncapped; it's team-only and I accept the risk." This is an exception to D13's cap for this one preview deploy. D13 still holds for production: the production app config never points at an unaudited executor.

- **The deploy:** GooseExecutor `0x686cd88F248DE3F9FC0835566DB798D93881F02D` on Base, `CAP_MAX` = max uint160, owned by the test deployer and bootstrapped with KeeperHub's wallet, with the runner enabled (`contracts/docs/DEPLOYMENTS.md`, "team-only preview deploy").
- **Where it's wired in:** only the preview build (greedygoose-preview.vercel.app, behind Vercel login), with `NEXT_PUBLIC_AGENTS_LIVE=1`. greedygoose.vercel.app has no executor set, so its agents stay off.
- **What's still open:** the adversarial review's findings, then the audit, before production or any wider preview.

## 2026-10-20 · The executor review's 14 findings: all takes agreed

Adrian (2026-10-20): "I agree with all 14 takes as you wrote them. Plan the fixes for the next deploy." The findings and the takes are in `contracts/docs/REVIEW-2026-10-20-adversarial.md`. In short: no way to take funds was found. Fix H1–H5, M2, M4, L1 and L4; fix H6 once Aave V4's source confirms it; M1 in part (sales below the line go first, and each account's share of a stock's sale window is capped); M3 by tightening the price band. L2 (the owner's instant pause) and L3 (a pool nudge that only delays the Rebalancer) stay as they are. The fixes ship in the next deploy; the preview deploy at `0x686c…F02D` keeps today's code.

## 2026-10-20 · Agents on in production, for the presentation

Adrian (2026-10-20, about 40 minutes before presenting the app and the agents): "Yes: deploy latest main to production greedygoose.vercel.app with the agents on (executor 0x686c…F02D) now. I accept that it's public and uncapped." This goes beyond "The team-only preview runs the uncapped executor" above: the public production link (`dpl_4KYRYJnzhQiDCqoqUzcvtmi89bTy`) now lets anyone switch agents on against the unaudited, uncapped preview executor, with the review's findings still unfixed (REVIEW-2026-10-20-adversarial.md). To undo it, promote `dpl_CQ6odX8zRJiczdxy9UTRe1YfwM7H`.

## 2026-10-20 · The next contract is parked

Adrian (2026-10-20): "Yes: add it to the next contract. A saved mix trades at the next runner round while the US market is open (from 10:00 New York), otherwise at the next open; one extra run per mix change." Then, before any of it was built: "pause the new contract park it." Everything for the next executor deploy waits for his go: the 12 review fixes (FIX-PLAN-2026-10-20.md, draft on branch `jl/executor-fixes`, pushed to GitHub the same day), the three open product questions in that plan, and this fresh-mix rule. Its design so far, which has no code yet: setMix stamps the time into the stored mix's high bits (from bit 112, inside RebalanceJob.mixOf, so GooseExecutor's bytes don't change); for 4 days after it, Rebalance may trade at any runner round from 10:00 to 16:00 New York on a market day, even if it already traded that day; the first trade clears the stamp. The app's next-check time (`rebalanceCheckAt`) mirrors it. The preview executor `0x686c…F02D` keeps running today's code.

## 2026-10-20 · The Leaderboard is live

Adrian (2026-10-20) chose to make the Leaderboard live, then "go with the PublicNode token". GooseBoard is deployed (`0x0E10…FcA1`, DEPLOYMENTS.md) and production reads it, so every account joins on its next move. This closes "Not deployed" and the RPC item under "Open" in "The Leaderboard" above. The board's logs come from a free PublicNode personal token in `NEXT_PUBLIC_BASE_RPC_URL`, because every keyless Base RPC refuses logs older than about 10,000 blocks (measured 2026-10-20) and Alchemy's free tier answers 10 blocks a request. Still open there: each phone reads every member's history, and SPEC's two items to build (Greedy Fatalities, the leverage tag on rows).

## 2026-10-20 · Credit Buy takes credit straight into cash

Adrian (2026-10-20): "i want to add usdc and when you buy you auto save in the same batch". Credit Buy's list gets a **Cash** row: its amount takes credit on step 1's backing and supplies exactly that credit into savings, in one signature. It reuses Earn with stocks' batch and checks (`buildEarnCalls`, `assertEarn`, the allowlist's `saveTo`), so no new call shape and no looser rule. Asked where it sits, he answered "under other stocks, and rename it available stocks": Available stocks, then Cash, then My holdings. Its words are "Cash" with "Earns 3.8% in savings" (his pick over "USDC"). Asked what it does while credit costs more than savings earn (true that day, block 52,861,460: credit 3.96% a year, no risk premium, against savings 3.89%), he chose "Allow it, show the gap": the amount step shows both rates and the gap before the tap, and Earn with stocks keeps its own rule (closed while credit costs more). The landed batch reads in Activity as Earn with stocks, since its receipt is the same.

## 2026-10-21 · The Rebalancer's honest card, times with GMT, and the agents' names

Adrian (2026-10-21), after "the Rebalancer is not working, the 5 PM never came" on jawegg.justan.id: a saved mix of
Apple 3, Amazon 25, Alphabet 14, Microsoft 58 (%), $7.42 of his $7.74 of stock backing credit and $0.32 of Meta free.
KeeperHub's rounds asked GooseExecutor `0x686c…` at 14:00, 14:10 and 14:20 GMT and got `upkeepNeeded = false`, which
is right: the Rebalancer never trades stock that backs credit, and no top-up was counted. The card said "On target.
Next check today 5:00 PM" with no marks, so it looked broken. This supersedes, for the two visible agents' names,
"Four agents, one name each, everywhere on screen" in "From the Agents redesign: the frame" (:115).

- **On target only when the whole portfolio is.** The card measures the whole portfolio, free and backing, with the
  rule's own band (`bandBreaks`, as `rebalanceTrades` and `RebalanceRules._primary` measure it) and draws each logo
  by it. When nothing trades and the whole portfolio is out of band, the pill stays On and the footer says why: held by
  credit when the rule would trade if the backing stock were free ("Stock that backs your credit isn’t rebalanced." /
  "Repay or free up some to let it trade."), else too small ("Off target, but too small to trade." / "Trades start at
  $20.", the executor's `minTrade`). A stock past its band is tinted over (red) or under (green), with no ghost and no
  BUY or SELL; faded cards mark nothing. Ends soon says the rule as its second line when credit holds it. Every other
  state is as it was. Adrian's suggested first line ("Your stocks back your credit, so it can't trade them.") became
  the rule itself, so the card says the rule where it blocks without a third line.
- **Adrian's own account reads "too small", not "held by credit".** Read on Base on 2026-10-21 through a keyless RPC,
  the executor's `rebalanceLimits()` is band 20% / 5 points, floor 0.5%, smallest trade $20, largest $25,000. On $7.74
  every trade the mix needs is under $20, so even with all of it free nothing would trade; repaying would not make the
  Rebalancer act, and the card says so. At 1,000 times the size, the same account reads "held by credit".
- **The rule, visible:** the Rebalancer's sheet always says "Stock that backs your credit isn’t rebalanced." under its
  line, unless the line already says it.
- **Times with GMT:** every time an agent will act at (the Rebalancer's card, its sheet's line, the top-ups note, the
  Agents list's next line, the Protector's "They try again at", its weekend card, the feed's "Tries again") is the
  viewer's clock and its offset then: "Today 5:00 PM GMT+3", "GMT" alone at no offset, "GMT+5:30" for half hours
  (`lib/clock.ts`). The How it works sheet keeps "at 10:00 AM New York", which names its zone.
- **Names:** Protect is **Protector** and Rebalance is **Rebalancer** wherever a user sees them: the Agents page,
  cards, sheets, pills, toasts, activity and Cash rows, the guide, How it works, aria-labels, the credit scale, Credit
  Buy's and Earn with stocks' risk lines. Code identifiers, URLs (`/agents?agent=protect`) and comments keep the old
  names, and "isn’t rebalanced" stays a verb.

**In this repo:** `lib/agents/rules/rebalance.ts` `bandBreaks`; `lib/agents/next.ts` `rebalanceOutlook` (`offTarget`,
`heldByCredit`, `wholePortfolio`, `BACKING_RULE`, `TOO_SMALL`) and `whenText` on `lib/clock.ts`; `lib/agents/rebalanceCard.ts`
(`MixSlot.out`, the held states); `RebalanceCard.tsx` tints `out`; `RebalanceSheet.tsx` the rule line; `AgentName` is
"Protector" | "Rebalancer" | "Agents". Galleries: the card's and the sheet's "Held by credit" and "Too small to trade"
(app/dev/ui/agents/measuredAccount.ts), the Agents page `?view=held`.

**Tests:** `rebalancer-held` (the band check against the trades, the outlook, the states on Adrian's account and at
1,000×, the whole-portfolio slots, the list's line), `clock` (offsets, today, tomorrow, the weekday, a viewer's own
calendar, a clock change), and the suites that name the agents.

## 2026-10-21 · The Rebalancer's card after review

Three reviews of the entry above (logic, copy, the screens at 402px) found states that still misled. This supersedes,
where they differ, its first bullet, its "Adrian's own account" bullet and the How it works line under "Times with GMT".

- **What holds it back, five ways** (`RebalanceOutlook.blocked`, `blockedWords` in `lib/agents/next.ts`), the first
  line also the Agents list's line, never "On target":
  - held by credit: "Stock that backs your credit isn’t rebalanced." / "Free up some to let it trade." Repaying alone
    leaves the stock backing credit (`backingRaw` is what's supplied; the guide says "Free up: Take shares out of
    backing, often after a repay"), and the Repay sheet asks for a repay when a free-up needs one. Adrian's "Repay or
    free up some to let it." is changed for that reason; his OK is still to come.
  - too small with all of the mix's stock backing credit, Adrian's own account: "Off target, but too small to trade." /
    "Stock that backs your credit isn’t rebalanced." So his card names the credit, as he asked, without promising that
    freeing it up would make it trade (at $7.74 nothing would).
  - too small with some of the mix free: "Off target, but too small to trade." / "Trades start at $20."
  - the grant leaves nothing this period (a stock's sell limit or the USDC limit used up): "Off target, but nothing it
    can trade now." / "Next check …". Before, this read "too small" though the trade was $1,500.
  - none of the mix held, free or backing: "You hold none of your mix yet." / "Buy some and it keeps them on target."
    Before, this read "On target" every day, the trap of "the 5 PM never came".
- **The picture.** While trades or top-ups are due (marked, or waiting in Act), the card draws the free stock they
  move, as before this change: on the whole portfolio, a SELL could sit on a logo below its line when free and backing
  stock lean different ways (common after a Credit Buy). Otherwise it draws the whole portfolio. Over and under tints
  show only in the five states above (and Ends soon when one of them is its second line); Paused and Retrying are
  untinted again, as on main.
- **How it works** says the check on the viewer's clock ("Once a market day, at 5:00 PM GMT+3, it checks your
  stocks.", the next check's own offset), and "band" for "room", a word SPEC keeps off the screen. The same length.
- **Days with every time ahead:** the weekend card ("Prices pause tomorrow at 3:00 AM GMT+3."), the Protector's "They
  try again today at …", and the feed's "Tries again" with the date when it falls on a later day than its row.
- **My mix** reads "backs credit" for a stock with no free shares that backs credit, where it said "none now".
- **Small ones:** the Protector's save toast is "Protector saved" ("Protector is saved" read as a rescue); the
  permission error names "Rebalancer", as everywhere else.
- **Not changed, for Adrian:** at 402px the On target and top-ups footers wrap their time onto a second line whenever
  it says "Tomorrow" (every evening after the check in Beirut): "Tomorrow 5:00 PM GMT+3" needs about 342px of the
  footer's 322. That wrap is the footer's built-in fallback for narrow phones; the fix would stack "Next check" over the
  time, a change to board 7a he decides.

**In this repo:** `lib/agents/next.ts` (`blocked`, `blockedWords`, `atText`), `lib/agents/rebalanceCard.ts` (`marks`,
the free-stock picture while trades are due), `lib/agents/guide.ts` `rebalanceSteps`, `components/gg/agents/MixCard.tsx`,
`lib/agents/feed.ts`, `lib/agents/protectCard.ts`. Galleries: the card's too small with free stock, nothing to trade,
none held, trades due drawn on the free stock, Paused leaning the other way; the Agents page's `&sheet=rebalance` is the
real sheet now.

**Tests:** `rebalancer-held` (each block, the free-stock picture, Paused untinted, nothing owed and Act), `clock`
(`atText` for the weekend freeze), `agents-guide` (the check on four clocks and a clock-change week), `agent-feed` (the
date on a retry past midnight).

## 2026-10-21 · Credit Buy's Cash row after review

Before it went to production (Adrian: "Deploy"), a review of the Cash row (money path, screens, the fit with main, tests,
each finding checked by a second reader) found nothing that moves money wrong, and five things on screen:

- **A failed rate read blocks.** When the simulation that reads what this credit costs fails, `useEarnRates` falls back to
  today's rate; Earn with stocks keeps that (it's closed while credit costs more), but the Cash row shows the cost before
  the tap, and today's rate understates it (the credit raises the rate it's taken at). It now reads `failed`, shows no
  cost ("—" in the Cost cell) and says "Couldn’t read what this credit costs. Try again in a moment."
- **The toast says the amount signed**, kept at the tap, not what the field says when it lands; and the field and MAX wait
  while JAW's sheet is open or the batch confirms, as a send's and a trade's do.
- **A blocked amount shows today's rate** in the Cost cell, as the stock route does, instead of "…" that never resolves.
- **The gap's dollars are exact:** tenths × dollars ÷ 1,000 with earnTenths' epsilon (1.7% of $3,000 read "$52").
- **A full savings cap says so:** Aave V3's `SupplyCapExceeded()` (0xf58f733a, measured on Base) reads "Aave can’t take
  more cash into savings right now. Try again later." for every savings supply, where it fell back to the caller's words.

**In this repo:** `hooks/useEarnWithStocks.ts` (`failed`), `lib/creditBuy/toCash.ts` (`gapLine`, `costCellText`,
`RATE_UNREAD`), `components/gg/stock/useCreditBuyCash.ts` (`sign`, `costText`), `CreditBuyCashStep.tsx`,
`CreditBuySheet.tsx`, `lib/aave/errors.ts`. **Tests:** `credit-buy-cash` (the gap's sweep, the Cost cell, the failed read,
the full cap).

## 2026-10-21 · Greedy Fatalities: how the Wall reads

Adrian asked to split the Leaderboard into Heroes (today's board) and the Wall of shame (SPEC's Greedy Fatalities), then
asked Claude to decide how the Wall reads. This settles SPEC's "ranked by its multiple at the end"; the screens wait for
their boards.

- **The multiple is Home's leverage at the sale** (`lib/leverage.ts`, what they held ÷ what was theirs). Amounts are
  read at the end of the block before the sale, valued at Aave's prices in the sale's own block: a liquidator usually
  lands the sale in the same block as the price update that set it off, and the block before still has the old price
  (on the fork, 1.73x at the sale's price where the old price read 1.69x). Cash counts as held, so credit kept as cash
  stays low (the fork's $6,069 of credit kept as cash: 1.73x) and only credit turned into stock nears Aave's ceiling,
  about 1 ÷ (1 − the stock's collateral factor): 2.9x for Tesla and Meta to 4.8x for Microsoft, a little more after a
  price jump. The film's 14.2x can't happen; the galleries use real numbers. Nothing of their own left at the sale ranks
  above every multiple. One row per account, at its highest; ties go to the earlier sale, then by address.
- **Only Aave V4 sales of a stock count** (`LiquidationCall`'s `collateralReserveId` is one of the seven). Aave V3 sales
  of savings backing credit drawn in another app never put anyone on the Wall. Heroes still counts their cost.
- **Leaving doesn't take anyone off.** The Wall reads GooseBoard's whole list, not `listed`: an account on it when the
  Wall opened counts from the opening, one that joined later from its first `Joined` event, so `leave()` and `join()`
  again change nothing. Only sales after `NEXT_PUBLIC_WALL_FROM_BLOCK` count, so nobody is named under a rule that wasn't
  shown yet; unset, there is no Wall. No contract change (GooseBoard has no owner).
- **Reads:** one `eth_getLogs` per 10,000 blocks for GooseBoard's `Joined` and the spoke's `LiquidationCall` (sales are
  rare, so the whole spoke's), GooseBoard's list at the opening block, and per sale the member's holdings and the prices
  (past state). Settled reads are kept in the browser, as the board's are. Any read failing fails the Wall, never a
  partial one.

**Credit floor, decided the same day.** Users may take credit down toward Aave's line: 1.05 with Protector on (0.02
over its 1.03 line, as 1.12 sits over 1.10 today, so it doesn't sell straight back) and 1.01 with it off. A move ending
under 1.1 shows the Wall's rule and one tick, which is where the rule is "stated once before the first credit". It ships
with the Wall, since that line promises it: the line is `ACT_LINE` (1.12, unchanged) until `NEXT_PUBLIC_WALL_FROM_BLOCK`
is set. Protect's target stays 1.12.

- **One line per position** (`config/risk.ts` `CreditLine`: the cap plans stop at, the stop the simulation holds the
  batch to, and whether a plan may end in Act). `usePosition` reads it from Protector's job bit on GooseExecutor
  (`protectRuns`, the same read as Save's) and the Wall's setting, and every planner reads it from the position
  (`lineOf`), so a flow that doesn't pass one stays at 1.12. Credit Buy, its Cash row, Earn with stocks, Free up and Sell
  from backing all take it; each plan carries its own floor (`creditFloor`, `freeUpFloor`, `earnFloor`).
- **Ending in Act asks for the tick** every flow already asks for Watch (`extraConfirm`; Free up's `risky`), and each
  plan says `intoAct` so the screen can word it as the Wall's rule. No screen sells from backing (Sell and Trade sell free shares; Repay sells to pay, which ends healthier or is blocked), so no other tick is needed.
- **New words:** "Your credit is past its limit. Repay some to use more." (under the line's stop, "past-limit"), "Prices
  moved, so that’s past your limit now. Try a smaller amount." (the simulation's stop), "That would take your credit
  past its limit. Sell more, or repay from cash." (a sale to repay that ends under the stop).
- Under `ACT_LINE` nothing changes: the plan tables (over 7,000 Repay and Trade cases) hash exactly as before once the
  two new fields are left out.

**In this repo:** `lib/board/wall.ts` (`wallSince`, `countedSales`, `saleMultiple`, `rankWall`), `lib/board/logs.ts`
(`decodeWallLogs`, `readWallRecords`), `lib/board/read.ts` (`readWall`; the holdings read is shared with Heroes),
`lib/board/config.ts` (`WALL_FROM_BLOCK`). **Tests:** `board-wall` (the multiple, who counts and from when, the order,
the decoder); `scripts/wall-e2e.ts` on a Base fork (a real sale in the price update's block, read by `readWall`; leave
and join again). The credit line: `config/risk.ts` (`CreditLine`, `ACT_LINE`, `creditLineFor`, `pastStop`),
`lib/cash.ts` (`protectRuns`), `hooks/usePosition.ts` (`line`), `lib/creditBuy.ts` (`lineOf`, `creditFloor`, `intoAct`),
`lib/freeUpPlan.ts`, `lib/sell.ts`, `lib/earnWithStocks.ts`, `lib/tx/plans/{earn,freeUp}.ts`, `hooks/useRepay.ts`.
**Tests:** `credit-line` (the three lines, Credit Buy's cap and blocks, Free up, Sell from backing, Earn's offer).

## 2026-10-21 · Heroes | Wall of shame, the screens

Adrian chose the tabs "Heroes" and "Wall of shame", the Wall titled "Greedy Fatalities" (as in the film and the guide),
no leverage tag on Heroes rows for now, and, for the two choices on one screen, "a clean UX solution": the mock he
approved.

- **One pill for the board, a quiet toggle for who.** Heroes | Wall of shame is the NYM pill. Under it, on Heroes only,
  Everyone · Contacts is two words, the chosen one in ink and underlined, with Add several at the end of that row. The
  Wall has no filter: it is a short list and everyone on it is named. "Return since joining" stays in the foot.
- **Until the Wall opens** (no `NEXT_PUBLIC_WALL_FROM_BLOCK`) the tab is exactly as before: All | Contacts as the pill,
  "Return since joining" beside Add several. No tabs while the board opens soon (ruling 47).
- **A Wall row:** rank, a lime egg cracked on Act's pale red, the name struck through in Act's red (`#8e2a1d`), the
  multiple in bold red (Home's tag, "4.7x", rounded down, or "Wiped out") and the date. Your own row is lit pale red.
  Nothing to tap. Over the list, "Greedy Fatalities" and "Part of their stock was sold to pay what they owe. Boldest
  first."; under it, how it ranks. States: loading (the board's skeleton), Base not answering (Retry), nobody yet.
- **The tick into Act states the Wall's rule** on every flow that has one (Credit Buy, a buy split with credit, its
  Cash row, Earn with stocks, Free up): "I understand this puts my credit in Act. If my stocks fall too far and part of
  them is sold to pay what I owe, my name goes on Greedy Fatalities." Watch keeps its own words.
- **"My credit status"** says where new credit and free up stop: in Watch at 1.12 as before, in Act at the line once the
  Wall is open.
- **The guide's "Stay off Greedy Fatalities"** loses "Opens soon" with the Wall (`wallOpen`).

**In this repo:** `components/gg/leaderboard/WallView.tsx`, `BoardView.tsx` (`Controls`, `WhoToggle`),
`LeaderboardScreen.tsx`, `hooks/useWall.ts`, `lib/board/view.ts` (`BoardTab`, `WallPerson`, `wallMultiple`,
`wallDate`), `lib/board/copy.ts`, `lib/creditBuy/copy.ts` (`creditTick`), `lib/earnWithStocks/copy.ts` (`earnTick`),
`components/gg/CreditStatusSheet.tsx`, `lib/guide/content.ts`. Gallery: `/dev/ui/board?tab=wall&wall=few|many|empty|
loading|error`, `&wall=off` for the board as before.

## 2026-10-21 · Add contact, one sheet

Adrian: "add contact not add several, when click you can select multiple from the list of search and select". This
replaces, in "The Leaderboard", Add several (ticking rows on the board, with a bar over the tab bar) and Add by name.

- **One button, "Add contact"**, at the end of the row under the tabs (beside "Return since joining" before the Wall
  opens), on Everyone and on Contacts; Contacts' empty state offers it too.
- **One sheet, "Add contacts":** a field that narrows the board's list as you type (any part of a name's own label, the
  whole name once a dot is typed, or an address; the parent every name shares doesn't match a plain word), and Find,
  which looks a name up for someone not on the list and puts them on top, ticked. Everyone on the board but you and
  your contacts is listed with a tick, their mark and their percent; whoever is ticked stays listed whatever is typed,
  so "Add 3 to contacts" never counts a hidden row. One JAW sheet adds them all (`addChange`).
- Names for the whole board are read while the sheet is open, so it can search them.

**In this repo:** `components/gg/leaderboard/AddContactSheet.tsx` (was `AddByNameSheet.tsx`), `BoardView.tsx`,
`BoardRow.tsx` (no pick mode), `LeaderboardScreen.tsx`, `lib/board/view.ts` (`addCandidates`, `boardChanges`),
`lib/board/copy.ts`. Gallery: `/dev/ui/board?sheet=add|add-found|add-eth|add-none`. **Tests:** `board-screen`.

## 2026-10-21 · The health bar gives Watch and Act room

Adrian: Watch and Act "are too close to each other, user dont see how watch he is or how bad in act zone he is, safe
matter less"; then "make the green a bit bigger and orange and redish smaller". The bar (`components/gg/Status.tsx`
`BAR`, `barPosition`) is now Safe 25% (2.5 to 1.5), Watch 35% (1.5 to 1.1), Act 34% (1.1 to Protector's line, 1.03)
and a darker red edge 6% (1.03 to Aave's line, 1.0, token `--act-edge`). It was Safe 60%, Watch 24%, Act 17%, all of
Act on one straight line. Each 0.01 of health in Act now moves the dot about three times as far, and 1.03 sits where
the edge starts, so the last stretch reads as the brink. One scale everywhere it's drawn: "My credit status", the
Repay card, Credit Buy's amount step and Protector's card (whose 1.03 mark now meets the edge). **Tests:** `status`.

## 2026-10-21 · Toasts fit their words, with a light around them

Adrian: a short toast sat in a mostly empty pill ("toasts should be dynamic depending on the phrase"), then "use the
border animation we have in jaw frames like the light that goes around, use the yellow fluo". A toast is now as wide
as its words, centred, up to the full width (`app/providers.tsx`; on a phone the toaster is held between its two
offsets, where sonner made it overflow to the right). A lime light runs around its border, one lap in 2.4 s
(`.gg-toast-beam` in `app/globals.css`: a conic gradient on the border box, so sonner keeps its pseudo-elements for
swiping); with reduced motion it doesn't move. No JAW source for the original animation was found in this machine's
repos; this is the same effect, built for the pill.

## 2026-10-21 · Dark mode, in the booth's style

Adrian saw a plain dark version ("really ugly"), then asked for the booth app's look (hannibaluslab/jaw-booth-revamp),
following the phone, with "a switch in the burger menu that overrides the phone and lets JAW know".

- **Phone · Light · Dark** in the menu (`MenuButton`, under the links), Phone by default. The choice lives on this
  device (`gg.theme`); lost storage means following the phone again. `lib/theme.ts` resolves it; a script in the page
  sets `<html data-theme>` and the browser bar's colour before the first paint, so a dark page never flashes light.
- **The booth's look** (`app/globals.css`, `[data-theme="dark"]`): ink ground with lime dots and a lime glow at the
  top, glass cards (white 5%) with a white hairline, ink turned to glass, lime that glows with ink words on it, Act's
  red as the booth's #ff7a66, gains a lighter green. Sheets rise off the page: it dims (black 60%) and blurs behind
  them, they sit a shade lighter with a hairline on their top edge. The goose loader is cream on dark.
- **JAW's sheet follows:** a light theme (the app's ground, white cards, ink words, the lime Confirm, gains in green)
  and the dark one it had; `ThemeSync` pushes the theme to JAW's connector (`setTheme`, @jaw.id/wagmi 1.1.13: it
  re-themes a sheet that's open and the next one) whenever the theme flips, the phone's included.
- **Hard-coded colours** that a theme couldn't reach now follow it: ink tints as `ink/8`-style opacity, the tab bar's
  fade, the chart lines, checkbox accents, three new tokens (`--line-control`, `--you-row`, `--toast-bg`, `--scrim`).
  Light is unchanged.

**In this repo:** `lib/theme.ts`, `hooks/useTheme.ts` (`useTheme`, `ThemeSync`), `app/layout.tsx`, `app/providers.tsx`,
`lib/jaw/config.ts` (`jawThemeFor`), `components/gg/MenuButton.tsx`, `app/globals.css`, and the colour fixes across
`components/gg`. **Tests:** `theme` (the rule, and the first-paint script run against a stand-in page).

## 2026-10-21 · One sheet at a time while JAW signs

Adrian: "2 sheet open is ugly and confusing" (our sheet peeked out above JAW's Review sheet). While JAW's own sheet is
up, from the moment a batch goes to JAW until JAW answers (sent, cancelled, popup blocked), our sheet steps aside: it
slides below the screen (`translate`, so vaul's own `transform` is untouched) and the dimmed page stays, so JAW's sheet
shows alone. When JAW answers, ours comes back: as the goose page while the change confirms, or with "You cancelled.
Nothing was sent." The flag is set in the one write path (`lib/tx/prepared.ts` submit, `lib/tx/jawSheet.ts`), so every
sheet that signs does it. **Tests:** `prepared-tx` (up from the send to JAW's answer, for sent, cancelled and blocked;
never up for a batch that doesn't reach JAW).

## 2026-10-21 · Multi trade, in the Trade sheet

Adrian: bring NYM's multi mode to GreedyGoo, "in the trade sheet", called Multi trade. The Trade sheet's header has a
lime **Multi trade** pill; it opens a list (NYM's MoveSheet multi mode): the total, "2 trades · one signature", one row
per trade (both marks, "Meta → Cash", what it gets, its dollars), dashed places up to the two a list needs, then Add and
"Make 2 trades". The trade on screen comes along as the first row when it could sign. Tapping a row opens it in the
Trade sheet's own editor ("Trade 2 of 3", Back drops the edit, Remove, Done); Add opens "New trade · #3". Up to 5
trades. Cancel leaves the list.

Each row is any trade the sheet makes (cash → stock, stock → cash, stock → stock), from cash and free shares only:
no credit, as in the plain Trade sheet. Each row prices itself live, as the editor does. The rows go ahead together only
when the buys fit the cash with the network fee kept back, and no stock is sold for more than its free shares across the
rows (`multiBlock`); a row that can't go ahead says why on the row. One batch for all (`lib/tx/plans/multiTrade.ts`),
from fresh quotes: any savings withdrawal the buys need, the buys, the stock-to-stock trades (each stops with
QUOTE_MOVED if its fresh sale no longer covers its buy), the sales, then one savings supply of what the sales are sure
to bring. That supply is checked from the decoded calls, as a single sale's is (`assertSalesCoverSave` in
`lib/sell/covers.ts`), and Multi trade joins the builders allowed to declare `saveTo`. Done: "2 trades done", and the
sheet closes. **Tests:** `multi-trade` (11), the `saveTo` guard in `start-earning`.
