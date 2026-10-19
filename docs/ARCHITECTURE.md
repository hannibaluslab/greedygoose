# GreedyGoose architecture

How the code is organised, the conventions every change follows, and the clean-up still ahead. Product rules live in
[SPEC.md](SPEC.md).

## Layers

| Layer       | Where                    | What it holds                                                                                                                                    |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Routes      | `app/`                   | Thin pages: read the account, render a screen                                                                                                    |
| Screens     | `components/gg/<feature>/` | Views and sheets by feature (activity, agents, cash, home, leaderboard, repay, send, stock), built to the canvas boards                        |
| Kit         | `components/gg/kit/`     | Button, AmountField, AssetPicker, SheetShell, Switch, icons: the shared pieces                                                                   |
| Hooks       | `hooks/`                 | Chain reads (positions, prices, permissions) and the one write path, `useTx`                                                                     |
| Engines     | `lib/`                   | Pure planners and batch builders: what a screen shows (`planSend`, `planTrade`, `planCredit`) and the calls it signs, unit-tested without a chain. Big flows have a folder (`lib/trade/`, `lib/send/`, `lib/repay/`); `lib/sell/covers.ts` checks a sale's repay or savings supply against the sale; `lib/cash/read.ts` reads the cash again at signing |
| Guards      | `lib/allowlist.ts`, `lib/tx/prepared.ts` | Every batch is checked against the allowlist and simulated on Base (`eth_simulateV1`), with Aave's health read after it, before JAW's sheet |
| Plans       | `lib/tx/plans/`          | What each flow signs (`TxPlan`): its key, its batch built from fresh reads, its fallback words and health floor, one file per flow              |
| Contracts   | `contracts/`             | `GooseExecutor` and its job rules (Foundry), triggered by Chainlink Automation                                                                   |
| Config      | `config/risk.ts`         | Every threshold and buffer, mirrored on-chain where the executor uses it                                                                         |

A screen is three parts: a pure plan function in `lib/` that turns inputs into everything the screen shows (tested),
hooks that read and write, and a view that renders the plan. New screens follow that split.

## Conventions (enforced by `npm run check` and CI)

- **Format:** Prettier, 120 columns. Formatting-only commits go in `.git-blame-ignore-revs`.
- **Lint:** Next's rules plus type-only imports, no unused code, `===` only, and no console logging in the app.
- **No dead code:** knip fails on unused files, exports and dependencies.
- **Tests:** unit tests for every planner and builder (`tests/unit`); Base simulations for every new batch
  (`tests/onchain`, needs an RPC); Foundry tests for the contracts, fork suites included when `BASE_RPC_URL` is set.
- **Writes:** one path, `useTx`. No screen sends a transaction any other way, and there is no confirm screen of ours.
- **Size:** files over 400 lines and functions with complexity over 25 warn. 2 warnings today; each goes when its
  screen or engine is rebuilt, then the rule becomes an error.

## Clean-up ahead (V1 and V2)

Measured on 2026-10-19, on `v2` at `391053a` and the Credit Buy split after it; sizes and warnings re-measured on
`jl/cleanup` after the moves (trade, send, repay and the feature folders are done).

| Issue                                     | Today                                                                                          | Target                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Two vocabularies                          | Screens say backing, credit, Protect; code says `locked`, `borrow`, `loan`, `guardian` (about 294 lines) | One domain language in code too. Aave's ABIs and the contracts keep their own names        |
| Comments that cite people and dates       | 73 lines such as "(Adrian, 2026-10-15)"                                                        | Comments say why; who decided and when lives in the decisions log                          |
| Oversized engines and pages               | Over 400 lines with blanks and comments: `lib/creditBuy.ts` 498, `lib/agents/permissions.ts` 493, `app/home/page.tsx` 432, `lib/rehearsal/signer.ts` 424, `lib/tx/prepared.ts` 420 (under the lint's count, which skips those) | Under 400 lines each, split by step or concern |
| Complex functions                         | The 2 lint warnings: `BuySheet` (complexity 81) and `useTx` (28)                               | Under 25 each, then the rule becomes an error                                              |
| Free up outside Repay                     | Done: Free up lives in the rebuilt Repay sheet (`components/gg/repay/`)                        | Done                                                                                       |
| Non-null assertions                       | 108 in the app code                                                                            | Replaced as each module is touched                                                         |

Each row is done module by module as V1 (engines) and V2 (screens) reach it, never as one big sweep across working
code.

## Branches

- `v2` is the line for the new version. It holds everything from `jl/welcome-bg`, `main`, `jl/credit-cap-act` and
  `jl/rehearsal`.
- Every `jl/*` branch before it is merged into `v2` and kept as history.
