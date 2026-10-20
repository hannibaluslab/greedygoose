# Deployments

## Base mainnet — D13 test deploy (2026-10-15)

Daily limits capped at $5 (`TEST_CAP_MAX`), for throwaway accounts only. Not wired into any production config; the app reads it only from a developer's `.env.local` (`NEXT_PUBLIC_GOOSE_EXECUTOR`).

| What | Value |
|---|---|
| GooseExecutor | `0x778d632484499aE6Ad2480b2ff85C164C29eA71b` (23,920 bytes) |
| Owner (test only) | `0xF3bBaa5f6BEAF49732c28D2bdd2b772AA01031aD`, the JustaLab test deployer |
| Built from | `main` @ `6a2ce46` |
| Deploy cost | about 0.000073 ETH |

### Chainlink Automation (registrar `0xE28Adc50c7551CFf69FCF32D45d037e5F6554264`, registry 2.3)

Base mainnet's registrar has auto-approve **off** for both trigger types (`getTriggerRegistrationDetails` returns `DISABLED`), so registrations wait for Chainlink to approve them. Both were sent with 0.0004 ETH each (wrapped to WETH by the registrar, the minimum for WETH):

| Upkeep | Trigger | Gas limit | Request hash | Tx |
|---|---|---|---|---|
| greedygoose-test-run | custom logic, `checkData = abi.encode(0, 1)` | 5,000,000 | `0x645515adbdcc7d948d234a93239c807467595ffe3dfd6ef50bc2d7b4822c4507` | `0x0b4047ac3c2bd4283556af4743fbf1fca2823986439701682423cf56b3d7d330` |
| greedygoose-test-register | log: the manager's `PermissionApproved` | 1,000,000 | `0xbb5b3c43b851ec929de1f81d27a3d2a7ebc1d906c6501401a2875a54a64c2d19` | `0x3d58df69cb97faf5b3c0b3cf8bd09c4a6b605b8abe6335c45109932bd3f22fa5` |

The admin (the deployer) can `cancel(hash)` a pending request to get its WETH back.

### Not done yet

