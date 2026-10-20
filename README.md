# GreedyGoose

An invest-and-earn app on Base. You sign in with a passkey. Your account is a JAW smart account that only you control.

- **Cash that earns.** Once you start earning, your USDC sits in Aave V3 savings and earns its variable rate. The app
  shows it as one pot of cash.
- **Tokenized stocks.** Buy, sell and trade the seven Coinbase tokenized stocks on Base (Apple, Amazon, Alphabet, Meta,
  Microsoft, NVIDIA, Tesla).
- **Credit backed by your stocks.** Take USDC credit on Aave V4's Equities spoke with your stocks backing it. Repay and
  free up stocks in one signature.
- **Agents (coming soon).** Save moves new cash into savings. Entry turns other dollar coins you receive into cash.
  Protect repays from your cash if your credit falls under 1.03, and sells stock that backs your credit if cash isn't
  enough. Rebalance trades your stocks toward your mix, and can put your top-ups into it.
- **One Face ID per change.** Each action is one batch, shown on JAW's sheet before you sign. Turning an agent on is
  one batch too, with its permission and its setup together.
- **A fuel tank.** $0.50 of your cash stays in the wallet to pay Base's network fees in USDC.

Tokenized stocks track stock prices. They are not company shares, and they earn no yield.

## Status

- The app runs on Base mainnet. Production is greedygoose.vercel.app.
- The agents show "Coming soon" until GooseExecutor is deployed and set in the app (`NEXT_PUBLIC_GOOSE_EXECUTOR` and
  `NEXT_PUBLIC_AGENTS_LIVE=1`, see `lib/agents/config.ts`). The executor they need is built and tested on a Base fork,
  with a few pre-launch values still to set. It is not deployed yet (the go-live checklist in
  [DEPLOYMENTS.md](contracts/docs/DEPLOYMENTS.md)).
- The Leaderboard opens once its contract, GooseBoard, is deployed. It isn't yet.

## Start here

- [docs/SPEC.md](docs/SPEC.md) holds the product rules. It wins over every other doc, this README included.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) holds the code layout and conventions.
- [docs/JUSTALAB-DECISIONS.md](docs/JUSTALAB-DECISIONS.md) records why each rule exists.
- [contracts/docs](contracts/docs) holds the contracts as built, their deploys and notes on JAW's permission manager.
- [docs/archive](docs/archive) keeps old docs for the record. Don't build from them.

## Run locally

Node 22 (`.nvmrc`).

```bash
cp .env.example .env.local   # set NEXT_PUBLIC_JAW_API_KEY; an empty NEXT_PUBLIC_BASE_RPC_URL uses Base's public RPC
npm ci
npm run dev
```

`.env.example` explains the main settings. `NEXT_PUBLIC_ALCHEMY_KEY` is optional and turns on money received in
Activity and the all-time line on Home. [scripts/rehearsal](scripts/rehearsal/README.md) runs the whole app on a local
fork of Base, with fake money.

## Checks

```bash
npm run check             # lint, types, format, dead code, unit tests
npm run build
npm run verify:registry   # reads Base and simulates calls; sends nothing
npm run contracts:test -- --no-match-contract "Fork|DeployExecutorTest|ExecutorSpikeTest"   # forge, offline
BASE_RPC_URL=https://mainnet.base.org npm run contracts:test                              # forge, Base fork
```

## Repository map

- `app/` Next.js routes, and the stateless price route (`app/api/prices`)
- `components/` screens and sheets by feature (`components/gg/`), and the shared kit (`components/gg/kit/`)
- `hooks/` chain reads, and `useTx`, the one write path
- `lib/` pure planners and batch builders, the allowlist, and the typed address registries
- `config/risk.ts` every threshold and buffer
- `contracts/` GooseExecutor and its jobs, GooseReceiver and GooseBoard (Foundry), with their docs
- `scripts/` the fork rehearsal, the app's batches for fork tests, and test vectors
- `tests/` unit tests and Base simulations
- `docs/` the spec, the architecture and the decisions log

## Safety

The app never holds your keys or your money. Agents act only within the permissions you grant, and each one can be
turned off.
