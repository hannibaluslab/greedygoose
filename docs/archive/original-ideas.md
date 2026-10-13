```
# Stock-backed USDC Consumer App

## 0. Mission

Build a polished, production-quality consumer fintech application that lets eligible users use supported Coinbase tokenized equities on Base as collateral and borrow USDC through the existing Aave V4 Equities Hub.

The product is a **consumer interface and integration layer**, not a new lending protocol.

The intended user experience is:

> Connect with JAW â†’ see your tokenized stocks â†’ use them as collateral â†’ borrow USDC â†’ repay â†’ unlock collateral.

The application must be non-custodial.

### Core protocol stack

- Wallet/account layer: **JAW.id**
- Wallet integration: `@jaw.id/wagmi`
- React/EVM integration: Wagmi + viem
- Chain: **Base**
- Lending protocol: **Aave V4**
- Collateral: supported Coinbase tokenized equities
- Borrow asset: **USDC**
- Custody: user's JAW smart account
- Application: our consumer UX/interface

Do not build a separate lending pool.

Do not onboard a separate class of USDC lenders.

Do not custody user assets.

---

# 1. Product concept

The app should feel like a simple stock-backed credit product rather than a DeFi dashboard.

The user should not need to understand:

- Aave reserve mechanics
- liquidity providers
- lending pools
- reserve factors
- debt tokens
- protocol spokes
- smart-account implementation details

The user should understand:

> I have tokenized stocks.
>
> I can borrow USDC against them.
>
> I can repay the USDC later.
>
> If my collateral falls too far, my position can be liquidated.

### Primary consumer flow

```text
JAW account
    â†“
Connect / authenticate
    â†“
Base
    â†“
Read tokenized stock balances
    â†“
Read Aave position
    â†“
Calculate available credit
    â†“
Supply stock collateral
    â†“
Borrow USDC
    â†“
Manage position
    â†“
Repay USDC
    â†“
Withdraw collateral
```

---

# 2. Critical architecture

The intended architecture is:

```text
                    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                    â”‚      Consumer       â”‚
                    â”‚        App          â”‚
                    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                               â”‚
                         JAW.id wallet
                               â”‚
                               â–¼
                    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                    â”‚   User's JAW Smart  â”‚
                    â”‚       Account       â”‚
                    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                               â”‚
                               â–¼
                         Base Mainnet
                               â”‚
                  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                  â”‚                         â”‚
                  â–¼                         â–¼
          Coinbase Tokenized          Aave V4
              Equities             Equities Hub
                  â”‚                         â”‚
                  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                             â”‚
                             â–¼
                            USDC
```

### Do not create this:

```text
User
 â†“
Our custody wallet
 â†“
Our lending pool
 â†“
Aave
```

The application should not take custody.

---

# 3. JAW.id is the wallet standard

**JAW.id is mandatory for the wallet/account experience.**

Do not add MetaMask, Rainbow, Coinbase Wallet, WalletConnect, or another wallet provider unless explicitly requested later.

JAW provides smart accounts, passkey authentication, programmable permissions, EIP-1193 provider behavior, Wagmi integration, and capabilities such as atomic transactions and gasless transactions where configured.

Official documentation:

- https://jaw.id/
- https://docs.jaw.id/
- https://docs.jaw.id/configuration
- https://docs.jaw.id/api-reference

### Recommended integration

Use the official JAW Wagmi connector:

```ts
import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { jaw } from "@jaw.id/wagmi";

export const config = createConfig({
  chains: [base],
  connectors: [
    jaw({
      apiKey: process.env.NEXT_PUBLIC_JAW_API_KEY,
      appName: process.env.NEXT_PUBLIC_APP_NAME,
      appLogoUrl: process.env.NEXT_PUBLIC_APP_LOGO_URL,
      defaultChainId: base.id,
    }),
  ],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
  },
});
```

The exact current JAW API must always be checked against the official JAW documentation before implementation.

Do not guess JAW APIs.

### JAW requirements

The application must:

- use JAW for account creation/authentication;
- use JAW for transaction signing;
- use JAW as the user's smart-account layer;
- support passkey authentication;
- support Base;
- detect account changes;
- detect chain changes;
- handle disconnect/reconnect;
- handle transaction rejection;
- handle JAW capability errors;
- use JAW's supported atomic transaction functionality when it materially improves UX;
- consider JAW gas sponsorship/paymaster support where appropriate and legally/product-wise suitable.

JAW documents EIP-1193-compatible provider behavior and Wagmi integration. Treat the JAW connector as the source of wallet interaction, while viem/Wagmi remain responsible for blockchain reads and application-level transaction preparation.

---

# 4. Wallet UX

The primary CTA is:

> Get started

not:

> Connect Wallet

Because the intended user experience is a JAW smart account/passkey experience.

Suggested flow:

```text
Get started
     â†“
JAW authentication
     â†“
Smart account created / restored
     â†“
Base selected
     â†“
