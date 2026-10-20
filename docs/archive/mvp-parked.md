# Parked — do not build

> **Archived 2026-10-20.** Leo's MVP parked list. Several items in it are built now (the agents with Protect's selling and the Rebalancer, cash that earns, selling stocks, the Leaderboard). Don't follow it: [SPEC.md](../SPEC.md) says what the product is and what is still to build. See [README.md](README.md).

Everything here comes from the "Invest and Earn" brief (`docs/archive/original-ideas.md`) or the GreedyGoose design canvas. None of it is in the MVP. **Do not implement, scaffold or stub any of it** unless the user explicitly un-parks an item. Then move that item into `CLAUDE.md` with its decisions.

| Item | Why it's parked / what must be true first |
| --- | --- |
| Sell stocks in-app | Buying is live (Aerodrome / Uniswap). Selling needs the same routing in reverse plus a clear tax/realised-gain story; not asked for yet. |
| ETH / BTC (cbBTC) holdings and crypto-backed credit | A second Aave market and a second loan. Showing "one credit" over two separately collateralized loans hides risk. cbBTC custody risk must be disclosed. |
| Interest on cash as a product (USDC supplied to Aave) | A savings buffer exists for Guardian (D9). Marketing it as a yield product still needs legal review. |
| "Stocks earn yield" | False on the Equities Hub, where stocks are collateral-only. Only dividends exist, via `uiMultiplier`. Never claim this. |
| Protection agent: alerts | Guardian (feat/guardian) now covers the protection part by repaying from savings. Push/email alerts are still parked. |
| Protection agent: auto-sell | Needs Aave V4 "Repay with Supply" (CoW) enabled for equity reserves, an on-chain minimum price or oracle check (spend caps don't stop bad prices), weekend gap handling, and legal review (discretionary selling of securities). |
| Rebalancer agent / target mix | Discretionary portfolio management of securities. Regulated activity. |
| Auto buy, Auto top up (EIP-7702 on another wallet) | Needs trading and delegated permissions. |
| Auto receive, Quarantine, cross-chain routing | Asks for a swap permission at sign-up. Needs a backend and a routing provider. |
| Results, tax export | Needs an indexer and jurisdiction-specific tax logic. |
| Friends leaderboard | Gamifies investing. "Growth" rewards buying with credit. Everything is public on-chain anyway. |
| Earn via third-party vault (e.g. Superform SuperStocks: superNVDA) | Honest route to "stocks earn": a separate, disclosed product where the vault borrows USDC on the same Aave market and deploys it. Needs vault due diligence (mandate, venues, fees, unwind), clear leverage/liquidation-risk disclosure, legal review. Note it competes for the same capped Equities Hub borrow room. |
| App fee | No fee in the MVP. If one is added later, it must be explicit, shown before signing, and legally reviewed. |
| Gas sponsorship (paymaster) | The MVP has the user pay gas in USDC. Revisit with a budget cap. |
| Custom ENS parent (`*.greedygoose.eth`) | Needs JAW dashboard setup. The MVP uses `justan.id` via config. |