*(Superseded by "The next deploy carries the Act-only defaults" below: don't bootstrap this deploy. Bootstrapped, it would run its old rules on Base, repaying in Watch below 1.50 and Weekend Shield's repay, within its $5 limits. Cancelling the two pending upkeep requests to get their WETH back is a mainnet transaction, Adrian's call.)*

`bootstrap` has not been called. Once Chainlink approves, read both forwarders with the registry's `getForwarder` and pass them in the one `bootstrap` call. For hands-on tests before that, the deployer can be bootstrapped as the only caller (it can only trigger runs; every run is re-checked on-chain and money only moves within each account), and the Chainlink forwarders are then added through the 7-day delay.

### The next deploy carries the Act-only defaults (2026-10-15)

Act is the line (JUSTALAB-DECISIONS.md, "Act is the line (Adrian, 2026-10-15)"): Protect steps in only below 1.10 and brings the credit back to Watch at 1.20. This D13 deploy can't be moved there through its 7-day delay: its bounds keep Protect's trigger at 1.20 or more, and its code still has Weekend Shield's repay. In the next deploy Protect's trigger and the sale's heads-up line are both pinned to the Act line, so no change through the delay can move either: not into Watch, not deeper into Act, and never the sale's line above the cash line. It is throwaway, so the next deploy replaces it rather than a threshold change. Nothing has been deployed for this.

| Number | This deploy (`0x778d…A71b`) | Next deploy (`script/DeployExecutor.s.sol`, `config/risk.ts`) |
|---|---|---|
| Protect from cash: trigger → target | 1.50 → 1.65 | 1.10 → 1.20 |
| Protect · sell: heads-up / at once → target | 1.25 / 1.10 → 1.40 | 1.10 / 1.05 → 1.20 |
| Weekend Shield | repays before a freeze | gone (the app shows a card only) |
| Bounds: trigger · Protect target | 1.20–2.00 · up to 2.50 | pinned at 1.10 · 1.15 to 1.40 |
| Bounds: heads-up · at once · sale target | 1.10–1.50 · 1.02 up to the heads-up · up to 2.00 | pinned at 1.10 · 1.05 to 1.08 · 1.15 to 1.40 |

When it is redeployed: point `NEXT_PUBLIC_GOOSE_EXECUTOR` and `NEXT_PUBLIC_GOOSE_EXECUTOR_BLOCK` at the new address in the developer's `.env.local`, register the two upkeeps again, and record the deploy here. Grants made to this deploy name it as spender and don't carry over: each test account switches its agents on again.

### The next deploy carries Protect's line and the runner switch (2026-10-19)

Supersedes the Act-only table above for the next deploy (JUSTALAB-DECISIONS.md, "2026-10-19 · Protect's line and the runner switch"; GooseExecutor-as-built.md, the same section). Built on branch `jl/runner-switch`; nothing has been deployed for it.

| Number | Act-only plan (2026-10-15) | Next deploy (`script/DeployExecutor.s.sol`, `config/risk.ts`) |
|---|---|---|
| Protect: line → target | 1.10 → 1.20 | 1.03 → 1.12, savings first, then selling; the rescue goes on until 1.12 |
| Protect · sell | heads-up 1.10, 30 min, at once 1.05; floors 1% / 3% | at once below 1.03 or during a rescue; one floor, 3% |
| Amount limit | the user's daily limit, at most CAP_MAX | none: CAP_MAX = the largest uint160 with `EXECUTOR_CAPS=none` ($5 on a D13 test deploy); a move may not leave the health above target + 0.01 |
| Weekend card floor | 1.10 | 1.0 (Aave's line) |
| Runners | two Automation upkeeps | `GooseReceiver` (CRE, `script/DeployReceiver.s.sol`) and KeeperHub's wallet, both in the one `bootstrap` |
| Registration | Automation's log trigger | `registerApproved` from the PermissionApproved data, after `registrationOf` |

After the deploy, the same day: deploy the receiver, `bootstrap([receiver, KeeperHub wallet])`, queue the NYSE holidays (each waits 7 days), cancel the two pending Automation requests above (Adrian signs; 0.0008 WETH back), and record it all here.

### The next deploy carries top-ups into the mix (2026-10-20)

Adds to the runner switch's next deploy above (GooseExecutor-as-built.md, "Rebalance's top-ups (2026-10-20)"). Built on branch `jl/rebalance-topups`; nothing has been deployed for it. A new executor is a new spender, so every account grants all its agents again.

| What | Executor live today | Next deploy |
|---|---|---|
| Top-ups into the mix | none | `setTopUps(on, keep)`, `topUps(account)`; Save counts, Rebalance puts in from savings at the next market morning |
| Rebalance's grant | no Aave call | with top-ups: Aave V3's savings withdraw (to the account only) and an aUSDC limit at spends[1], a week, at CAP_MAX |
| Save's grant | $1,000 a day | CAP_MAX, a day (P2): Rebalance's Save grants it so; Start earning still grants $1,000 a day until Cash setup moves to `startCapRaw` |
| Registration | `register(...)` and `registerApproved` | `registerApproved` only |
| Reads | `jobsOf` | gone: the app reads `accounts`, which both executors have |
| Events | | `TopUpsSet`, `TopUpCounted`, `TopUpInvested` |
| Size | 24,381 bytes | 24,365 bytes |

The app works with both until the switch: it reads `topUps(account)` with `allowFailure`, and a revert means "Not available yet" (M5, built: JUSTALAB-DECISIONS.md, "2026-10-20 · Top-ups wired in the app (M5)").

### Check after the next deploy: JAW's account clone is allowed (2026-10-20)

An account JAW hasn't deployed yet (money arrived, nothing ever sent) starts earning in one Face ID: JAW's factory deploys it first, in the same user operation, then the batch supplies to savings, approves Save and registers it (JUSTALAB-DECISIONS.md, "One Face ID for a never-used account too"). The app can't simulate that registration from a bare address, so the executor must allow the code JAW's factory deploys. If it doesn't, the whole batch reverts on Base: no money moves, but the user pays the network fee.

| What | Value |
|---|---|
| Codehash | `0xc79e2c8f7a03b38abd65a7e073fc3410849544bba74f53360c127775bc891848`, the EIP-1167 clone of JAW's implementation `0xbb4f7d5418Cd8DADB61bb95561179e517572cBCd`, which is what JAW's factory `0x5803c076563C85799989d42Fc00292A8aE52fa9E` deploys |
| Measured | 2026-10-20 on Base through a keyless RPC: `cast codehash 0x14087c532332dE6E971Eb2F60a252cbf511F59eA`, a passkey account with owners [passkey, manager] that the factory's `getAddress(owners, 0)` gives |
| Set by | `script/DeployExecutor.s.sol`: `jawCodehashes()[0]`, pinned as `JAW_CLONE_CODEHASH`. `checkCode` refuses a list without it (and a factory that clones other code), and `run` reads it back from the new executor; forge runs both before it sends anything |
| Proven | `DeployExecutorTest.test_the_script_deploys_an_executor_that_allows_jaws_account_clone` (the script's own run on a Base fork) |

After the deploy, before the app points at it:

```sh
cast call <executor> 'allowedCodehash(bytes32)(bool)' 0xc79e2c8f7a03b38abd65a7e073fc3410849544bba74f53360c127775bc891848 --rpc-url https://mainnet.base.org
# true. If false, don't point the app at it: every never-used account's Start earning would revert.
cast call 0x5803c076563C85799989d42Fc00292A8aE52fa9E 'getImplementation()(address)' --rpc-url https://mainnet.base.org
# 0xbb4f7d5418Cd8DADB61bb95561179e517572cBCd, so the clone above is still what new accounts run.
```

## GooseBoard — not deployed yet

The leaderboard's member list (`src/GooseBoard.sol`, JUSTALAB-DECISIONS.md "The Leaderboard"). It holds nothing, calls nothing and has no owner: an account only puts itself on (`join()`) or takes itself off (`leave()`, not in the app). The deployer key pays the gas and gets no power over it. Adrian approves and signs the mainnet deploy; nobody else deploys it to Base.

### Deploy

```sh
cd contracts
forge build
# Rehearse on a Base fork first (nothing is sent anywhere):
BASE_RPC_URL=https://mainnet.base.org forge test --match-contract GooseBoard
# Then Base mainnet. The signer comes from forge's wallet flags, so the key never lands in the shell's history or a file:
forge script script/DeployGooseBoard.s.sol --rpc-url https://mainnet.base.org --broadcast --account <keystore name>
#   a keystore made once with `cast wallet import <name> --interactive`; or --ledger; or --interactives 1 (hidden prompt)
```

Don't put the key on the command line (`DEPLOYER_PRIVATE_KEY=0x… forge script …` stays in the shell's history). The script still reads `DEPLOYER_PRIVATE_KEY` when it is set, for the fork rehearsals.

The script prints the address and the block. Optionally verify the source (`forge verify-contract <address> src/GooseBoard.sol:GooseBoard --chain base`, with a Basescan key).

### Then

- **First, the RPC.** Set `NEXT_PUBLIC_BASE_RPC_URL` to an RPC that serves `eth_getLogs` over the board's whole history (10,000 blocks a request) and past state, and check it answers a range from the deploy block. Without it the board reads logs from PublicNode's keyless endpoint, which answers only for about the last 10,000 blocks (measured 2026-10-15), so the board can't load once its first member joined more than about five hours earlier. The same variable is the whole app's Base transport (`lib/jaw/config.ts`), and like every `NEXT_PUBLIC_*` value it ships in the page, so use a key that is meant to be public (an origin-restricted one).
- **Then** set `NEXT_PUBLIC_GOOSE_BOARD=<address>` in the app's environment, and not before the RPC above: from then on every account's first move carries `join()` at the end of its batch, and the Leaderboard tab reads the list.
- Record the deploy here: address, block, commit, cost.

| What | Value |
|---|---|
| GooseBoard | not deployed |
| Bytecode | about 1.9 KB (`forge inspect GooseBoard deployedBytecode`) |
| Rehearsed | Base fork: `GooseBoardForkTest` (JAW account batch: EFP mint + follow + join), `scripts/board-e2e.ts` (anvil) |