Dashboard
```

### Wallet states

Implement:

- unauthenticated
- authenticating
- authenticated
- account available
- account unavailable
- wrong chain
- chain switching
- disconnected
- reconnecting
- transaction signing
- transaction pending
- transaction confirmed
- transaction rejected
- transaction failed

Never expose seed phrases.

Never ask the user to paste a private key.

Never ask the user for a private key.

---

# 5. JAW capabilities

Before relying on an advanced capability, query JAW wallet capabilities.

Relevant JAW capabilities include:

- atomic transaction execution
- paymaster/gasless transaction support
- permissions
- fee-token support

Do not assume a capability exists.

Query the connected account's capabilities and gracefully fall back when a capability is unavailable.

### Atomic transactions

If JAW + Aave support allows multiple required operations to be safely bundled, consider bundling flows such as:

```text
Approve / permit
+
Supply
+
Borrow
```

However:

- never force batching when it makes the transaction harder to understand;
- never hide asset movement;
- show exactly what the user is authorizing;
- only use atomic execution after verifying the current JAW and Aave interfaces.

Security and transparency are more important than reducing one click.

---

# 6. Consumer product

The primary dashboard should show:

```text
Your portfolio

$250,000

Available credit

$125,000 USDC

Borrowed

$25,000 USDC

Position health

Healthy
```

Primary CTA:

> Borrow USDC

Secondary CTA:

> Manage collateral

### Navigation

- Home
- Portfolio
- Borrow
- Activity
- Settings

Do not expose a USDC lender dashboard.

Do not expose generic Aave lending markets.

Do not make the application look like a protocol explorer.

---

# 7. Current Aave market

As of the current product specification, Aave's Equities Hub on Base supports Coinbase tokenized equities as collateral and USDC as the borrowable asset.

Initial supported equity tokens:

- AAPLc
- AMZNc
- GOOGLc
- METAc
- MSFTc
- NVDAc
- TSLAc

The exact deployed addresses must be resolved from authoritative current Aave/Coinbase sources.

Never identify an asset by symbol alone.

Always use:

```text
chain ID + verified contract address
```

### Sources

- Aave tokenized stocks announcement:
  https://www.aave.com/blog/coinbase-tokenized-stocks
- Aave V4 documentation:
  https://www.aave.com/docs/aave-v4
- Aave V4 Solidity integration:
  https://www.aave.com/docs/aave-v4/getting-started/solidity
- Aave V4 repository:
  https://github.com/aave/aave-v4
- Aave governance:
  https://governance.aave.com/

These sources are references, not permission to hard-code stale values.

---

# 8. Aave integration rules

We are integrating with Aave V4.

We are NOT recreating Aave.

Do not implement:

- our own lending pool;
- our own interest-rate model;
- our own debt accounting;
- our own liquidation engine;
- our own collateral accounting;
- our own oracle for credit decisions.

Use Aave's deployed contracts and official interfaces.

### Never guess Aave

When any of the following are unclear:

- contract address
- ABI
- function name
- function parameters
- reserve configuration
- collateral factor
- liquidation threshold
- supply cap
- borrow cap
- interest rate
- oracle
- deployment

STOP and inspect the current authoritative Aave source/deployment.

Do not use model memory.

Do not copy an old GitHub snippet without checking the deployed version.

---

# 9. Read architecture

Blockchain state is authoritative.

Use:

- viem
- Wagmi
- TanStack Query
- Aave official interfaces/ABIs
- JAW only where wallet-specific capabilities are required

Read:

- wallet address
- supported token balances
- Aave collateral positions
- USDC debt
- health factor
- borrowing capacity
- reserve state
- market configuration
- caps
- rates
- asset availability

Use multicall/batched reads where appropriate.

Cache safely, but re-read after every successful transaction.

---

# 10. Transaction architecture

Transaction flow must be:

```text
UI
 â†“
Validate user input
 â†“
Read current protocol state
 â†“
Prepare exact Aave transaction
 â†“
Simulate when practical
 â†“
Verify target + calldata + value
 â†“
JAW confirmation
 â†“
Submit
 â†“
Wait for receipt
 â†“
Re-read chain state
 â†“
Update UI
```

Never sign arbitrary calldata.

Never accept a contract target directly from URL query parameters.

Never allow an unverified contract address into a transaction path.

---

# 11. Collateral supply

For supplying stock collateral:

1. Detect supported stock balance.
2. Confirm token address.
3. Read current allowance/permit state.
4. Read current Aave reserve state.
5. Validate supply cap.
6. Validate asset availability.
7. Prepare the supply transaction.
8. Simulate where practical.
9. Ask JAW to sign.
10. Wait for confirmation.
11. Re-read position.
12. Update dashboard.

The user must see:

```text
You are supplying

10.00 NVDAc

Estimated value

$1,850.00

Collateral use

Enabled
```

---

# 12. Borrowing USDC

For borrowing:

1. Read collateral.
2. Read existing debt.
3. Read current available borrowing capacity.
4. Read current USDC liquidity.
5. Read current borrow rate.
6. Calculate the proposed post-borrow health factor using current protocol state.
7. Validate against protocol constraints.
8. Show the user the resulting position.
9. Prepare the Aave borrow transaction.
10. Simulate where practical.
11. JAW signs.
12. Wait for receipt.
13. Refresh all position data.

### Confirmation screen

Before signing:

```text
Borrow

$25,000 USDC

Collateral
$100,000 NVDAc

Current debt
$0

New debt
$25,000

