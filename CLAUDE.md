# GreedyGoose

Next.js version notes: @AGENTS.md

An invest-and-earn app on Base. Cash earns in Aave V3 savings, the seven Coinbase tokenized stocks can be bought, sold
and traded, credit is USDC on Aave V4's Equities spoke backed by those stocks, and agents (Save, Entry, Protect,
Rebalance) act on-chain in GooseExecutor under permissions the user grants. Accounts are JAW passkey smart accounts.

## Read first

- @docs/SPEC.md is the product truth. It wins over this file and every other doc.
- @docs/ARCHITECTURE.md holds the layers and the code conventions.
- @docs/JUSTALAB-DECISIONS.md records why each rule exists. It wins over this file; SPEC.md wins over it.
- `contracts/docs/GooseExecutor-as-built.md` is the contract truth, `contracts/docs/DEPLOYMENTS.md` the deploy truth,
  `contracts/docs/MANAGER-NOTES.md` the facts about JAW's permission manager.
- `docs/archive/` is history. Never build from it.

## Hard rules

### Never guess

Never guess or invent contract addresses, ABIs, function names, reserve IDs, risk parameters, or JAW or Aave APIs.
Check the official docs (docs.jaw.id, aave.com/docs/aave-v4, github.com/aave/aave-v4, docs.base.org), then the deployed
contract. If a fact is still unclear, stop and say so. In docs and copy, never invent a feature or a status: check it in
the code, SPEC.md or the decisions log.

### Custody and keys

