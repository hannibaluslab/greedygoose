# GreedyGoose

GreedyGoose is a mobile-first app on Base for buying and selling supported tokenized stocks, using eligible stocks as collateral, and managing USDC credit through Aave V4. Accounts use JAW passkeys.

> **Start here:** [docs/SPEC.md](docs/SPEC.md) holds the product rules and wins over every other doc, this README included. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) holds the code layout and conventions. [docs/JUSTALAB-DECISIONS.md](docs/JUSTALAB-DECISIONS.md) is the record of why each rule exists.

Tokenized stocks track stock prices; they are not company shares and do not earn yield.

## Current product areas

- **Portfolio:** View supported stock holdings, cash, credit, and position status.
- **Buy and sell:** Buy supported stocks with cash or credit; sell shares that are free to move.
- **Credit:** Add stock collateral, use USDC credit, repay, and free up shares when the position allows it.
- **Activity and agents:** Review account activity and the Protect/Rebalance experiences. Agent actions depend on the executor being deployed and configured; check the decision log before assuming they are live.

## Run locally

~~~bash
cp .env.example .env.local
# Set the required JAW API key and Base RPC URL in .env.local.
npm ci
npm run dev
~~~

## Checks

~~~bash
npm run check            # lint, types, format, dead code, unit tests (what CI runs, plus the build)
npm test
npm run verify:registry  # Checks registered assets and simulates calls; sends no transactions.
npm run typecheck
npm run lint
~~~

Contract and agent checks may need a Base RPC URL. See the scripts in package.json and the relevant docs before running them.

## Repository map

- app/ — Next.js routes and screens
- components/ — UI components and sheets
- hooks/ — wallet, market, and position state
- lib/ — protocol integrations, quotes, and transaction builders
- contracts/ — executor and agent contracts
- tests/ — unit and chain-level checks
- docs/ — product decisions and implementation notes