Estimated health
1.XX

Borrow rate
X.XX%

[Confirm borrow]
```

Never hide interest-rate information.

---

# 13. Repayment

Repayment flow:

```text
USDC balance
+
outstanding debt
â†“
repay amount
â†“
JAW authorization
â†“
Aave repay
â†“
refresh debt
```

Support:

- partial repayment
- full repayment
- max repayment

Handle token allowance/permit requirements safely.

Do not assume the user's USDC balance equals the exact debt due to accrued interest.

Read the current on-chain debt.

---

# 14. Collateral withdrawal

Allow withdrawal only when the resulting position remains valid according to Aave.

Before signing:

```text
Collateral before
$100,000

Collateral after
$75,000

Debt
$25,000

Resulting health
1.XX
```

If withdrawal would violate protocol constraints, disable it and explain why.

Never rely only on frontend calculations.

---

# 15. Risk UX

This is a financial application.

Risk is a first-class product feature.

Always expose:

- collateral value
- debt
- available credit
- health factor
- liquidation threshold / relevant risk metric
- current borrow rate
- utilization where useful
- liquidation proximity
- supported collateral assets

Use simple language.

### States

Healthy:

> Your position is healthy.

Warning:

> Your position is approaching liquidation.

Critical:

> Your position is at high liquidation risk.

Never use:

- casino-style animations
- â€œmaximum leverageâ€ marketing
- gamification of borrowing
- fake urgency

---

# 16. Dynamic protocol parameters

Never hard-code:

- LTV
- liquidation threshold
- liquidation bonus
- supply cap
- borrow cap
- interest rate
- reserve factor
- oracle price
- market liquidity

Read current protocol state.

If a market is:

- paused
- frozen
- capped
- unavailable
- lacking liquidity

disable the relevant action.

Explain the reason.

---

# 17. Oracle rules

Do not create a second credit-pricing oracle.

Aave's protocol oracle/risk configuration is authoritative for protocol transactions.

Display-only price data may come from another source, but it must never override Aave's collateral valuation.

If display data differs from Aave's value:

> â€œMarket price data may differ from the protocol's collateral valuation.â€

Do not silently present an external price as the borrowable collateral value.

---

# 18. Market hours and stale pricing

Tokenized equities may follow equity-market pricing/feed availability.

The UI must handle:

- weekends
- U.S. market holidays
- market open
- market closed
- stale-but-valid feed state
- unavailable feed
- protocol pause

Do not imply that tokenized stock prices are continuously equivalent to live exchange trading prices.

---

# 19. JAW + Base

Base is the primary and initial supported network.

Do not launch multi-chain support in MVP.

Configure JAW for Base.

Example chain ID:

```text
8453
```

Verify the current JAW and Base configuration before implementation.

The application should display:

> Base

not:

> Chain 8453

unless the user opens technical details.

---

# 20. JAW transaction UX

JAW transaction signing is part of the product experience.

The user should understand:

```text
Approve stock
Supply collateral
Borrow USDC
```

or, if safely batched:

```text
Supply collateral + borrow USDC
```

Do not hide transactions inside generic:

> â€œContinueâ€

buttons.

Use explicit verbs.

---

# 21. Gas UX

JAW supports smart-account capabilities including gasless/paymaster functionality where configured.

Do not promise:

> â€œGaslessâ€

unless the connected account and current app configuration actually support it.

If gas is sponsored:

> Network fee covered

If the user must pay gas:

> Network fee applies

Do not display confusing native-token requirements if JAW abstracts them away.

---

# 22. No unnecessary backend

Preferred architecture:

```text
Next.js
  â†“
JAW
  â†“
Wagmi / viem
  â†“
Aave V4
  â†“
