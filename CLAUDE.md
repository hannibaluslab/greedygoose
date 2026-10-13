# GreedyGoose — borrow USDC against your tokenized stocks

Next.js version notes: @AGENTS.md

## Mission

A consumer app on **Base** that lets eligible users borrow **USDC** against their **Coinbase tokenized stocks**, using **JAW.id** smart accounts and the **Aave V4 Equities Hub**.

> Sign in with Face ID → see your stocks → use them as collateral → borrow USDC → repay → unlock your stocks.

We build the experience. We do not build a lending protocol, hold user funds, or run agents.

| Layer | Owner |
| --- | --- |
| Account, passkey, signing, batching, gas | JAW.id (`@jaw.id/wagmi`) |
| Lending, interest, collateral, liquidation, oracle | Aave V4 Equities Hub on Base |
| Collateral | Coinbase tokenized stocks (B20 tokens) |
| Borrowed asset | USDC on Base |
| Chain reads and transaction building | Wagmi + viem + TanStack Query |
| Custody | The user's JAW smart account |
| Experience | This app (Next.js, mobile-first) |

Anything not in the MVP scope below is **parked**. See `docs/PARKED.md`, and **do not build anything listed there** unless the user explicitly un-parks it.

---

## MVP scope

The MVP is done when a test JAW account on Base can do all of the following:

1. Sign up or sign in with a passkey (Face ID). A new user gets a name such as `sam.justan.id`.
2. See its supported stock balances, collateral, debt, available credit and status.
3. Supply a stock as collateral.
4. Borrow USDC.
5. Repay USDC: partial, full or max.
6. Withdraw collateral.
7. See every action in Activity, with a Base explorer link.
8. Recover cleanly from JAW, RPC, Aave and market-hours errors.

**In scope, from the product brief:**
- Safe / Watch / Act status.
- Debt shown on its own line.
- A borrow preview ("cost about $X a month", status before → after).
- Locked vs free amount per holding.
- JAW name.
- One-tap batched actions.

**Out of scope (parked):** selling stocks, crypto, cash yield, agents (Protection, Rebalancer), push or email alerts, auto top-up, auto receive, Quarantine, Results, Friends, application fees, any backend.

### Buy stocks with USDC (un-parked 2026-10-12)