- Non-custodial. The app never holds keys or money. No seed phrases, no private-key inputs.
- No server and no database of ours (D12). Agents run on-chain in GooseExecutor and the app reads Base. The only server
  code is the stateless price route (`app/api/prices`). The runner (KeeperHub's wallet, outside this repo) only wakes
  the executor: it holds no money and sits in no permission (DEPLOYMENTS.md).
- JAW is the only wallet (`lib/jaw/config.ts`). Don't add MetaMask, WalletConnect, Coinbase Wallet or any other. The
  rehearsal's fork signer is for development only and never ships (`npm run rehearsal:check-build`).
- Agents act only under JAW permissions the user grants to GooseExecutor, approved and registered in the same batch as
  the change. Turning an agent off revokes its grants in one batch (`manager.revoke`), never through JAW's revoke sheet.
- Keys are never printed. `.env.local` and the deployer key stay private. Every `NEXT_PUBLIC_*` value ships in the
  page, so no secret goes in one.
- Never log signatures, keys or personal data (the lint allows no console logging in the app).
- Claude never moves real money. The owner signs every real step.

### Transaction safety

Every user write goes through `useTx` (`hooks/useTx.ts`), the one write path:

```text
build the batch from fresh reads → allowlist (lib/allowlist.ts, in each builder) → simulate on Base (eth_simulateV1,
with Aave's health read after) → JAW's sheet, one signature → wait for the receipt → re-read state
```

- One signature per change (D14 dropped, 2026-10-20). No screen sends a transaction another way, and there is no
  confirm screen of ours: JAW's sheet is the confirmation.
- Agent changes (grants, revokes, registrations, settings, any cash move first) are one batch through
  `useAgents.changePlan` (`lib/tx/plans/agents.ts`, `agentChangePlan`). Never a second sheet for a registration.
- Safari opens JAW's popup only inside the tap itself. Prepare the batch in render while the sheet shows
  (`useTx(…, plan)`, or `usePrepare(tx.prep, plan)` in a child), so the tap sends it with nothing awaited first.
- The allowlist checks every batch before it is simulated (`assertAllowed`). A new call shape gets its own narrow rule
  and tests there, never a looser one.
- Targets come only from the typed registries (`lib/aave/addresses.ts`, `lib/tokens/registry.ts`,
  `lib/protocols/config.ts`, `lib/swap/venues.ts`). Never from a URL, a query string, user input or a quote's response.
- Approvals are exact, never unlimited, and a repay sets the allowance back to 0 (SPEC.md › Money rules).
- Taking credit and freeing stock never end below 1.12 (`CREDIT_CAP.minHf`). For those batches, a simulated health
  under 1.10 stops them.
- Every spend from cash leaves the $0.50 fuel tank in the wallet (`CASH.feeBufferUsd`).
- No optimistic financial state. "Done" comes only after the batch lands and the state is read again.

### Swaps

- Venues only from `lib/swap/venues.ts` (Aerodrome Slipstream, Uniswap v3).
- Held to Aave's price in the batch itself (SPEC.md › Money rules). `BUY_LIMITS` (`lib/swap/buy.ts`) and
  `SELL_LIMITS` (`lib/swap/sell.ts`): 1% slippage, a warning 2% off Aave's price, a block 10% off it.
- Every swap is simulated first. A revert blocks it with a plain explanation.

### Market hours and pauses

- Stock prices are Chainlink 24/5 feeds. On weekends and holidays Aave holds the last price and interest keeps
  accruing. The Invest page says so (`components/ui/MarketBanner.tsx`).
- Taking credit on a weekend is allowed, because Aave allows it. The review says the price may move when markets reopen.
- Protect never sells while prices are held.
- A paused, frozen, capped or empty reserve disables the action and says why in plain words.

### Oracle

Aave's oracle is the only source for what stocks are worth as backing and for the credit available. A market price may
be shown for information, labelled as such, and never used for limits.

### Compliance

- Eligibility is a gate (D1): `lib/eligibility`, `NEXT_PUBLIC_ELIGIBILITY_MODE` = off | attest | geo+attest. The
  default rule is no US persons and sanctioned countries blocked; the geo check is still a hook. The stocks are Reg S,
  non-US only. Never market the app as a way around the issuer's restrictions.
- Never claim "no KYC", regulatory approval or "your shares". Tokenized stocks track the share price. They are not
  company shares, carry no voting rights and earn no yield, so no stock shows an APY. "Not company shares" appears
  once, on the stock sheet.
- Technical non-custody is not a regulatory exemption.

### Contracts

- GooseExecutor stays under 24,576 bytes (EIP-170). Check `forge build --sizes` after every change to it and record
  the size in GooseExecutor-as-built.md.
- Fork tests and on-chain suites run only through a keyless public RPC (`BASE_RPC_URL=https://mainnet.base.org`),
  never the app's Alchemy key.
- A new executor is a new spender, so every account grants its agents again. The next one must allow JAW's account
  clone (DEPLOYMENTS.md).
- Deploys are the owner's, each recorded in DEPLOYMENTS.md. A test deploy is capped at $5 (D13) and never goes in
  production config.
- B20 stock code can't run in Foundry. Fork tests use `ForkBase.sol`'s stand-ins (MANAGER-NOTES.md § 8).

### Git, checks and deploys

- Never push or deploy without the owner's OK. Push only to `origin` (hannibaluslab/greedygoose), never the `leo`
  remote.
- Run `npm run check` (lint, types, Prettier, knip, unit tests) before every commit. CI also runs `npm run build` and
  forge.
- Node 22 (`.nvmrc`).
- Focused commits, `type(scope): what changed, in plain words` (feat, fix, test, docs, chore, refactor). Stage only
  the paths you mean, never `.env.local`. Formatting-only commits go in `.git-blame-ignore-revs`.
- An approved screen never changes as a side effect. Big product calls are asked first.

## Words and errors

- The words are SPEC.md › Words. Never on screen: borrow, loan, lock, locked, unlock, collateral, room. Use credit,
  backs credit, free up, in use, cash. No em dashes, no colon joining two sentences, and a copy edit never makes a
  string longer.
- New code uses the product's words too. Aave's ABIs and the contracts keep their own names (ARCHITECTURE.md).
- Errors are plain words, with the technical detail apart. Never show `execution reverted` (`lib/aave/errors.ts`,
  `explainRevert`).

## Design

- The GreedyGoose canvases are the visual reference. The coded UI matches the boards, and a SPEC.md rule wins over a
  board.
- Tokens live in `app/globals.css` (ink `#0e0d0b`, ground `#f4f2ec`, lime `#d4ff3c`, the Safe, Watch and Act colours).
  Fonts are Geist and Geist Mono (`app/layout.tsx`).
- Build from the kit (`components/gg/kit/`): Button, AmountField, AssetPicker, SheetShell, Switch. Every picker is the
  AssetPicker. One stock order everywhere (`byStockOrder`).

## Facts on Base (re-verify on-chain before use)

- Addresses and reserve IDs live in the typed registries. `npm run verify:registry` checks them on Base. Reserves 0 to
  6 are the stocks (AAPLc to TSLAc, 8 decimals, B20) and 7 is USDC (6 decimals, the asset credit is taken in).
- Read every risk parameter on-chain and never hard-code one. Aave V4 counts one collateral factor per asset: read it
  from the spoke with the caps, rates and paused or frozen flags. An account's health comes from `getUserAccountData`.
- **Prices.** The spoke's oracle, 8 decimals (USD). Live Sunday 20:00 to Friday 20:00 ET, held on weekends and
  holidays.
- Splits and dividends change a stock's `uiMultiplier()`. Shares shown are raw × `uiMultiplier` ÷ 1e18
  (`lib/tokens/b20.ts`); do the maths in raw units.
- B20 stocks can have pauses and transfer policies, so every write is simulated first.

## Decisions

`docs/JUSTALAB-DECISIONS.md` holds every decision, its date and why. The ones an agent must never break, beyond the
rules above:

- **Thresholds** live in `config/risk.ts` only: Safe 1.5 and above, Watch 1.1 to 1.5, Act under 1.1.
- **Act is the line.** Act is a warning only. Ending in Watch asks for one tick.
- **Protect** acts only under 1.03: it repays from cash, then sells backing stock at once, back to 1.12. Protect,
  Rebalance and Save have no amount limit (their grants at the executor's `CAP_MAX`).
- **Network fees** are paid in USDC through JAW's `feeToken` (D4, `useFeeSupport`). Never silently require ETH, and
  never say "gasless" or "no fees".
- **Names** take their parent from `NEXT_PUBLIC_ENS_PARENT`, `justan.id` by default (D6).
- **Save and Receive are invisible** (D20): no agent row, switch or limit on screen. Their grants ride in Start
  earning and Turn into cash.

The code layout is in ARCHITECTURE.md, the environment in `.env.example`.