Base
```

Do not create a backend simply to proxy blockchain calls.

A backend may be used for:

- analytics
- market metadata
- feature flags
- observability
- notifications
- cached non-authoritative data

The backend must never custody keys.

---

# 23. Authentication

JAW is the account/authentication layer.

If application-level authentication is needed, use a wallet-based authentication mechanism such as SIWE with JAW.

Do not create:

- passwords
- seed phrases
- custodial login credentials

Do not equate JAW authentication with regulatory KYC.

---

# 24. KYC / compliance

Do NOT build the product around the claim:

> â€œNo KYC.â€

The correct engineering statement is:

> The application is non-custodial and does not operate its own lending pool.

Whether users require KYC, eligibility checks, geo restrictions, or other controls depends on:

- the securities being accessed;
- Coinbase/token issuer requirements;
- jurisdiction;
- Aave interfaces/markets;
- the legal structure of the application;
- applicable law.

Coinbase tokenized equities are securities and have eligibility/jurisdiction restrictions.

Before public launch, obtain qualified legal advice for every target market.

Engineering must provide feature flags / access-control hooks so legal requirements can be implemented without redesigning the protocol integration.

Do not attempt to bypass issuer restrictions.

---

# 25. Securities restrictions

Do not assume:

> â€œAave is permissionless, therefore tokenized stocks are permissionless.â€

The underlying tokenized securities can have their own eligibility rules.

The application must:

- verify supported assets;
- verify the official issuer/deployment;
- respect issuer restrictions;
- respect jurisdictional requirements;
- never market the app as a way to bypass restrictions.

---

# 26. Supported assets

Initial supported assets:

```text
AAPLc
AMZNc
GOOGLc
METAc
MSFTc
NVDAc
TSLAc
```

Maintain a typed asset registry:

```ts
type SupportedEquity = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  chainId: number;
  enabled: boolean;
};
```

Addresses must be populated from verified current deployment data.

Do not infer addresses from symbols.

---

# 27. Application pages

## Marketing

`/`

Hero:

> Your stocks. Your liquidity.

Subheading:

> Borrow USDC against eligible tokenized stocks without selling them.

CTA:

> Get started

Trust points:

- Non-custodial
- Powered by Aave
- Built on Base
- Your assets remain in your smart account

Do not make regulatory approval claims.

---

## Dashboard

`/dashboard`

Show:

- total portfolio
- collateral
- borrowed USDC
- available credit
- health factor
- recent activity

---

## Borrow

`/borrow`

Show:

- collateral
- available credit
- amount input
- borrow rate
- health factor after borrowing
- confirmation

---

## Portfolio

`/portfolio`

Show:

- each supported stock
- balance
- value
- supplied amount
- available amount
- collateral status

---

## Activity

`/activity`

Show:

- supplies
- borrows
- repayments
- withdrawals
- transaction status
- transaction hash
- Base explorer link

---

## Settings

`/settings`

Show:

- JAW account
- wallet address
- network
- security
- legal/disclosure links

Do not create a traditional email/password account settings page.

---

# 28. Design system

The application should look like premium consumer fintech.

Design goals:

- clean
- calm
- minimal
- trustworthy
- mobile-first
- high information density without clutter
- excellent typography
- obvious primary actions

Do not copy Aave's existing UI.

We are creating a consumer product.

### Mobile

Primary experience must be excellent on:

- iPhone Safari
- iOS passkey flows
- JAW embedded authentication

JAW documents browser-specific embedded-dialog behavior and popup fallback. Do not fight the SDK's browser handling.

---

# 29. Copy

Prefer:

> Borrow USDC

over:

> Initiate variable debt

Prefer:

> Available credit

over:

> Remaining borrow capacity

Prefer:

> Your collateral

over:

> Supplied reserve assets

Prefer:

> Position health

over:

> Health factor

The technical metric can still appear in detail views:

> Health factor: 1.82

---

# 30. Security

This is a financial application.

Mandatory:

- TypeScript strict mode
- ESLint
- formatting
- dependency auditing
- CSP/security headers
- safe environment handling
- contract allowlists
- chain ID validation
- target validation
- ABI validation
- transaction simulation where practical
- no private keys
- no seed phrases
- no arbitrary calldata
- no arbitrary contract execution
- no hidden approvals
- no hidden transfers

### Never log

- private keys
- seed phrases
- authentication secrets
- raw sensitive signatures unless strictly necessary
- unnecessary personal data

---

# 31. Contract interaction safety

Every transaction must validate:

- chain ID
- contract target
- function selector
- token address
- amount
- spender
- recipient
- transaction value

Before the wallet confirmation:

```text
Expected target: verified Aave contract
Expected asset: verified token
Expected amount: exact user input
Expected action: displayed in UI
```

If anything differs:

BLOCK THE TRANSACTION.

---

# 32. Error handling

Handle at minimum:

- JAW authentication rejected
- JAW transaction rejected
- wrong chain
- chain switch failure
- insufficient balance
- insufficient allowance
- Aave reserve paused
- reserve frozen
- supply cap reached
- borrow cap reached
- insufficient USDC liquidity
- health-factor violation
- oracle issue
- stale data
- RPC failure
- transaction reverted
- transaction dropped
- transaction replaced

Translate errors into consumer language.

Bad:

> execution reverted: 0x...

Good:

> This borrow would put your position above the protocol's allowed risk level.

Always offer technical details separately.

---

# 33. Testing

Use:

- Vitest for logic
- Playwright for browser/E2E
- Foundry if custom Solidity is ever introduced
- Base mainnet fork for protocol integration

### Required test scenarios

1. New JAW user.
2. Existing JAW user.
3. JAW authentication rejected.
4. Base connected.
5. Wrong network.
6. Wallet/account changes.
7. No supported assets.
8. One supported stock.
9. Multiple supported stocks.
10. Supply collateral.
11. Borrow USDC.
12. Borrow near limit.
13. Partial repayment.
14. Full repayment.
15. Partial withdrawal.
16. Full withdrawal after repayment.
17. Asset paused.
18. Supply cap reached.
19. Borrow cap reached.
20. Insufficient liquidity.
21. Health-factor failure.
22. Transaction rejected.
23. Transaction reverted.
24. RPC outage.
25. Stale pricing.
26. Market closed.
27. JAW capability unavailable.
28. JAW atomic capability available.
29. Gas sponsorship available.
30. Gas sponsorship unavailable.

---

# 34. Development phases

## Phase 1 â€” Foundation

Set up:

- Next.js
- TypeScript
- Tailwind
- component system
- Wagmi
- viem
- TanStack Query
- JAW Wagmi connector
- Base
- environment configuration

Do not build transactions yet.

---

## Phase 2 â€” Read-only protocol integration

Implement:

- JAW account
- token balances
- Aave market configuration
- collateral
- debt
- health factor
- borrowing capacity
- reserve status
- USDC liquidity

Build the dashboard from real chain data.

Do not use fake/mock numbers in the production dashboard.

---

## Phase 3 â€” Collateral

Implement:

- stock approval/permit where required
- supply
- confirmation
- transaction tracking
- post-transaction refresh

---

## Phase 4 â€” Borrow

Implement:

- amount entry
- live capacity
- post-borrow risk preview
- borrow
- transaction tracking
- debt refresh

---

## Phase 5 â€” Repay + withdraw

Implement:

- partial repay
- full repay
- partial withdrawal
- full withdrawal
- safety validation

---

## Phase 6 â€” Consumer polish

Implement:

- onboarding
- JAW UX
- mobile optimization
- loading states
- error states
- activity history
- risk warnings
- accessible components
- disclosures

---

## Phase 7 â€” Security / launch

Perform:

- mainnet fork testing
- transaction simulation testing
- adversarial tests
- JAW failure tests
- Aave parameter change tests
- RPC failure tests
- frontend security review
- dependency audit
- legal review

If custom smart contracts are introduced, obtain an independent smart-contract audit before mainnet use.

---

# 35. Repository structure

Use:

```text
/
â”œâ”€â”€ app/
â”‚   â”œâ”€â”€ (marketing)/
â”‚   â”œâ”€â”€ dashboard/
â”‚   â”œâ”€â”€ borrow/
â”‚   â”œâ”€â”€ portfolio/
â”‚   â”œâ”€â”€ activity/
â”‚   â””â”€â”€ settings/
â”‚
â”œâ”€â”€ components/
â”‚   â”œâ”€â”€ wallet/
â”‚   â”œâ”€â”€ portfolio/
â”‚   â”œâ”€â”€ borrowing/
â”‚   â”œâ”€â”€ risk/
â”‚   â”œâ”€â”€ transactions/
â”‚   â””â”€â”€ ui/
â”‚
â”œâ”€â”€ lib/
â”‚   â”œâ”€â”€ jaw/
â”‚   â”‚   â”œâ”€â”€ config.ts
â”‚   â”‚   â”œâ”€â”€ capabilities.ts
â”‚   â”‚   â””â”€â”€ wallet.ts
â”‚   â”‚
â”‚   â”œâ”€â”€ aave/
â”‚   â”‚   â”œâ”€â”€ addresses.ts
â”‚   â”‚   â”œâ”€â”€ abis.ts
â”‚   â”‚   â”œâ”€â”€ client.ts
â”‚   â”‚   â”œâ”€â”€ market.ts
â”‚   â”‚   â”œâ”€â”€ positions.ts
â”‚   â”‚   â”œâ”€â”€ reserves.ts
â”‚   â”‚   â””â”€â”€ transactions.ts
â”‚   â”‚
â”‚   â”œâ”€â”€ tokens/
â”‚   â”œâ”€â”€ chain/
â”‚   â”œâ”€â”€ formatting/
â”‚   â””â”€â”€ validation/
â”‚
â”œâ”€â”€ hooks/
â”œâ”€â”€ types/
â”œâ”€â”€ tests/
â”‚   â”œâ”€â”€ unit/
â”‚   â”œâ”€â”€ integration/
â”‚   â””â”€â”€ e2e/
â”‚
â”œâ”€â”€ public/
â”œâ”€â”€ scripts/
â”œâ”€â”€ .env.example
â”œâ”€â”€ CLAUDE.md
â””â”€â”€ README.md
```

---

# 36. Environment

Use placeholders until verified values are available:

```env
NEXT_PUBLIC_APP_NAME=
NEXT_PUBLIC_APP_LOGO_URL=

