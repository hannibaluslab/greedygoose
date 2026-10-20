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

When it is redeployed: point `NEXT_PUBLIC_GOOSE_EXECUTOR` and `NEXT_PUBLIC_GOOSE_EXECUTOR_BLOCK` at the new address in the developer's `.env.local`, register the two upkeeps again, and record the deploy here. Grants made to this deploy name it as spender and don't carry over: each test account switches its agents on again. *(For the next deploy, superseded by the runner switch below: there are no upkeeps to register, since its runners are `GooseReceiver` and KeeperHub's wallet.)*

### The next deploy carries Protect's line and the runner switch (2026-10-19)

Supersedes the Act-only table above for the next deploy (JUSTALAB-DECISIONS.md, "2026-10-19 · Protect's line and the runner switch"; GooseExecutor-as-built.md, the same section). Built on branch `jl/runner-switch`; nothing has been deployed for it.

| Number | Act-only plan (2026-10-15) | Next deploy (`script/DeployExecutor.s.sol`, `config/risk.ts`) |
|---|---|---|
| Protect: line → target | 1.10 → 1.20 | 1.03 → 1.12, savings first, then selling; the rescue goes on until 1.12 |
| Protect · sell | heads-up 1.10, 30 min, at once 1.05; floors 1% / 3% | at once below 1.03 or during a rescue; one floor, 3% |
| Amount limit | the user's daily limit, at most CAP_MAX | none: CAP_MAX = the largest uint160 with `EXECUTOR_CAPS=none` ($5 on a D13 test deploy); a move may not leave the health above target + 0.01 |
| Weekend card floor | 1.10 | 1.0 (Aave's line) |
| Runners | two Automation upkeeps | `GooseReceiver` (CRE, `script/DeployReceiver.s.sol`) and KeeperHub's wallet, both in the one `bootstrap` |
| Registration | Automation's log trigger | `registerApproved(bytes)`, the permission as PermissionApproved logs it, after `registrationOf`. The app sends it from the user's own account in the same batch as the grant's approve ("Registration route" below) |

After the deploy, the same day: deploy the receiver, `bootstrap([receiver, KeeperHub wallet])` (or KeeperHub's wallet alone while the receiver waits on Chainlink: step 7 of the go-live checklist below), queue the NYSE holidays (each waits 7 days), cancel the two pending Automation requests above (Adrian signs; 0.0008 WETH back), and record it all here.

### The next deploy carries top-ups into the mix (2026-10-20)

Adds to the runner switch's next deploy above (GooseExecutor-as-built.md, "Rebalance's top-ups (2026-10-20)"). Built on branch `jl/rebalance-topups`; nothing has been deployed for it. A new executor is a new spender, so every account grants all its agents again.

| What | Executor live today | Next deploy |
|---|---|---|
| Top-ups into the mix | none | `setTopUps(on, keep)`, `topUps(account)`; Save counts, Rebalance puts in from savings at the next market morning |
| Rebalance's grant | no Aave call | with top-ups: Aave V3's savings withdraw (to the account only) and an aUSDC limit at spends[1], a week, at CAP_MAX |
| Save's grant | $1,000 a day | CAP_MAX, a day (P2), from Rebalance's Save and from Start earning alike (`hooks/useCashSetup.ts`, c1e5e75) |
| Save's keep-back | $1, bounds $0 to $5 | $1, bounds $0.60 to $5 (`CashRules.KEEP_BACK_MIN`, 49ce111): no change through the delay can set it under the $0.50 fuel tank plus Fill up's 2-cent margin, so Save never sweeps a fill-up back into savings and counts it as a top-up |
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
| Proven | `DeployExecutorTest.test_the_script_deploys_an_executor_that_allows_jaws_account_clone` (the script's own run on a Base fork); `OneTapNewAccountForkTest` (Base fork, the real EntryPoint v0.8: a never-used passkey account deployed by the factory's initCode and earning in the same user operation; with an executor that doesn't allow the clone, the batch reverts and nothing moves) |

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

## KeeperHub runner (2026-10-19)

KeeperHub (app.keeperhub.com) runs GooseExecutor without waiting for Chainlink: Automation's two upkeep requests above have waited for manual approval since 2026-10-15, and the CRE runner (`GooseReceiver`) waits for Chainlink to enable deploy access. KeeperHub's wallet only wakes the executor. It holds no user money, sits in no JAW permission, and every run is re-checked on-chain. KeeperHub signs only with its own wallet (Turnkey) or a Safe, so the runner can't be a JAW account: acting through a JAW permission would put the run inside the manager's `nonReentrant` call, and the run calls the manager again for each user (MANAGER-NOTES.md §4).

| What | Value |
|---|---|
| Account | KeeperHub organization `fcafd72a-4364-412f-b6c2-d4cfec96abbb`, Free plan (Adrian, 2026-10-19) |
| Runner wallet | `0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93` (KeeperHub's Turnkey wallet): the address for `bootstrap` |
| Plan | 5,000 runs a month, and one run counts once whatever it does (read, condition and write together). $1 of sponsored gas a month, then the wallet pays its own ETH |
| Spend caps | Pay-as-you-go daily and monthly caps set to 0 USDC, so runs past 5,000 are blocked and nothing is ever charged |

### Sender check (Base Sepolia, 2026-10-19)

A sponsored KeeperHub write is a type-4 (EIP-7702) transaction: relayer `0x6331eb4571DE9284f7E9eAD98ac7b0661a091E99` → Turnkey's gas station `0x5aF5194B4b0909eB978e3Cf1e25333852277f07D` → the wallet (delegated to `0x955d84139e7621bc571b117d8eb5d28a4a222c6f`) → the target. In tx `0x0ffbab34f60c1beacc6f84a9925ff462e6d324cfd8f1bc9a3e6af23c5324f7a6` (WETH `deposit()`, value 0), WETH's `Deposit` names the wallet, so **`msg.sender` at the target is the wallet** and `bootstrap` takes its address. The wrapper costs about 60k gas, and KeeperHub's gas limit is the outer transaction's, so writes carry a fixed 5,500,000 to leave `performUpkeep` its 5M.

### Workflows (both off)

| Workflow | Id | What it does | State |
|---|---|---|---|
| GreedyGoose round (Base) | `q5vdv47dieyabhg4toiue` | Every 10 min (`*/10 * * * *`): `checkUpkeep(abi.encode(0, 1))` → if `upkeepNeeded`, `performUpkeep(performData)`, then the same check and run once more (a rescue left unfinished goes on in the same run). Gas 5,500,000 on each write, sponsored | Built, off. Its executor address is the old test deploy as a placeholder: point it at the new executor before switching it on |
| GreedyGoose registration (Base) | `a0t6mjkoezs3k5fdm2k03` | On JAW's manager `PermissionApproved` (`0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8`): `registrationOf(permission)` → if ok, `registerApproved(permission)` | Draft, off, **blocked**: KeeperHub's form can't fill the permission's `calls[]` and `spends[]` from the event (they take only fixed objects). Unblocked by an executor entry that takes the permission as one `bytes` value, fed by a KeeperHub "Run Code" step, or by CRE. *(Superseded by "Registration route" below: the app registers, and this draft stays off.)* |

Budget: the round runs 4,464 times in a 31-day month. Each `PermissionApproved` on Base adds one run, from any JAW app (measured 0 in 6 hours on 2026-10-19). That leaves about 536 runs a month. If registrations grow, move the round to every 12 minutes (3,720 runs). *(With the registration workflow off, "Registration route" below, no `PermissionApproved` adds a run: the round is the whole budget.)* Gas: a Protect repay costs about 1 cent, a seven-stock sale about 7 cents, and a check that finds nothing costs nothing.

Protect timing with the round alone: Protect acts below 1.03 and Aave liquidates at 1.0, a further fall of about 2.9%, or about 6 feed steps of 0.5% (the largest step measured was −2.13%). A 10-minute round is usually in time, but it can be late on a very fast drop. The price-feed triggers come with CRE.

### Go-live checklist

| # | Step | Who | State |
|---|---|---|---|
| 1 | KeeperHub account, wallet, caps at 0, sender check | Adrian, Claude | Done |
| 2 | `jl/runner-switch` lands on v2: money-safety review, fork tests on a public RPC (never the app's Alchemy key) | Runner session, Adrian's OK | Done: on main (30e2b3d and the runner switch's commits before it) |
| 3 | Registration route for KeeperHub (the registration workflow above) | Runner session | Done another way: the app registers each grant in the grant's own batch ("Registration route" below) |
| 4 | Pre-launch values: pin the executor's address and code hash in the app; production `CAP_MAX` (`EXECUTOR_CAPS=none`); EntryJob's coins = `CASH_COINS` (USDT, USDe, USDS, DAI, EURC; USDbC out); Protect below 1.03 → 1.12, selling at once, the rescue going on to the target | Runner session | EntryJob still lists USDbC and no DAI/EURC on main (`contracts/src/jobs/EntryJob.sol`, 4 coins) |
| 5 | Top up the deployer if needed (it holds 0.0011 ETH; the redeploy is about 26M gas, about 0.00016 ETH at 0.006 gwei plus the L1 fee) | Adrian | Open |
| 6 | Deploy the executor, then the clone check above (`allowedCodehash` of JAW's clone is true) before step 13 points the app at it | Adrian signs | Open |
| 7 | `GooseReceiver`: needs the CRE workflow's owner address, known once CRE deploy access lands. If it's not known by then, bootstrap KeeperHub alone and add the receiver later through the 7-day `AddForwarder` | Adrian signs | Waiting on Chainlink |
| 8 | `bootstrap([KeeperHub wallet(, receiver)])`, once | Adrian signs | Open |
| 9 | Queue the NYSE holidays (`SetHoliday`, 7 days each), then apply them | Adrian signs | Open |
| 10 | Cancel the two Automation requests above (0.0008 WETH back to the deployer) | Adrian signs | Open |
| 11 | Optional gas backup: a little ETH (or USDC, which KeeperHub converts) in the runner wallet for when the $1 credit runs out | Adrian | Open |
| 12 | Point the round workflow at the new executor, then switch it on. The registration draft stays off ("Registration route" below) | Claude, with Adrian's OK | Open |
| 13 | Vercel: `NEXT_PUBLIC_GOOSE_EXECUTOR` (and `_BLOCK`) and `NEXT_PUBLIC_AGENTS_LIVE=1`; `NEXT_PUBLIC_ALCHEMY_KEY` added in the dashboard by Adrian (or `--build-env`); deploy per HANDOVER-2026-10-19.md (the owner's handover, kept outside this repo) | Adrian's OK | Open |
| 14 | Check: read `planOf` and `checkUpkeep` for a test account, then a first real run while Adrian watches (KeeperHub's run log and Basescan) | Adrian, Claude | Open |

### Registration route (2026-10-20)

Supersedes the registration row in the workflows table and step 3 of the checklist above. KeeperHub's free tier can't register grants: its "Run Code" step needs the Pro plan, the `PermissionApproved` trigger doesn't expose the raw log data, and a Webhook trigger would need an org API key inside the app. Adrian picked **the app registers**. For each new grant (Protect, Protect · sell, Rebalance, Save, Entry), the app sends `registerApproved(abi.encode(permission))` from the user's own account, in the same batch as the grant's `manager.approve`: one change, one Face ID, and a batch that doesn't land changes nothing (`lib/tx/plans/agents.ts` `agentChangePlan`, `lib/agents/register.ts`; JUSTALAB-DECISIONS.md, "2026-10-20 · One signature per change: D14 dropped"). It was first built as a second sheet after JAW's own grant sheet, with the switch showing "starting" until `JobOn` landed; "starting" now only shows for a grant made on JAW's sheet before that change (`lib/agents/status.ts`). The executor takes the permission as one `bytes` value (`registrationOf(bytes)`, `registerApproved(bytes)`, 30e2b3d, on main), built by the runner session. KeeperHub runs the round only. The registration draft (`a0t6mjkoezs3k5fdm2k03`) stays off and unused, and so does a scratch draft (`99nwsagilzw24qo11pbd6`). Once CRE is live, its log trigger could register too; the app's batch doesn't depend on it.
