# GreedyGoose

Next.js version notes: @AGENTS.md

An invest-and-earn app on Base. Cash earns in Aave V3 savings, the seven Coinbase tokenized stocks can be bought, sold
and traded, credit is USDC on Aave V4's Equities spoke backed by those stocks, and agents (Save, Entry, Protect,
Rebalance) act on-chain through GooseGuard, the one contract that moves money and the spender of every permission the
user grants, planned by GoosePlanner's read-only views. Accounts are JAW passkey smart accounts. Neither is deployed
yet: production still runs the agents on GooseExecutor `0x686c…F02D` (since 2026-10-20, Adrian's go; no amount cap, not
audited yet, `contracts/docs/DEPLOYMENTS.md`) until the Guard's release. The Leaderboard is live too, on GooseBoard
`0x0E10…FcA1`. Both come from build flags: a build without `NEXT_PUBLIC_GOOSE_GUARD`, `NEXT_PUBLIC_GOOSE_PLANNER` and
`NEXT_PUBLIC_AGENTS_LIVE=1` (`lib/agents/config.ts`) shows the agents as Coming soon, and one without
`NEXT_PUBLIC_GOOSE_BOARD` shows the board as opens soon. Mobile-first web,
installable to the home screen, with iPhone Safari and passkeys as the primary target (D5, `app/manifest.ts`).

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
- No server and no database of ours (D12). Agents run on-chain in GooseGuard and the app reads Base. The only server
  code is the stateless price route (`app/api/prices`). The runners (KeeperHub's wallet, outside this repo, the
  account itself, or one runner it picks) only send the Guard moves to check: they hold no money and sit in no
  permission (DEPLOYMENTS.md).
- JAW is the only wallet (`lib/jaw/config.ts`). Don't add MetaMask, WalletConnect, Coinbase Wallet or any other. The
  rehearsal's fork signer is for development only and never ships (`npm run rehearsal:check-build`).
- Agents act only under JAW permissions the user grants to GooseGuard, approved and registered (`register(job,
  permission)`, by the account itself) in the same batch as the change. Turning an agent off revokes its grants and
  unregisters it in one batch (`manager.revoke`, `unregister`), never through JAW's revoke sheet.
- Keys are never printed. `.env.local` and the deployer key stay private. Every `NEXT_PUBLIC_*` value ships in the
  page, so no secret goes in one.
- Never log signatures, keys or personal data. The app's lint refuses `console.log`; only `console.warn` and
  `console.error` pass (`eslint.config.mjs`).
- Claude never moves real money. The owner signs every real step.

### Transaction safety

Every user write goes through `useTx` (`hooks/useTx.ts`), the one write path:

```text
build the batch from fresh reads → allowlist (lib/allowlist.ts, in each builder) → simulate on Base (eth_simulateV1;
a batch that takes credit or frees stock also reads Aave's health after) → JAW's sheet, one signature → wait for the
receipt → re-read state
```

- One signature per change (D14 dropped, 2026-10-20). No screen sends a transaction another way, and there is no
  confirm screen of ours: JAW's sheet is the confirmation.
- Agent changes (grants, revokes, registrations, settings, any cash move first) are one batch through
  `useAgents.changePlan` (`lib/tx/plans/agents.ts`, `agentChangePlan`). Never a second sheet for a registration.
- Safari opens JAW's popup only inside the tap itself. Prepare the batch in render while the sheet shows
  (`useTx(…, plan)`, or `usePrepare(tx.prep, plan)` in a child), so the tap sends it with nothing awaited first.
- The allowlist checks every batch before it is simulated (`assertAllowed`). It pins each target, function and
  argument, so money moves only between the user's own pockets. The one exception is a Send's single transfer to the
  recipient its batch declares. A new call shape gets its own narrow rule and tests there, never a looser one.
- A batch is keyed by every input that shapes it (`txKey`, `lib/tx/prepared.ts`). One prepared for some inputs is never
  signed for others. JAW signs on Base only (`CHAIN_ID`).
- Batch only what's honest (D7). A batch never hides an asset movement. JAW's sheet lists every call, and Buy, Sell,
  Trade, Send, Repay, Credit Buy and Earn with stocks name every move in their small print.