NEXT_PUBLIC_JAW_API_KEY=

NEXT_PUBLIC_BASE_RPC_URL=
NEXT_PUBLIC_BASE_CHAIN_ID=8453

NEXT_PUBLIC_AAVE_V4_BASE_HUB=
NEXT_PUBLIC_AAVE_V4_BASE_SPOKE=
NEXT_PUBLIC_AAVE_V4_BASE_USDC=

NEXT_PUBLIC_AAVE_V4_BASE_AAPLC=
NEXT_PUBLIC_AAVE_V4_BASE_AMZNC=
NEXT_PUBLIC_AAVE_V4_BASE_GOOGLC=
NEXT_PUBLIC_AAVE_V4_BASE_METAC=
NEXT_PUBLIC_AAVE_V4_BASE_MSFTC=
NEXT_PUBLIC_AAVE_V4_BASE_NVDAC=
NEXT_PUBLIC_AAVE_V4_BASE_TSLAC=
```

Do not commit secrets.

Treat any browser-exposed `NEXT_PUBLIC_*` variable as public.

Do not put private credentials into `NEXT_PUBLIC_*`.

---

# 37. Backend

The MVP should be as decentralized and simple as practical.

Preferred:

```text
Browser
   â†“
JAW
   â†“
Wagmi / viem
   â†“
Aave V4
   â†“
