# GreedyGoose architecture

How the code is organised, the conventions every change follows, and the clean-up still ahead. Product rules live in
[SPEC.md](SPEC.md).

## Layers

| Layer       | Where                    | What it holds                                                                                                                                    |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Routes      | `app/`                   | Thin pages: read the account, render a screen                                                                                                    |
| Screens     | `components/gg/`         | Views and sheets, built to the canvas boards                                                                                                     |
| Kit         | `components/gg/` (base)  | Button, AmountField, AssetPicker, SheetShell, Status: the shared pieces                                                                          |
| Hooks       | `hooks/`                 | Chain reads (positions, prices, permissions) and the one write path, `useTx`                                                                     |
| Engines     | `lib/`                   | Pure planners and batch builders: what a screen shows (`planSend`, `planTrade`, `planCredit`) and the calls it signs, unit-tested without a chain |
| Guards      | `lib/allowlist.ts`, `lib/tx/prepared.ts` | Every batch is checked against the allowlist and simulated on Base (`eth_simulateV1`), with Aave's health read after it, before JAW's sheet |
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
- **Size:** files over 400 lines and functions with complexity over 25 warn. 35 warnings today; each goes when its
  screen or engine is rebuilt, then the rule becomes an error.

## Clean-up ahead (V1 and V2)

Measured on 2026-10-18, on `v2` after V0.

| Issue                                     | Today                                                                                          | Target                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Two vocabularies                          | Screens say backing, credit, Protect; code says `locked`, `borrow`, `loan`, `guardian` (about 580 lines) | One domain language in code too. Aave's ABIs and the contracts keep their own names        |
| Comments that cite people and dates       | 141 lines such as "(Adrian, 2026-10-15)"                                                       | Comments say why; who decided and when lives in the decisions log                          |
| Oversized screens and engines             | `CreditBuySheet` 831 lines, `trade.ts` 575, `send.ts` 530, `Board` 505, `repay.ts` 476         | Under 400 lines each, split by step or concern                                             |
| One flat component folder                 | 58 files in `components/gg/`                                                                   | Feature folders (kit, home, repay, stock, invest, agents, leaderboard, settings, send)     |
| Leo's off-chain keeper                    | `keeper/`, `lib/guardian/keeper.ts`, `scripts/guardian-e2e.ts`, unused by the app since D12    | Removed, if Adrian agrees. The rule mirrors in `lib/guardian/` that feed the contract test vectors stay |
| Free up outside Repay                     | `UnlockSheet` and the Repay \| Free up toggle                                                  | Gone once the Repay sheet (canvas boards 1–8) is rebuilt                                   |
| Non-null assertions                       | 109 in the app code                                                                            | Replaced as each module is touched                                                         |

Each row is done module by module as V1 (engines) and V2 (screens) reach it, never as one big sweep across working
code.

## Branches

- `v2` is the line for the new version. It holds everything from `jl/welcome-bg`, `main`, `jl/credit-cap-act` and
  `jl/rehearsal`.
- Every `jl/*` branch before it is merged into `v2` and kept as history.