Users can buy the 7 supported stocks with their USDC on Base, in one Face ID step (exact-amount approve + swap, batched).
- **Venues:** Aerodrome Slipstream (primary, ~$0.5–1.4M USDC per pool, tick spacing 10) and Uniswap v3 (thin, fallback). The app quotes both and uses the one giving more shares. Addresses live in `lib/swap/venues.ts`; never accept a router from anywhere else.
- **Guardrails (`BUY_LIMITS` in `lib/swap/buy.ts`):** 1% max slippage (`amountOutMinimum`), 10-minute deadline (Aerodrome), warn if the price is >2% over Aave's oracle price, block if >10%.
- **Every buy is simulated first** (`eth_simulateV1` via viem `simulateCalls`, approve + swap from the user's address). A revert blocks it with a plain explanation.
- **Weekends:** pools trade 24/7 but Aave's prices are frozen; show the "markets closed" warning on the buy sheet.
- **Eligibility:** issuer says Reg S, non-US only, and "integrators are responsible for applying applicable restrictions". The buy flow sits behind the same eligibility gate (D1).
- B20 transfer policy: all 7 tokens use policy ID 5 (sender/receiver/executor) on PolicyRegistry `0x8453…0002` — behaves like a blocklist; a fresh address passes. Verify the full registry address before adding an explicit `isAuthorized` pre-check.

### How users get stocks (MVP)

Buy them in-app with USDC (above), or bring your own: from another JAW app (the same account works across apps), or sent from any wallet to their address. The empty state offers "Buy stocks", and Receive shows the address.

---

## Decisions (settled — do not re-litigate)

| # | Decision |
| --- | --- |
| D1 | **Eligibility is a feature flag; markets are undecided.** The default rule is: no US persons, sanctioned countries blocked. Implement `lib/eligibility/` as a pluggable gate (geo check plus a self-attestation checkbox at sign-up) that can be switched or replaced without touching protocol code. Never market the app as a way around issuer restrictions. |
| D2 | **Use Aave's limits.** The app does not add its own borrow cap below Aave's. Max borrow and withdraw are whatever Aave allows. Safe / Watch / Act is display-only, derived from Aave's health factor using thresholds in `config/risk.ts`: Safe ≥ 1.5, Watch 1.1–1.5, Act < 1.1. Never hard-code them elsewhere. Any action that would end in Watch or Act needs an extra explicit confirmation. |
| D3 | **No alerts in the MVP.** The status shows in-app only. Protection alerts are parked, so there is no backend. |
| D4 | **The user pays gas, in USDC**, through JAW's `feeToken` capability. Read `wallet_getCapabilities` first. If USDC is not an accepted fee token on Base, the action is blocked with a clear message. Do not silently require ETH. Copy: "Network fee ≈ $0.0X, paid in USDC". Never say "gasless" or "no fees". |
| D5 | **Next.js (App Router), mobile-first web, installable to the home screen.** Primary target: iPhone Safari with passkeys. |
| D6 | **Name parent comes from config** (`NEXT_PUBLIC_ENS_PARENT`), defaulting to `justan.id`. JAW supports a custom parent after dashboard setup, so switch it later. |
| D7 | **Batch only what's honest.** Approve + supply can be one signature. Supply + borrow can be one signature only if the confirm screen lists both steps. Never batch in a way that hides an asset movement. |
| D8 | **Guardian (feat/guardian, 2026-10-13): one minimal backend.** A keeper holds a spender key whose powers are limited on-chain (see D10). It holds no user funds or keys, and its only call is `JustaPermissionManager.executeBatch`. This replaces "no backend" for Guardian only. |
| D9 | **Savings buffer in Aave V3 (un-parked for Guardian).** USDC supplied by the user to Aave V3 on Base. It's Guardian's only funding source. Show the variable rate; never call it "interest on cash" in marketing. |
| D10 | **GuardianChecker contract (needs audit before mainnet).** A stateless, immutable `ICallChecker` that pins arguments: withdraw to the account, approve only the spoke, repay reserve 7 for the account. Combined with a daily USDC cap. Not deployed until an independent audit; the app and keeper stay disabled until `NEXT_PUBLIC_GUARDIAN_CHECKER` is set. See `docs/guardian.md`. |

---

## Verified facts (2026-10-12) — re-verify on-chain before use

These came from primary sources (Base docs, Aave blog, aave-address-book PR #1569). They are starting points, not truth. On startup and in tests, check each address has code, the right decimals and the right symbol. **Read every risk parameter on-chain. Never hard-code one.**

- **Aave V4 Equities Hub on Base:** live since 2026-09-25.
  - Hub `0xa4d5947Eb727A052bae69C593FfC84247EC9864E`
  - MAG7 spoke `0x17905Db0e4A3514467539956c084180616AE7B8D`
  - Spoke oracle `0xaBaf048fD7675Ea34a84332371ffd5D55E322A47`
- **USDC (Base):** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **Stocks (8 decimals, B20, collateral-only):**

  | Symbol | Address |
  | --- | --- |
  | AAPLc | `0xb200000000000000000000C2e324d24d7eEcd1fb` |
  | AMZNc | `0xb200000000000000000000d9192b6B456483C2E8` |
  | GOOGLc | `0xb2000000000000000000002D0BA3164cc74f58B7` |
  | METAc | `0xb2000000000000000000008bC8786B856E61707C` |
  | MSFTc | `0xB200000000000000000000Ab99cFa739E253872B` |
  | NVDAc | `0xb20000000000000000000078ee7ce2fE4908108C` |
  | TSLAc | `0xb2000000000000000000001e800a7f5189430cD0` |

- **Reserve IDs (verified on-chain 2026-10-12 via `getReserve`):** 0 AAPLc, 1 AMZNc, 2 GOOGLc, 3 METAc, 4 MSFTc, 5 NVDAc, 6 TSLAc, 7 USDC (6 decimals, only borrowable reserve). `scripts/verify-registry.ts` re-checks this; the app refuses to send writes if it fails.
- **Spoke oracle:** `ORACLE()` = spoke oracle above; `getReservePrice(reserveId)`, 8 decimals (USD). Snapshot 2026-10-12: collateral factor AAPLc 78%, NVDAc 70%; max liquidation bonus 5.5%. Read live — `getDynamicReserveConfig(reserveId, reserve.dynamicConfigKey)`; a user's own position uses its own key, so use `getUserAccountData` for health.
- **ABIs:** generated with `forge inspect` from github.com/aave/aave-v4 @ `326751e` (ISpoke, IAaveOracle, IHubBase) into `lib/aave/abis/`.
- **Risk model:** Aave V4 uses one **collateral factor** per asset, not a separate LTV and liquidation threshold. Read it from the spoke, along with caps, rates and paused/frozen flags.
- **Holding is permissionless; mint and redeem are KYC'd.** B20 tokens can still have allowlist/blocklist policies and pauses. Exact pause/policy getter signatures are not yet confirmed (docs.base.org B20 `IB20`: `isPaused(feature)`, `policyId(scope)`), so **every write is simulated first**; a pause/policy revert blocks the action with a plain explanation. Add explicit pre-checks once signatures are verified.
- **Prices:** Chainlink 24/5 feeds, live Sunday 20:00 to Friday 20:00 ET. On weekends and holidays the last price is held, and **interest keeps accruing**.
- **Corporate actions:** splits and dividends change the token's `uiMultiplier()`. The Aave reserve and the feed pause until the update lands. Show balances with `balanceOfUI()`, and do maths in raw units.
- **Aave V4 "Repay with Supply"** exists (CoW Protocol). It is **parked** (Protection).

If a source contradicts this list, the on-chain state wins. Update this section and note the date.

---

## Hard rules

### Never guess
Never guess or invent contract addresses, ABIs, function names, reserve IDs, risk parameters, or JAW or Aave APIs. Check the official docs (docs.jaw.id, aave.com/docs/aave-v4, github.com/aave/aave-v4, docs.base.org), then the deployed contract. If a fact is still unclear, stop and say so.

### Custody and keys
- Non-custodial. No backend, no server-held keys, no seed phrases, no private-key inputs.
- JAW is the only wallet. Do not add MetaMask, WalletConnect, Coinbase Wallet or any other wallet.
- No ERC-7715 / JAW permissions granted to us in the MVP. Every action is signed by the user, at the time it happens.

### Transaction safety
Every write follows this sequence:

```text
validate input → read current state → build call from allowlisted ABI
→ verify chainId, target, selector, token, amount, spender, recipient, value
→ simulate → show confirm screen → JAW signs → wait for receipt → re-read state → render
```

- Targets come only from the typed registry in `lib/aave/addresses.ts` and `lib/tokens/registry.ts`. Never from a URL, query string or user input.
- If anything differs from what the confirm screen shows, **block the transaction**.
- No unlimited approvals. Approve the exact amount, or use permit where supported.
- No optimistic financial state. Balances change only after the receipt arrives and state is re-read.

### Market hours and pauses
- Show a quiet banner when stock prices are frozen: "Markets closed — stock prices update Sunday 8pm ET. Interest still accrues."
- Borrowing on the weekend is allowed, because Aave allows it. The confirm screen must say the price may move when markets reopen.
- If a reserve is paused, frozen, capped or out of liquidity, disable the action and say why in plain words.

### Oracle
Aave's oracle is the only source for collateral value and available credit. A market price may be shown for information, labelled as such, and never used for limits.

### Compliance
- Never claim "no KYC", regulatory approval, or "your shares". Tokenized stocks track the share price; they are not company shares and carry no voting rights. Say so on the confirm screen.
- Technical non-custody is not a regulatory exemption.

---

## Product and copy

**Navigation:** Home · Credit · Activity · Settings. Receive opens from Home.

| Screen | Shows |
| --- | --- |
| Welcome | Logo, honest headline, "Create account with Face ID", "Sign in with your JAW account" |
| Home | Name and avatar; total stock value; **"You owe $X"** on its own line with its monthly cost; status pill; holdings with **locked / free** |
| Credit | Debt, Safe/Watch/Act bar, cost per month, credit available, Repay and Borrow |
| Use as collateral | Pick a stock, enter an amount, see the credit it adds, confirm |
| Borrow | Amount, max, "about $X a month at Y% (variable)", status before → after, confirm |
| Repay | Chips ($100 / $X / Max), "You owe after", confirm |
| Unlock stock | Withdraw collateral; disabled with a reason if Aave would reject it |
| Activity | Supply, borrow, repay, withdraw; status; Base explorer link |
| Settings | Name, address, network ("Base"), passkey/security, eligibility, legal links |

**Copy rules:**
- Plain words, amounts in dollars. No Aave, spoke, reserve, gas or token jargon on main screens. Technical details go behind "Details".
- Prefer: "Borrow USDC", "Credit available", "Your collateral", "Locked / Free", "You owe".
- The health factor appears only in Details ("Health factor 1.82").
- Every button names its action: "Borrow $300 with Face ID", never "Continue".
- Always show the rate and the monthly cost. Never write "max leverage", use fake urgency, or animate borrowing like a game.
- Errors in plain language, with technical details available separately. For example: "This would put your loan past what Aave allows," not `execution reverted`.

### Design system (from the GreedyGoose canvas)

Source: claude.ai design canvas "GreedyGoose: iPhone Wireframes", Core screens page. Use the **look**, not the feature set. The canvas shows parked features (Credit Buy, Trade, Agents, Friends, BTC, cash yield, Quarantine). Do not build those.

- **Fonts:** Geist (UI) and Geist Mono (small uppercase labels, letter-spacing 0.08–0.1em). Use tabular numbers for money.
- **Colors (`:root` tokens):**
  - ink `#0e0d0b`, ink-2 `#2c2a25`
  - muted `#5a564e`, subtle `#8a8479`
  - ground `#f4f2ec`, card `#ffffff`, on-ink `#f5f0e2`
  - accent lime `#d4ff3c` (primary CTA, glow `rgba(212,255,60,.32)`)
  - safe `#1f6a4a` on `#d6e7dc`; watch `#d9a441` with text `#8a6a1f`; act `#8e2a1d`
  - hairline `rgba(14,13,11,.09)`
- **Shape:** cards with 22px radius and soft shadow; pill buttons 52–56px tall; bottom sheets with 28px top radius; touch targets ≥ 44px.
- **Status:** a pill and a three-segment bar (Safe / Watch / Act) with a marker. The label is always shown, so colour is never the only signal.
- **Fix from the canvas:**
  - Change the Welcome headline. "Your stocks keep earning" is false, because stocks are collateral-only with no yield. Use "Your stocks. Your liquidity." with "Borrow USDC against your tokenized stocks without selling them."
  - Replace the canvas's `role="button"` spans with real `<button>`s.

---

## Engineering

- **Stack:** Next.js (App Router), TypeScript strict, Tailwind with the tokens above, Wagmi, viem, TanStack Query, `@jaw.id/wagmi`. Use npm.
- **JAW connector:** `jaw({ apiKey, appName, appLogoUrl, defaultChainId: 8453, ens })`. Use `useCapabilities` before relying on batching or `feeToken`. Check docs.jaw.id/wagmi for the current API before writing code.
- **Reads:** use multicall, refresh based on blocks, re-read everything after each receipt, and show skeletons while loading.
- **Wallet states to handle:** unauthenticated, authenticating, connected, wrong chain, disconnected or reconnecting, signing, pending, confirmed, rejected, failed, replaced or dropped.
- **Tests:**
  - Vitest for maths, validation and status thresholds.
  - Base mainnet fork (anvil) for supply, borrow, repay and withdraw against the real Equities Hub.
  - Playwright for flows.
  - Must cover: no stocks, one stock, many stocks, near-limit borrow, partial and full repay, withdraw blocked, reserve paused, cap reached, no USDC liquidity, weekend frozen price, `feeToken` unavailable, user rejects, revert, RPC down.
- **Security:**
  - CSP headers.
  - Every `NEXT_PUBLIC_*` value is public, so no secrets in it.
  - Never log signatures or personal data.
  - Run a dependency audit in CI.

### Repository layout

```text
app/            (marketing)/  home/  credit/  collateral/  activity/  settings/  receive/
components/     ui/  wallet/  credit/  holdings/  risk/  tx/
lib/jaw/        config.ts  capabilities.ts
lib/aave/       addresses.ts  abis.ts  spoke.ts  positions.ts  reserves.ts  tx.ts
lib/tokens/     registry.ts  b20.ts (pause / isAuthorized / uiMultiplier)
lib/eligibility/
lib/market-hours/
config/         risk.ts
tests/          unit/  fork/  e2e/
docs/           PARKED.md  archive/
```

### Environment

```env
NEXT_PUBLIC_APP_NAME=GreedyGoose
NEXT_PUBLIC_APP_LOGO_URL=
NEXT_PUBLIC_JAW_API_KEY=
NEXT_PUBLIC_ENS_PARENT=justan.id
NEXT_PUBLIC_BASE_RPC_URL=
NEXT_PUBLIC_ELIGIBILITY_MODE=geo+attest   # off | attest | geo+attest
```

Addresses live in the typed registry, not in env.

### Build order

1. Scaffold: Next.js, Tailwind tokens, Wagmi + JAW connector on Base.
2. Registry and on-chain verification of every address (code, decimals, symbol).
3. Read-only: balances, spoke config, position, health factor, status, market hours.
4. Home and Credit from real chain data. **No mock numbers in the app.**
5. Supply collateral (approve + supply).
6. Borrow, with preview.
7. Repay and withdraw.
8. Activity, errors, eligibility gate, polish, accessibility (WCAG AA).
9. Fork tests in CI, then a security review, then legal review before any public launch.
