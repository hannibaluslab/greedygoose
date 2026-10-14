# Rehearsal: the real app on a local fork of Base

A dress rehearsal for GreedyGoose. The real app (`next dev`) runs against a local anvil fork of Base mainnet, with fake money. Every flow signs and lands on the fork, and the agents run in GooseExecutor, triggered the way Chainlink triggers them.

Nothing here writes to Base. Anvil reads Base's state the first time something touches it and keeps every write on this machine. The fork signer and the scripts refuse any RPC that isn't a local anvil on chain 8453. The production build can't contain the signer ([The fence](#the-fence)).

## Quick start

Foundry 1.8 or later (`anvil`, `forge`, `cast`), Node 22 (`nvm use 22`), and `npm ci`. Keep `.env.local` as usual: the JAW key gives market prices; the rehearsal overrides the rest.

```sh
npm run rehearsal:fork       # terminal 1: the fork, on http://127.0.0.1:18545
npm run rehearsal:setup      # stand-in stocks, two JAW accounts with fake money, GooseExecutor (about 1.5 min)
npm run rehearsal:dev        # terminal 2: the app on http://localhost:3100, signing in as sam
```

Open http://localhost:3100, tick the eligibility box and press "Sign in with your JAW account": you are sam. A red pill at the top says "Rehearsal · local fork · fake money" on every screen.

Then, from any terminal:

```sh
npm run rehearsal:agents                # what Chainlink would do now: register new grants, then a run
npm run rehearsal:shock -- NVDAc -28%   # move a price on Aave's oracle
npm run rehearsal:warp -- 30m           # move the fork's clock
npm run rehearsal:prove -- --shock      # the scripted proof run, with screenshots
```

A restarted fork is a fresh fork: run `setup` again, then restart `dev` (setup writes new addresses).

## The fork

`start-fork.sh` runs anvil with:

| Flag | Why |
| --- | --- |
| `--fork-url https://mainnet.base.org` | Base mainnet at its latest block. `REHEARSAL_FORK_URL` takes another Base RPC (a keyed one is faster; it is only read). `REHEARSAL_FORK_BLOCK` pins the block. |
| `--chain-id 8453` | Base's id, so the app, JAW's SDK and the D13 deploy script take it for Base. |
| `--network optimism` | Base is an OP Stack chain. Left alone, anvil 1.8 picks its `base` family for chain 8453, which runs the B20 stocks natively and ignores the stand-ins. That native B20 has no `uiMultiplier()`, which the app reads for every stock. Setup refuses to run on the `base` family. |
| `--no-rate-limit` | Anvil fetches Base's state one slot at a time and by default holds itself to 330 compute units a second. A first quote on a stock pool took 5.5 minutes with the limit and 9 seconds without it. |
| `--block-time 1` | A block a second, so the chain's clock follows the wall clock (Base makes one every 2 s). |
| `--host 127.0.0.1 --port 18545` | This machine only. `REHEARSAL_PORT` changes the port. |

## Setup

`npm run rehearsal:setup` (`setup.ts`) does six things, and checks each one on the fork before going on.

1. **Stand-in stocks.** Base runs the seven B20 stocks natively (their code is the byte `0xef`), and anvil can't. Each stock's own address gets `RehearsalStock` (`contracts/script/rehearsal`): a plain ERC-20 with 8 decimals and the stock's real `uiMultiplier`. It holds the balances the Aave hub and every stock/USDC pool hold on Base at the fork block: Aerodrome at each tick spacing, Uniswap at each fee tier. That is the fork suites' approach (`contracts/test/ForkBase.sol`) applied to every holder that matters.
   - **Dry pools are closed.** A pool with nothing in range at its price, or under $100 of either side, gets its `slot0.unlocked` flag cleared, so any swap or quote on it reverts at once. Otherwise a quote walks every empty tick to the price limit: thousands of storage words, each fetched from Base one at a time, which stalled the fork for over 20 minutes. On Base the same quote answers in milliseconds and loses to the deep pool. The app quotes every pool and already ignores one that fails. The flag's byte is found by its sqrtPriceX96 and checked through the pool's own `slot0()`. At the 2026-10-14 fork, 9 pools were closed, all dust: Uniswap's AAPL 0.01% and 1%, AMZN 0.3%, META 0.01%, NVDA 0.05% and 1%, TSLA 1%, and Aerodrome's AMZN and NVDA tick-spacing-1 pools. Every Aerodrome tick-spacing-10 pool (where Protect and the Rebalancer trade) stays open.