Base
```

A backend is optional.

Use one only for genuine product needs such as:

- analytics
- notifications
- indexing
- cached metadata
- feature flags
- monitoring

Never use the backend as a custody layer.

Never store signing keys for users.

---

# 38. Analytics

Allowed anonymous product events:

```text
jaw_connect_started
jaw_connect_completed
dashboard_viewed
borrow_started
borrow_confirmed
borrow_failed
repay_started
repay_confirmed
supply_confirmed
withdraw_confirmed
```

Avoid collecting unnecessary wallet-linked personal data.

Do not log:

- seed phrases
- private keys
- secrets
- unnecessary signatures
- sensitive legal/identity information

---

# 39. Performance

The dashboard should feel instant.

Use:

- TanStack Query
- block-aware invalidation
- multicall
- selective polling
- skeleton states
- background refresh
- debounced borrow calculations

Never use optimistic financial state that could make the user believe a transaction succeeded when it has not.

After every transaction:

```text
receipt confirmed
      â†“
re-read on-chain state
      â†“
render authoritative position
```

---

# 40. Accessibility

Follow WCAG-oriented practices.

Required:

- keyboard navigation
- semantic HTML
- accessible labels
- visible focus
- adequate contrast
- screen-reader transaction states
- no color-only risk indicators
- reduced-motion support

---

# 41. Product economics

Do not implement an application fee in MVP.

First prove:

- account onboarding
- portfolio discovery
- collateral supply
- borrowing
- repayment
- withdrawal
- transaction reliability

If an application fee is later introduced:

- make it explicit;
- show it before signing;
- never hide it inside a rate;
- obtain legal review;
- never alter the user's expected transaction without confirmation.

---

# 42. Definition of done

MVP is complete when a test JAW smart account can:

1. Authenticate with JAW.
2. Operate on Base.
3. Display supported tokenized stock balances.
4. Display Aave collateral.
5. Display USDC debt.
6. Display available credit.
7. Supply supported stock collateral.
8. Borrow USDC.
9. Display updated debt.
10. Display updated health factor.
11. Repay USDC.
12. Withdraw collateral.
13. Display transaction history.
14. Provide Base explorer links.
15. Recover gracefully from major JAW, wallet, RPC, and Aave errors.

---

# 43. First task for Claude Code

Before writing application code:

1. Inspect the repository.
2. Check Node and package-manager versions.
3. Set up Next.js + TypeScript if necessary.
4. Install current JAW Wagmi integration.
5. Configure JAW for Base.
6. Install/configure Wagmi, viem, and TanStack Query.
7. Inspect official Aave V4 documentation and repository.
8. Resolve current Aave V4 Base deployment information.
9. Verify the current Equities Hub configuration.
10. Verify USDC address.
11. Verify all seven supported tokenized-equity addresses.
12. Build typed market configuration.
13. Implement JAW connection.
14. Implement read-only token balances.
15. Implement read-only Aave positions.
16. Write tests.
17. Build the dashboard.
18. Only after all read-only data is correct, implement write transactions.

Do not fabricate contract addresses.

Do not fabricate Aave APIs.

Do not fabricate JAW APIs.

---

# 44. Engineering principles

### Principle 1

**JAW is the wallet layer.**

Do not introduce another wallet provider.

### Principle 2

**Aave is the lending layer.**

Do not recreate Aave.

### Principle 3

**Base is the initial chain.**

Do not introduce multi-chain complexity into MVP.

### Principle 4

**The user's smart account remains the custody layer.**

The application never takes custody.

### Principle 5

**On-chain state is authoritative.**

Never fake balances, rates, collateral, debt, or borrowing capacity.

### Principle 6

**Never guess contract addresses or APIs.**

Verify current deployments.

### Principle 7

**Risk must be obvious.**

A user must understand how close they are to liquidation before borrowing.

### Principle 8

**The UI should be consumer-first.**

The user wants liquidity, not a DeFi terminal.

### Principle 9

**Security beats convenience.**

Never batch or abstract transactions in a way that makes asset movement unclear.

### Principle 10

**Do not confuse technical non-custody with regulatory exemption.**

The app can be non-custodial without making a legal claim that it is exempt from every KYC, securities, lending, or jurisdictional requirement.

---

# 45. Final product statement

Build:

> A premium consumer application that lets eligible users borrow USDC against supported Coinbase tokenized stocks on Base, using JAW smart accounts and Aave V4 as the underlying wallet/account and lending infrastructure.

The user should feel like they are using a simple stock-backed credit product.

Under the hood:

```text
JAW
 â†“
User Smart Account
 â†“
Base
 â†“
Aave V4 Equities Hub
 â†“
USDC
```

The application is the experience.

JAW is the account layer.

Aave is the lending layer.

Coinbase tokenized equities are the collateral.

USDC is the borrowed asset.

Base is the execution layer.

Keep those boundaries explicit throughout the codebase.
```

  
  
  
  
**MODIFIED IDEA **  
  


# Invest and Earn Wallet: Project Brief

9 Oct 2026 · @hannibal

 

Invest and Earn is a wallet where the stocks you own, like NVIDIA or Apple, keep earning and can back a loan in one tap, so you buy more without selling anything. Your cash (USDC on Base) earns interest too, and you can hold ETH and BTC alongside your stocks. Two agents keep it running inside limits you sign once: the Rebalancer keeps your mix on target, and Protection watches your credit at any hour. It runs on Base and is built on JAW, which gives it the Face ID account, the name, gas-free payments, one-tap actions and the onchain permissions that keep every agent inside its limits.