- Targets come only from the typed registries (`lib/aave/addresses.ts`, `lib/tokens/registry.ts`,
  `lib/protocols/config.ts`, `lib/swap/venues.ts`). Never from a URL, a query string, user input or a quote's response.
  GooseGuard, GoosePlanner and GooseBoard are the exceptions: each comes from its `NEXT_PUBLIC_*` setting, checked as an address
  (`lib/agents/config.ts`, `lib/board/config.ts`).
- Approvals are exact, never unlimited, and a repay sets the allowance back to 0 (SPEC.md › Money rules).
- Taking credit and freeing stock never end below the position's line (`config/risk.ts` `CreditLine`, `lineOf`):
  1.12 (`ACT_LINE`), a simulated health under 1.10 stopping the batch; once Greedy Fatalities is open, 1.05 with
  Protector on (stop 1.03) or Aave's 1.0 with it off (as much as Aave lends), ending in Act only with the tick.
- Every spend from cash leaves the $0.50 fuel tank in the wallet (`CASH.feeBufferUsd`).
- No optimistic financial state. "Done" comes only after the batch lands and the state is read again.

### Swaps

- Venues only from `lib/swap/venues.ts`. Stocks trade on Aerodrome Slipstream and Uniswap v3. Each cash coin has its
  own venue and pool (`lib/tokens/stables.ts`).
- Held to Aave's price in the batch itself (SPEC.md › Money rules). `BUY_LIMITS` (`lib/swap/buy.ts`) and
  `SELL_LIMITS` (`lib/swap/sell.ts`): 1% slippage, a 10-minute deadline, a warning 2% off Aave's price, a block 10% off
  it.
- Every swap is simulated first. A revert blocks it with a plain explanation.

### Market hours and pauses

- Stock prices are Chainlink 24/5 feeds. On weekends and holidays Aave holds the last price and interest keeps
  accruing. The Invest page says so (`components/ui/MarketBanner.tsx`).
- Buying, selling, trading and taking credit on a weekend are allowed, because the pools trade and Aave allows it. Each
  of those screens says the price can jump when markets reopen.
- The agents act at weekends too, whenever Aave and GooseGuard's 1% price check allow (decision 7, 2026-10-22). No
  line may say they stop then; the weekend card only says Aave's stock prices pause.
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
  the size in GooseExecutor-as-built.md. Read GooseExecutor's row: the command always exits 1, because the test-only
  `ExecutorHarness` is over the limit.
- Fork tests and on-chain suites run only through a keyless public RPC (`BASE_RPC_URL=https://mainnet.base.org`),
  never the app's Alchemy key.
- A new executor is a new spender, so every account grants its agents again. The next one must allow JAW's account
  clone (DEPLOYMENTS.md).
- Deploys are the owner's, each recorded in DEPLOYMENTS.md. There is no amount limit anywhere, the live test included
  (decision 9, 2026-10-22, which replaces D13's $5 cap): every agent allowance is the largest a JAW spend holds
  (`NO_LIMIT`), and how much anyone puts in is their own choice.
- B20 stock code can't run in Foundry. Fork tests use the stand-ins in `contracts/test/ForkBase.sol` (MANAGER-NOTES.md
  § 8).

### Git, checks and deploys

- Never push or deploy without the owner's OK. Push only to `origin` (hannibaluslab/greedygoose), never the `leo`
  remote. Production is released with `scripts/release.sh <commit on main>` (contracts/docs/DEPLOYMENTS.md, "Live now").
- Run `npm run check` (lint, types, Prettier, knip, unit tests) before every commit. CI also runs `npm run build` and
  forge.
- Node 22 (`.nvmrc`) and npm (`package-lock.json`).
- Focused commits, `type(scope): what changed, in plain words` (feat, fix, test, docs, chore, refactor). Stage only
  the paths you mean, never `.env.local`. Formatting-only commits go in `.git-blame-ignore-revs`.
- An approved screen never changes as a side effect. Big product calls are asked first.

## Words and errors

- The words are SPEC.md › Words. Never on screen: borrow, loan, lock, locked, unlock, collateral, room, protocol names
  in instructions. Use credit, backs credit, free up, in use, cash. No em dashes, no colon joining two sentences, and a
  copy edit never makes a string longer.
