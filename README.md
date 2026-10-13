# GreedyGoose

Borrow USDC against your Coinbase tokenized stocks on Base, using JAW passkey accounts and the Aave V4 Equities Hub. Product rules are in `CLAUDE.md`. Anything not in the MVP is in `docs/PARKED.md`.

## Run

```bash
cp .env.example .env.local   # add NEXT_PUBLIC_JAW_API_KEY (dashboard.jaw.id) and a Base RPC URL
npm install
npm run dev
```

## Checks

```bash
npm test                 # unit tests: risk status, market hours, Aave maths
npm run verify:registry  # re-checks addresses + simulates supply/borrow/repay on Base mainnet (nothing is sent)
npm run typecheck
npm run lint
```

## Build status

| Step | State |
| --- | --- |
| 1. Scaffold (Next.js 16, Tailwind tokens, Wagmi + JAW on Base) | done |
| 2. Registry + on-chain verification | done |
| 3. Read-only position (balances, collateral, debt, health, rate, liquidity, market hours) | done |
| 4. Home, Credit, Receive and Settings from real chain data | done (the JAW subname is not shown yet; addresses are shown instead) |
| Buy stocks with USDC (Aerodrome / Uniswap, simulated, 1% slippage cap) | done (not yet tried with a real signed-in account) |
| 5–6. Get a loan: lock any mix of stocks (slider per stock, auto-fill to Safe) + borrow, one Face ID | done |
| 7. Repay (partial / all, allowance reset after full repay) and Unlock (withdraw, Aave-limit aware) | done |
| 8. Activity (JAW call history + decoded Base receipts + this device’s pending sends) | done · eligibility geo check, JAW subname: next |
| 9. Fork tests in CI, security review, legal review | — |