2. **Two fresh JAW accounts** from JAW's real factory (`0x5803…fa9E`), each owned by `[signer, permission manager]`, the owners JAW's SDK gives every account. An anvil dev account stands in for the passkey. The factory nonce comes from the fork block, so every fork gets accounts no one has used, here or on Base.
3. **Fake money,** by setting balance storage (`anvil_dealERC20`), then real calls from the accounts themselves:
   - **sam:** $3 in the wallet and $650 in Aave V3 savings: $250 of the cash, plus the $400 of credit drawn against 5 NVIDIA supplied as backing (health about 1.94, Safe). The wallet holds less than a $5 buy, so a buy takes the rest from savings in the same batch.
   - **ana:** $100 of USDC and $10 of USDT, for Receive's convert. No stocks and no credit.
   - Amounts are environment variables (dollars; shares for NVDA): `REHEARSAL_SAM_WALLET`, `REHEARSAL_SAM_SAVINGS`, `REHEARSAL_SAM_NVDA`, `REHEARSAL_SAM_CREDIT`, `REHEARSAL_ANA_WALLET`, `REHEARSAL_ANA_USDT`.
4. **GooseExecutor and its job libraries** with the D13 deploy script (`contracts/script/DeployExecutor.s.sol`, daily limits capped at $5), sent by forge with `--unlocked` from anvil dev account #0, its owner. Forge links each library through CREATE2, so a library Base already has from the D13 deploy (same code, same address) is reused. The owner then bootstraps dev account #1 as the one forwarder. The deploy record goes to `.rehearsal/broadcast`, never `contracts/broadcast`.
5. **A warm-up:** the app's own `quotePool` on every open stock pool, both ways (about 20 s), so the screens don't wait on Base the first time.
6. **The files:** `.rehearsal/state.json` for the scripts, and `.env.rehearsal.local` for the app. Both are gitignored.

The anvil dev accounts' roles:

| # | Role |
| --- | --- |
| 0 | GooseExecutor's owner and deployer; sends the factory calls |
| 1 | The forwarder (Chainlink's place) |
| 2 | sam's signer (the passkey's place) |
| 3 | ana's signer |

Anvil signs for its own unlocked dev accounts (`eth_sendTransaction`), so no private key appears in this code, its config or the browser.

## The app

`npm run rehearsal:dev` (`dev.ts`) runs `next dev` on port 3100 (`REHEARSAL_APP_PORT`) with `.env.rehearsal.local` on top of `.env.local`. `-- --as ana` signs in as ana instead. Next doesn't read `.env.rehearsal.local` on its own.

| Variable | Set to |
| --- | --- |
| `NEXT_PUBLIC_REHEARSAL_RPC` | The fork. It switches the rehearsal on (development only, local only). |
| `NEXT_PUBLIC_REHEARSAL_ACCOUNT` / `_SIGNER` | The account to sign in as, and its owner on anvil. |
| `NEXT_PUBLIC_REHEARSAL_FROM_BLOCK` | The first block after the fork point. Logs before it would be asked of Base, which refuses `eth_getLogs`. |
| `NEXT_PUBLIC_GOOSE_EXECUTOR` / `_BLOCK` | The fork's executor and its deploy block. A D13 deploy on Base, if `.env.local` names one, is overridden. |

With the rehearsal on, `lib/jaw/config.ts` points every wagmi read at the fork (60 s timeout, for first reads) and puts the fork signer's connector in place of JAW's. JAW's connector isn't loaded, so nothing can reach JAW's real bundler. Welcome's sign-in uses whichever is configured (`SIGN_IN_CONNECTOR_TYPE`).

### The fork signer (`lib/rehearsal/signer.ts`)

It answers the wallet methods the app asks JAW for:

| Method | On the fork |
| --- | --- |
| `wallet_sendCalls` | The batch as the account's own `executeBatch`, sent by its owner: all or nothing, like a JAW user operation. The id is the transaction hash. |
| `wallet_getCallsStatus` | From the receipt: 100 pending, 200 done, 500 reverted. |
| `wallet_grantPermissions` | The approve call JAW's grant ends with, built by JAW's own SDK (`buildGrantPermissionCall`): start from this browser's clock, a random salt, checker 0. The account sends it with `executeBatch`; the hash comes from the manager's `PermissionApproved`. |
| `wallet_revokePermissions` | `manager.revoke` from the account, built by `buildRevokePermissionCall` from the record. |
| `wallet_getPermissions` | JAW's relay, replaced by the chain: every permission the manager approved for the account since the fork point that it hasn't revoked. |
| `wallet_getCallsHistory` | What this signer sent, from this browser's storage. |
| `wallet_getCapabilities` | What JAW reports on Base (atomic batches, USDC as a fee token), plus `rehearsal: { fork: true }`. |
| Reads (`eth_call`, `eth_getLogs`, `eth_simulateV1`, …) | Forwarded to the fork. |
| Signing (`personal_sign`, typed data, `eth_sendTransaction`) | Refused (4200). The app doesn't use them. |

Before the first write it checks that the node is anvil, the chain is 8453, the owner is unlocked there and the account says it is the owner. Gas is anvil's estimate plus half, plus 100k: an Aave V3 supply ran out of gas in its incentives hook on the bare estimate.

## Agents

`npm run rehearsal:agents` (`run-agents.ts`) does what Chainlink Automation does on Base, with the forwarder:

1. **Registration** (the log-trigger upkeep): every `PermissionApproved` the manager emitted since the last run goes through GooseExecutor's `checkLog`, and each one it accepts is registered with `performUpkeep`, at the registration upkeep's 1M gas.
2. **A run** (the custom-logic upkeep, `checkData = abi.encode(0, 1)`): `checkUpkeep`, then `performUpkeep` with what it lists, at the run upkeep's 5M gas. Never at an estimate: a run with too little gas succeeds by deferring every account, so an estimate finds exactly that. `-- --until-idle` repeats until nothing is listed, at most 5 times.

It prints what each step did, from the executor's events:

```
Run 1: checkUpkeep(shard 0 of 1)
  listed: sam
  sam plans Repay (Protect)
  sam: Protect repaid $5.00 from savings (Watch), health 1.398 → 1.416 (Watch)
```

## Price shock

`npm run rehearsal:shock -- <stock> <change>` (`price-shock.ts`), where change is `-28%`, `+10%`, a price in dollars (`135`) or `reset`.

The spoke's oracle prices a stock with `latestAnswer()` on its source (`getReserveSource`, a Chainlink proxy). The script puts `RehearsalFeed` (`contracts/script/rehearsal`) at that source and writes the new price; `reset` puts the proxy's own code back. Aave, the app and GooseExecutor read the same oracle, so all of them see the shock. It prints each account's health before and after.

The stock's pools don't move. A buy of a shocked stock is blocked by the app's 10% guard. Protect sells into a pool above Aave's price, which its pool check allows. The app's market prices (JAW, CoinGecko) stay Base's, so they fail the 2% check against Aave's and are hidden, as designed.

## Time warp