## How it works

\[embed: node/6f178795-e9f7\]

## The user's journey

Sam (sam.justan.id) is a new user:

1. **Sign up or sign in** with one Face ID. A new user gets the wallet and the name sam.justan.id, at $0. A user who already has a JAW account from another app signs in with it, and the supported stocks they own show up; everything else stays hidden.
2. **Top up** by sending stablecoins to sam.justan.id, or with Auto top up from another wallet.
3. **Invest** in stocks like NVIDIA and Apple, and add some BTC or ETH if they like.
4. **Set a target mix** and let the Rebalancer keep it.
5. **Buy more with credit** in one tap when the cash runs short, using the stocks, and any crypto, as collateral.
6. **Any hour:** if BTC drops fast while Sam sleeps, Protection keeps the credit safe.
7. **Repay** with cash, with a holding, or from top ups.
8. **Review** what Sam made in Results, and compare with friends.

## Two ways in

**Bring the stocks you already own.** A user who bought supported stocks with a JAW account in another app signs in here with the same account, and those stocks show up, ready to earn and to back credit. Nothing needs to be sent, because it is the same account. The app shows only what it supports (the Coinbase stocks on Base, ETH, BTC and USDC) and hides the rest.

**Or start with cash.** Money lands as USDC on Base, shown in dollars and earning interest straight away:

- **Send** stablecoins to the user's name, sam.justan.id.
- **Auto top up:** link another wallet once, pick an amount, and the app tops the account up every month.

Two nice-to-haves add to the cash path:

- **Auto receive** converts a stablecoin that arrives in another flavour or from another chain into USDC on Base, but only if the user loses 2% or less to slippage.
- **Quarantine** keeps whatever the app can't or won't convert away from the user's money. A stablecoin with no route yet, or one whose swap would cost more than 2%, waits; a token flagged as bad is ignored. The user decides what to do with it, and the app never pushes them to.

## What earns


| What the user holds           | How it earns                                                   | It can also                   |
| ----------------------------- | -------------------------------------------------------------- | ----------------------------- |
| Stocks, e.g. NVIDIA and Apple | Yield, plus dividends that raise the share count automatically | Back credit                   |
| Cash (USDC)                   | Interest                                                       | Buy, spend, send              |
| ETH and BTC                   | Lending yield (a fraction of a percent for BTC)                | Back credit, buy, spend, send |


Credit costs interest and buys more without selling. It is a debt, shown on its own line, never mixed into what the user holds.

## Features and agents

A feature follows a fixed rule the user set. An agent watches the account and decides when to act. There are exactly two agents. Every feature and agent runs on a JAW permission the user signs once with Face ID, and JAW enforces its limits onchain.


| Name              | Kind                       | What it does                                                                                            | What it can never do                                    |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Auto top up       | Feature                    | Tops the account up from the user's other wallet every month                                            | Take more than the amount the user picked               |
| Auto buy          | Feature                    | Buys one asset on a schedule; skips and notifies if cash runs short                                     | Spend more than the set amount, or buy anything else    |
| Dividend reinvest | Built into the stock token | Each dividend raises the share count; nothing to set up                                                 | Needs no permission                                     |
| **Rebalancer**    | Agent                      | Keeps the target mix: puts new money where the mix falls short, and sells some of whatever grew too big | Borrow, or sell collateral the loan still needs         |
| **Protection**    | Agent                      | Turns on with credit and keeps it safe (see Staying safe)                                               | Sell anything except what backs the loan, or touch cash |


The user sees both agents in one list with their limits and last action, and can change or cancel any of them with Face ID at any time; a cancelled permission can never act again.

## Credit: buying more without selling

Credit lets the user buy more than their cash covers, in one tap, using their stocks, and any crypto they hold, as collateral. Nothing is sold; the app borrows the difference in dollars. Borrowing against stocks is open only to eligible non-US users.

- **Off until turned on.** One sentence explains it ("Credit is a loan against your stocks and crypto. If they fall, you repay or Protection sells a little."), Face ID confirms, and Protection switches on.
- **The split before every buy.** A $1,000 buy with $400 of cash shows "$400 from your money, $600 borrowed, about $3 a month" (at about 6% a year), plus the status (Safe, Watch or Act) before and after.
- **The debt on its own line.** Home shows "You owe $600, grows about $3 a month" under net worth.
- **Repay** any amount, with cash or by selling a holding in one signature, or let top ups repay first (off by default).

### Staying safe

Home shows one status word for the credit: **Safe**, **Watch** or **Act**. Credit is capped well below the lending limit, the point where Aave's outside buyers can step in. As the account nears the app's own floor, which sits below that limit, the status moves from Safe to Watch to Act, and the app blocks any action that would push the account past the floor.

- At **Watch**, Protection alerts the user to repay or add collateral.
- At **Act**, Protection sells just enough collateral at market price to pay the loan down, before the lending market's outside buyers can take it at a discount. It works at any hour and explains every sale in Activity.
- Every holding shows how much is **locked** behind credit and how much is **free**.

