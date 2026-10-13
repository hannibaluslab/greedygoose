# Guardian

Guardian keeps a loan **Safe** by repaying part of it from the user's own savings, so Aave's liquidators never get to sell their stocks at a discount. It never sells, moves or locks stocks, and it never touches the user's cash.

## How it works

```text
User (one Face ID)                         Keeper (our server, every minute)
───────────────────                        ─────────────────────────────────
1. Add USDC to savings (Aave V3, ~4.4%)    a. Find Guardian permissions (PermissionApproved events)
2. Approve the Guardian permission         b. Read loan health, savings, today's remaining cap
   on JAW's JustaPermissionManager         c. Plan: Watch → repay to HF 1.65; Fri 14–20 ET → Weekend Shield
                                           d. Simulate, then manager.executeBatch(permission, calls):
                                                withdraw USDC from savings → to the account
                                                approve USDC → Aave V4 spoke
                                                repay the account's own USDC loan
```

## Why it's safe

Three independent layers, all on-chain:

| Layer | Enforces | Where |
| --- | --- | --- |
| JAW permission (whitelist) | Only Pool.withdraw, USDC.approve, Spoke.repay; only by the keeper; only between start and end; revocable | `JustaPermissionManager` `0xf1b4…01D8` (verified, immutable) |
| **GuardianChecker** | Arguments: withdraw **to the account**, approve **only the spoke**, repay **reserve 7 for the account**; no ETH; exact calldata length | `contracts/src/GuardianChecker.sol` (stateless, immutable) |
| Daily USDC spend cap | Most Guardian can move per day (user picks $25–$250); approvals reset to 0 after each batch | Permission `spends`, enforced by the manager |

JAW's SDK can't set a checker (it hard-codes `checker = 0`), so the app approves the permission with a direct `manager.approve(permission)` call through `wallet_sendCalls`. The manager must be an owner of the account (JAW's own grant flow adds it the same way, and most JAW accounts already have it).

A stolen keeper key can at most repay the user's own loan from the user's own savings, up to the daily cap.

## Proof

- `npm run contracts:test` runs 8 unit and fuzz tests on the checker, plus 7 Base-fork tests against the real manager, Aave V3, the Aave V4 spoke and a real JAW account. The fork tests cover: the keeper repays; and each of these is rejected with its exact error: withdraw to an attacker, repaying another account's loan, a plain transfer, going over the cap, a non-keeper caller, and use after a revoke.
- `npm run guardian:e2e` is a full anvil-fork rehearsal: deploy the checker, put a real account in Watch, approve, then the real keeper code discovers it, plans, simulates and executes. It checks that the account is back to Safe, the repay came from savings, cash is untouched, no approval is left over, the next tick does nothing, and nothing happens after a revoke. It uses Foundry's container if the local `anvil` can't run.

## Before mainnet

1. **Independent audit** of `GuardianChecker` and of how we compose it with `JustaPermissionManager`.
2. Deploy the checker (constructor: USDC, Aave V3 Pool, V4 spoke, 7), then set `NEXT_PUBLIC_GUARDIAN_CHECKER` and `GUARDIAN_FROM_BLOCK`.
3. Create the keeper spender key, hold it in a secret manager, fund it with a little ETH for gas, and set `NEXT_PUBLIC_GUARDIAN_KEEPER` and `GUARDIAN_KEEPER_KEY`.
4. Run `npm run guardian:keeper -- --loop --execute` with a private Base RPC that serves `eth_getLogs` ranges. Add monitoring and alerts on errors.
5. Confirm that JAW's signing UI accepts the direct `manager.approve` call, plus the `addOwnerAddress(manager)` self-call for accounts that don't yet have the manager as an owner. **UNVERIFIED** until tried with a real account.

## Known gaps

- Guardian's repays are sent by the keeper, so they don't appear in JAW's call history. Activity doesn't show them yet; the fix is to index `CallsExecuted` events for the user's permission hash.
- The permission record (cap, start, end) is kept in browser storage, used for status and revoke. If it's lost, Guardian keeps running, and the record can be rebuilt from the manager's `PermissionApproved` events. That rebuild isn't implemented yet.
- Weekend Shield uses a fixed 15% stress drop and doesn't model holidays.