`npm run rehearsal:warp -- 30m` (`time-warp.ts`; also `90s`, `2h`, `1d`) adds the time with `evm_increaseTime`, mines a block, and says whether stock prices are live or held at the new time (the executor's calendar). The browser's clock doesn't move, so the app's own countdowns still count from now.

## A Protect rehearsal

From a fresh setup, with Protect switched on in the app (selling included):

```sh
npm run rehearsal:agents                 # registers both grants
npm run rehearsal:shock -- NVDAc -28%    # sam: health 1.94 → 1.40, Watch
npm run rehearsal:agents                 # Protect repays $5 from savings (the D13 cap)
npm run rehearsal:shock -- NVDAc 135     # health about 1.20: below the heads-up line
npm run rehearsal:agents                 # SellHeadsUp: sells about $5 in 30 minutes unless the health recovers
npm run rehearsal:warp -- 31m
npm run rehearsal:agents -- --until-idle # Protect · sell takes NVIDIA out of Aave, sells it on Aerodrome, repays
npm run rehearsal:shock -- NVDAc reset
```

## Proof

`npm run rehearsal:prove` (`prove.ts`) drives the app in Chrome at 390×844 and checks the chain after each step:

1. Sign in as sam with the fork signer.
2. Buy $5 of NVIDIA from cash (buy sheet, Review, Confirm). Checks: NVIDIA received, at least the review's minimum; cash down $5; savings down by the withdrawal the review announced; the wallet's USDC exact to the unit.
3. Switch Protect on in its sheet, selling included. Checks: two grants on JAW's manager with GooseExecutor as the spender.
4. `run-agents`. Checks: GooseExecutor has Protect and Protect · sell on for sam.
5. With `-- --shock`: NVIDIA down 28%, sam in Watch on Home, `run-agents`. Checks: Protect repaid $5 from savings. The price is put back after.

Screenshots go to `.rehearsal/shots` (`REHEARSAL_SHOTS`). Chrome is the system's (`REHEARSAL_CHROME` takes a path). It needs a fresh setup: on a second run Protect is already on.

## The fence

The fork signer exists only in development, and only against a local fork.

- `lib/rehearsal/flag.ts`: the rehearsal is on only when `NODE_ENV` isn't "production" and `NEXT_PUBLIC_REHEARSAL_RPC` is set. A URL that isn't localhost, 127.0.0.1 or [::1] throws.
- `lib/jaw/config.ts` writes the same condition inline around a `require`, so the bundler sees it is false in a production build and leaves `lib/rehearsal` out. `next build` always runs as production.
- The signer throws if created in production, or with a non-local RPC. Before any write it checks for anvil, chain 8453 and an unlocked owner.
- `npm run rehearsal:check-build` builds with every rehearsal variable set, the worst case, then searches the output for the signer's marker (which it uses at runtime, so tree-shaking can't remove it while the signer stays), the badge's words, and any source map listing a file in `lib/rehearsal/`. It exits 1 if it finds any.
- `tests/unit/rehearsal.test.ts`: production keeps JAW's connector even with every rehearsal variable set; the signer and its loader refuse to run in production; a non-local RPC is refused; the signer refuses other chains, other senders and signing methods; and JAW's grant builder yields exactly GooseExecutor's template for all five jobs.
- No keys: anvil signs for its own dev accounts. JAW's connector is untouched and is the only connector whenever the rehearsal is off.

## What differs from Base

| On Base | In the rehearsal |
| --- | --- |
| B20 stocks with transfer policies, pauses and `uiMultiplier` updates | Plain ERC-20 stand-ins with the real balances and multiplier at the fork block. Policy and pause paths can only be tried against Base (`tests/onchain`). |
| Every pool quotes | Dry pools are closed on the fork (Setup, step 1). |
| JAW's popup, passkey and Face ID; a user operation through JAW's bundler | No popup: the owner key sends `executeBatch` straight away. The calls are the same; the envelope isn't. |
| The network fee in USDC, through JAW's paymaster | The owner pays in the fork's ETH; no USDC fee is taken. The app still says "Paid from your cash", and its $0.50 fee buffer stays in the wallet. |
| JAW's relay lists the permissions; its call history spans devices | Both come from the fork's events and this browser's storage. |
| Chainlink's forwarders, a registrar, upkeep balances, latency | Dev account #1 as the forwarder, when you run `run-agents`. |
| Live oracle prices | Aave's prices from the fork block until shocked. |
| A name like `sam.justan.id` | A fresh address with no name: Home says "Hi there". |

## Troubleshooting

- **"No fork at http://127.0.0.1:18545"**: start it with `npm run rehearsal:fork`.
- **"anvil runs as its base network family"**: the fork was started without `--network optimism`; use `npm run rehearsal:fork`.
- **The app shows old addresses or "No executor on this fork"**: the fork was restarted. Run `setup`, then restart `dev`.
- **A first screen or quote is slow**: anvil is fetching state from Base. It's fast once fetched. A keyed `REHEARSAL_FORK_URL` helps.
- **Browser storage:** the signer keeps `gg.rehearsal.connected` and `gg.rehearsal.history.<account>` in this browser. New accounts each fork mean old entries never mix in.