## Results

Results shows what the user really made: net worth, minus money they put in, after every fee and every cent of credit interest. The breakdown lists market moves, yield, dividends, credit interest and fees, for this month, this year and all time, with a yearly export for taxes.

## Friends

Friends is a small social layer: users add friends by their ENS names and compare in percent, never in dollars, on two tabs.

- **Return:** how well the money did, as a percent of what was put in, so a $500 account can beat a $50,000 one.
- **Growth:** how much the portfolio grew in quantity without new money. It counts extra holdings from buying with credit, reinvested dividends and crypto yield, each valued at its price on the day it arrived; units sold, by the user or by Protection, count against it. Cash interest doesn't count, because everyone gets the same rate, and deposits and market moves don't count either.

The board never shows Safe, Watch or Act, and never nudges anyone to borrow or trade to climb it.

## Design principles

- **Simple first.** The user taps; the app handles the steps. No Aave, gas, chains or token jargon on screen, and amounts are in dollars.
- **Nothing moves without consent.** Money moves only through actions, features and agents the user approved. Agents never borrow and never send money out of the wallet, and JAW enforces this onchain, not our backend.
- **No surprises.** Every action shows its cost and its effect on the status before the user confirms, and credit always stays apart from the user's own money.

## Screens

Three tabs, Home, Invest and Pay; the rest opens from Home.


| Screen     | What it's for                                                                     |
| ---------- | --------------------------------------------------------------------------------- |
| Home       | Net worth with what is owed apart, the status word, holdings with locked and free |
| Invest     | Buy stocks and crypto, set up Auto buy and the target mix                         |
| Pay        | Send, receive by name, set up Auto top up                                         |
| Credit     | What you owe and what each credit buy paid for; repay; turn credit on or off      |
| Agents     | The Rebalancer and Protection, their limits and last action                       |
| Activity   | Every move, naming who acted: "Protection sold a little BTC and repaid $250"      |
| Results    | What the user made, every fee, a yearly tax export                                |
| Friends    | Return and Growth with friends                                                    |
| Quarantine | Pending stablecoins and flagged tokens                                            |


## What powers what

The account is non custodial: the user holds the keys through a passkey, Our backend can only act through the permissions the user signed, and JAW enforces them onchain.


| Part of the app                          | Powered by                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Face ID account and name (sam.justan.id) | JAW passkey smart account; the name is issued at sign up through JAW's built-in ENS support (JustaName). The same account works in every app built on JAW (CrossPlatform mode, signing on JAW's own page, keys.jaw.id), which is how stocks bought elsewhere show up here                                    |
| No gas fees                              | JAW: gas sponsored through a paymaster, or paid in USDC automatically, so the user never needs ETH                                                                                                                                                                                                           |
| One-tap actions                          | JAW batched calls: several steps in one signature, and either all of them go through or none do                                                                                                                                                                                                              |
| Features and agents with hard limits     | JAW permissions (ERC-7715). Each names one spender, the contracts and functions it may call, a spend cap per period and an expiry; JAW enforces all of it onchain, and the user can revoke it at any time. Our backend only holds the spender key, so even a stolen key can do no more than the user allowed |
| Auto top up                              | A JAW permission on the user's other wallet, capped per month; an existing wallet can be upgraded in place with EIP-7702 to grant it                                                                                                                                                                         |
| Auto receive and Quarantine              | A JAW permission signed at sign up, run by our backend, with cross-chain routing and a 2% slippage cap                                                                                                                                                                                                       |
| Interest on cash                         | Aave, the same mechanism as the Aave App's savings                                                                                                                                                                                                                                                           |
| Stocks and dividends                     | Coinbase tokenized stocks on Base (e.g. NVDAc); a dividend raises the token's multiplier                                                                                                                                                                                                                     |
| Yield on ETH and BTC                     | Aave's main market on Base                                                                                                                                                                                                                                                                                   |
| Credit against stocks                    | Aave V4's Equities Hub on Base, Aave's market for tokenized stocks: one USDC market, Coinbase stocks as collateral only                                                                                                                                                                                      |
| Credit against crypto                    | Aave's main market on Base                                                                                                                                                                                                                                                                                   |
| Protection's sale                        | A JAW permission that can only sell collateral to repay, using Aave's repay with collateral                                                                                                                                                                                                                  |
| Results, Activity, Friends scores        | Our indexer                                                                                                                                                                                                                                                                                                  |


The app shows one credit over the two Aave loans: a buy draws from the one with more room, and the status follows the weaker one. Stock prices come from Chainlink feeds that run Sunday 20:00 to Friday 20:00 ET; over the weekend they hold Friday's price, and Aave pauses the stock market only during corporate actions such as stock splits. Crypto-backed credit works at any hour. Buying and selling stocks and crypto in the app needs a trading route, still to be decided. Seven stocks are accepted at launch: Apple, Amazon, Alphabet, Meta, Microsoft, NVIDIA and Tesla.

## Not in the MVP

- Crypto beyond ETH and BTC
- Autopilot presets (Careful, Balanced, Bold) for take profit and stop loss
- A choice of yield source; the app picks it
- Extra stock yield from DEX pools

