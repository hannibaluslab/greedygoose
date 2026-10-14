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