- Credit always shows its rate and its monthly cost (Home's Credit card, the Repay sheet). Never write "max leverage"
  and never use fake urgency.
- New code uses the product's words too. Aave's ABIs and the contracts keep their own names (ARCHITECTURE.md).
- Errors are plain words, with the technical detail apart. Never show `execution reverted` (`lib/aave/errors.ts`,
  `explainRevert`).

## Design

- The GreedyGoose canvases are the visual reference. The coded UI matches the boards, and a SPEC.md rule wins over a
  board.
- Tokens live in `app/globals.css` (ink `#0e0d0b`, ground `#f4f2ec`, lime `#d4ff3c`, the Safe, Watch and Act colours).
  Fonts are Geist and Geist Mono (`app/layout.tsx`).
- Light and dark (`lib/theme.ts`): the dark tokens are the booth app's look, under `[data-theme="dark"]`. Use tokens,
  never a colour literal: an ink tint is `ink/8`, not `rgba(14,13,11,0.08)`, so it flips. JAW's sheet follows the theme
  (`jawThemeFor`, `ThemeSync`).
- Build from the kit (`components/gg/kit/`): Button, AmountField, AssetPicker, SheetShell, Switch. Every picker is the
  AssetPicker. One stock order everywhere (`byStockOrder`).
- The status always shows its label (Safe, Watch, Act), so colour is never the only signal. Real `<button>`s, never
  `role="button"` spans, and touch targets of at least 44px.
- No mock numbers on real screens. The dev gallery's fixtures (`app/dev`) are a 404 in production.

## Facts on Base (re-verify on-chain before use)

- Addresses and reserve IDs live in the typed registries. `npm run verify:registry` checks them on Base. Reserves 0 to
  6 are the stocks (AAPLc to TSLAc, 8 decimals, B20) and 7 is USDC (6 decimals, the asset credit is taken in).
- Read every risk parameter on-chain and never hard-code one. Aave V4 counts one collateral factor per asset: read it
  from the spoke with the caps, rates and paused or frozen flags. An account's health comes from `getUserAccountData`.
- **Prices.** The spoke's oracle, 8 decimals (USD). Live Sunday 20:00 to Friday 20:00 ET, held on weekends and
  holidays.
- Splits and dividends change a stock's `uiMultiplier()`. Shares shown are raw × `uiMultiplier` ÷ 1e18
  (`lib/tokens/b20.ts`); do the maths in raw units.
- B20 stocks can have pauses and transfer policies, so every write is simulated first. All seven used transfer policy
  ID 5 on B20's PolicyRegistry (`0x8453…0002`), which acts like a blocklist, so a fresh address passes (read
  2026-10-12). Verify the full registry address before adding an `isAuthorized` pre-check.
- If a source contradicts these facts, the on-chain state wins. Update this section and note the date.

## Decisions

`docs/JUSTALAB-DECISIONS.md` holds every decision, its date and why. The ones an agent must never break, beyond the
rules above:

- **Thresholds** live in `config/risk.ts` only (D2): Safe 1.5 and above, Watch 1.1 to 1.5, Act under 1.1.
- **Act is the line.** Act is a warning only. Ending in Watch asks for one tick (D2's extra confirmation).
- **Protect** acts only under 1.03: it repays from cash, then sells backing stock at once, back to 1.12 (the account's
  own line and target once it sets them, decision 3). No agent has an amount limit (decision 9: every grant's
  allowance is `NO_LIMIT`, `lib/agents/permissions.ts`).
- **Network fees** are paid in USDC through JAW's `feeToken` (D4, `useFeeSupport`). When USDC can't pay the fee, the
  action is blocked with a plain message. Never silently require ETH, and never say "gasless" or "no fees".
- **Names** take their parent from `NEXT_PUBLIC_ENS_PARENT`, `justan.id` by default (D6).
- **Save and Receive are invisible** (D20): no agent row, switch or limit on screen. Once the agents are live, their
  grants ride in Start earning and Turn into cash.

The code layout is in ARCHITECTURE.md, the environment in `.env.example`.
