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
