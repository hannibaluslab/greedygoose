# JustaPermissionManager: notes for GooseExecutor

What the JAW permission manager on Base does, read from its verified source. These notes answer the questions the plan left open for M0 and feed the executor spec ([GooseExecutor.md](./GooseExecutor.md)).

**Source.** `JustaPermissionManager` at `0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8` (`lib/guardian/config.ts:11`), fetched from Sourcify's v2 API on 2026-10-14 (`/server/v2/contract/8453/<address>?fields=sources,compilation,deployment`). solc 0.8.30, via-IR, deployed in block 42,868,201. The same 14,180 bytes sit at the same address on Base Sepolia. The contract is not a proxy and has no admin, so what follows can't change.

Line references are to `src/JustaPermissionManager.sol` in that bundle unless a file is named. `BaseAccount.sol`, `JustanAccount.sol` and `MultiOwnable.sol` come from the same bundle (`lib/justanaccount/...`). SDK references are to `node_modules/@jaw.id/core/dist` at version 1.6.2, the version in our `package.json`.

## 1. How spend is metered

The manager counts spend **after** the calls run, per token, as the larger of two numbers (`:791-808`):

- **Calldata sum:** the amounts in every `transfer`, `transferFrom` (only when `from` is the account), `approve`, `increaseAllowance` and Permit2 `approve` in the batch, summed per token (`:623-714`). An `approve` or `transferFrom` with amount 0 is skipped (`:653-655`, `:672-674`).
- **Balance drop:** the account's balance before the batch minus after, floored at 0 (`:717-721`, `:800-803`).

Details that matter for us:

- **Which tokens are watched:** every token in `spends`, plus every token the calldata touches (`:607-616`). A watched token with no `spends` entry reverts the whole batch with `NoSpendPermissions` (`:1076-1078`). So a sell permission must list a spend limit for each stock it may approve.
- **Every limit for a token applies:** a daily and a weekly limit on USDC are both charged (`:1061-1074`). Exact duplicates are refused at approval (`:451-471`).
- **Approvals don't outlive the batch:** every non-zero `approve` or `increaseAllowance` made in the batch is reset to 0 through the account, and the reset is checked (`:741-766`). Permit2 approvals are cleared the same way, with Permit2's `lockdown` (`:768-788`).
- **ETH:** the sum of call values, checked against the `NATIVE_TOKEN` limit (`:628-630`, `:737-739`, constant at `:282`).
- **Periods start at the permission's `start`, not at midnight:** a daily limit is a rolling 24-hour window counted from when the agent was switched on (`:884-913`, `:975-988`). Month periods use calendar months (`:945-965`). `Forever` is one allowance for the whole permission (`:1149-1152`). The enum is `Minute, Hour, Day, Week, Month, Forever` (`:206-213`). There is no `Year`: JAW's SDK sends `'year'` as Month × 12 (`rpc/permissions.js:337-339`).
- **What a repay from savings costs against the limits:** withdraw `x` from Aave V3 (the account's USDC goes up by `x`), approve `x` to the spoke, repay `x` (USDC back down). The USDC balance doesn't drop, so the approve amount is what's charged: `x`. Measured in `ExecutorSpike.t.sol` (`test_repays_from_savings_through_the_manager`).
- **What a USDC limit does not see:** `Pool.withdraw(USDC, x, to)` moves the account's aUSDC, which is only watched if aUSDC has a spend limit. The account's USDC never moves. With no checker and no aUSDC limit, a withdrawal to another address is charged nothing. Measured in `test_only_a_savings_limit_bounds_a_withdrawal_to_someone_else`. A daily limit on aUSDC (`GUARDIAN.AUSDC`, `config.ts:15`) bounds it by the balance drop.

## 2. Events

| Event | Line | Indexed |
| --- | --- | --- |
| `PermissionApproved(bytes32 permissionHash, Permission permission)` | `:332`, emitted `:486` | the hash only; the whole permission (account, spender, salt, calls, spends) is in the data |
| `PermissionRevoked(bytes32 permissionHash)` | `:333`, emitted `:1202` | the hash |
| `CallsExecuted(bytes32 permissionHash)` | `:334`, emitted `:729` | the hash (this is the name `docs/guardian.md:48` uses) |
| `SpendLimitUsed(bytes32 permissionHash, address token, PeriodSpend periodSpend)` | `:335`, emitted `:1124` | hash and token; `periodSpend.spend` is this batch's amount, not the running total |

No manager event indexes the account. To read one account's agent moves from the manager you need its permission hashes. That is one reason the executor emits its own events indexed by account.

A Chainlink log trigger can filter on the emitter, the event signature and the indexed hash, not on the spender. Registration must decode the data and check `spender == executor` itself. Shown in `test_grant_event_indexes_only_the_hash`.

## 3. When the checks run

All checks run **before any call** (`:540-596`):

1. `msg.sender == permission.spender` (`:530`, modifier `:341-346`).
2. Approved and not revoked (`:535`, `:1082-1086`).
3. `start <= now <= end` (`:538`, `:1088-1096`). `end` is inclusive here, while JAW's SDK types call it exclusive.
4. For each call: the target is neither the manager nor the account (`:551-559`), the calldata is empty or has at least 4 bytes (`:561-565`), and at least one `calls[]` entry matches target and selector (wildcards `ANY_TARGET`/`ANY_FN_SEL` at `:292-294`, matching at `:1006-1047`). Every matching entry's checker must return true (AND logic, `:579-591`). A checker gets `(hash, account, spender, target, value, data)` (`:582-585`).

Then the calls run in one `account.executeBatch` (`:727`, `:1217-1219`), then spend is metered and approvals reset (`:731-808`). If any step fails, the whole batch reverts.

What this means: a checker can't see what earlier calls in the same batch did. Anything that depends on the result ("debt went down", "no stock left the account") has to be checked by the spender after `executeBatch` returns. GooseExecutor's post-checks do that.

## 4. Can a contract be the spender?

Yes. `executeBatch` only requires `msg.sender == permission.spender` (`:530`, `:341-346`). There is no EOA or code-size check, and `approve` only refuses a zero spender (`:368-370`). `ExecutorSpike.t.sol` runs a contract spender against the real manager on a Base fork: it repays a fresh account's loan from its savings, and a second account in the same transaction fails and rolls back alone.

Limits on the spender:

- The manager is `nonReentrant` (`:363`, `:494`, `:501`, `:529`). The executor can call `executeBatch` many times in one transaction, one after another, but not from inside a call the manager is running.
- A batch can't call the manager or the account (`:551-559`), so an agent can never add owners or change the account.
- The spender can kill a permission granted to it with `revokeAsSpender` (`:501-503`). It is permanent for that hash.

## 5. How JAW's grant stores a permission

`useGrantPermissions` (`@jaw.id/wagmi` `lib/internal/core.js:78-99`) sends `wallet_grantPermissions` with `{expiry, spender, permissions}`. The app uses CrossPlatform mode (`lib/jaw/config.ts:8-25`), so the grant runs in JAW's hosted popup. The popup's code isn't in the npm package. The only grant implementation the package ships is `grantPermissions` in `rpc/permissions.js:76-111`, and we assume the popup uses it. JustaLab can confirm this with the JAW team.

What that function builds (`apiPermissionsToPermission`, `rpc/permissions.js:217-263`):

| Field | Value |
| --- | --- |
| `start` | `Math.floor(Date.now() / 1000)`, the browser's clock (`:218`) |
| `end` | the `expiry` the app passes |
| `salt` | 256 random bits from `Math.random` (`:220`) |
| `calls[].checker` | **always `0x0`** (`:237-241`). The request type has no checker field (`rpc/permissions.d.ts:92-99`; the struct comment at `:41` says "internal only - defaults to zero address") |
| `spends[].multiplier` | the app's value, or 1 (`:251`) |

Then it sends one user operation, `[optional paymaster approval, optional spender prefund, manager.approve(permission)]` (`:81-85`, `account/Account.js:836-841`). The approve is always last, and the app can't add calls of its own. It reads the hash from the `PermissionApproved` log (`:301-329`) and stores the full permission, checker included, in JAW's relay (`:267-290`). `usePermissions` lists from that relay (`:186-213`). `useRevokePermissions` rebuilds the struct from the relay and calls `manager.revoke` (`:130-141`). A permission approved some other way isn't in the relay, so JAW's revoke can't find it ("Permission not found").

On-chain, the manager stores only `_isApproved[hash] = true` (`:485`). There is no lookup by hash: `_isApproved` and `_isRevoked` are internal (`:316`, `:321`).

**The on-chain status check** is `isApproved(p) && !isRevoked(p) && block.timestamp <= p.end`, where `isApproved` (`:815-817`) and `isRevoked` (`:819-821`) both take the full struct. Neither checks time, and `isApproved` stays true after a revoke (`_revoke` only sets `_isRevoked`, `:1190-1203`). A revoked hash can never be approved again (`:475-478`). JAW's grant always makes a new hash anyway (new salt and start), so switching an agent back on just works.

To call `isApproved` or `executeBatch` you need the whole struct. For a JAW-granted permission, it can come from the grant response (`WalletGrantPermissionsResponse`, `rpc/permissions.d.ts:218`; it leaves out the checker field), from the `PermissionApproved` log data, or from JAW's relay. The executor rebuilds it from a fixed template plus the four values the user signed: `start`, `end`, `salt` and the cap.

## 6. Must the manager own the account?

Yes. The manager runs the calls through `JustanAccount.executeBatch` (`:1217-1219`). That function needs the caller to be an owner, the account itself, or the EntryPoint (`BaseAccount.sol:62-63`, `JustanAccount.sol:397-409`, `MultiOwnable.sol:314-319`). Without that, the batch reverts with `MultiOwnable_Unauthorized`.

Who makes the manager an owner in JAW's flow:

- **Passkey accounts:** JAW's factory creates every account with owners `[passkey, manager]` (`account/smartAccount.js:372-393`; the factory call `createAccount(owners, nonce)` at `toJustanAccount.js:116-129`). Nobody has to add it. Our fork tests create accounts the same way, and the manager is an owner from the start.
- **EIP-7702 accounts:** before each user operation, the SDK checks `isOwnerAddress(manager)` and puts `addOwnerAddress(manager)` first if it's missing (`account/smartAccount.js:144-209`).
- **The grant itself** doesn't add it (`rpc/permissions.js:76-111`).
- **Accounts the SDK didn't create** (opened by address through `createSmartAccountForAddress`, `smartAccount.js:504-523`) may lack it.

Leo's `useGuardian.ts:74-77` adds `addOwnerAddress(manager)` only when it's missing. For accounts made by JAW's SDK it never fires. The executor checks `isOwnerAddress(manager)` when an account registers.

The manager owning every JAW account means it can run any call on it. What keeps that safe is the manager's code, which is immutable and only runs calls a permission allows.

## 7. What this means for D14 (JAW's screens)

D14 grants through `useGrantPermissions`. From sections 1 and 5:

- Every checker is 0, so the manager enforces only "these targets and selectors, this spender, these limits". It pins **no argument**. GuardianChecker, SaveChecker and the other checkers in the plan can't be attached this way. The executor must build every call and pin every argument itself, and its post-checks are the only argument-level guard.
- Any token a permitted call can take out of the account needs its own spend limit, or the manager charges nothing for it. For Protect · savings that means **aUSDC** next to USDC (section 1). The same holds later for each stock in Protect · sell and the Rebalancer.
- `salt` and `start` are chosen by the SDK, not by us. The app learns them from the grant response, and the executor from the `PermissionApproved` log. The permission can't be rebuilt from a fixed salt the way `GUARDIAN_SALT` (`config.ts:28`) works.
- The grant transaction can't also call `executor.register` (section 5), so registration needs either the log trigger or a second transaction.

For comparison, Leo's direct `manager.approve` through `wallet_sendCalls` (`useGuardian.ts:66-80`) can attach checkers, choose the salt and `start = now - 300`, and register in the same Face ID. It doesn't appear in JAW's permission list, can't be revoked from JAW's screens, and whether JAW's signing screen accepts it is still unverified (`docs/guardian.md:44`). The relay already stores a `checker` per call (`rpc/permissions.d.ts:191`) and `relayPermissionToPermission` already reads it (`rpc/permissions.js:156`). Only the request type and `apiPermissionsToPermission` drop it.

## 8. Other facts found on the way

- **Leo's `PERIOD` map was off by one after Month** (`Year: 5, Forever: 6`). On-chain, 5 is `Forever` and there is no 6, so `PERIOD.Forever` would have reverted (only `Day`, 2, was used). `lib/guardian/permission.ts:9` and the test interface (`contracts/test/IJustaPermissionManager.sol`) now match the source, and `tests/unit/guardian.test.ts` pins the values.
- **The Guardian salt differs between app and test:** the app uses `"guardian.v1"` hex-padded (`config.ts:28`), the fork test uses `keccak256("greedygoose.guardian.v1")` (`GuardianFork.t.sol`). It doesn't matter in the test.
- **B20 stocks can't run in Foundry.** All seven stock tokens have the one-byte code `0xef`, and Base's node runs them natively. Foundry's EVM, and so anvil, reverts on any call to them. `ForkBase.sol` puts a plain ERC-20 at the token's address and copies the real balance of every contract that holds it (today only the hub, whose books are checked on each supply). Fork tests that swap stocks (Protect · sell, Rebalancer, Credit Buy) will need the same for each pool. B20 behaviour itself (transfer policy, pauses, `uiMultiplier`) can only be tested against a Base node, with `eth_simulateV1` as `tests/onchain` does.
- **Gas, measured on a fork (cold storage):** one Protect · savings repay through the manager costs about 404k gas, about 473k with the executor's reads and post-check, and about 510k for a one-account run.
