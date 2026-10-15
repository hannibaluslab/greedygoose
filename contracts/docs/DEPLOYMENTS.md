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

`bootstrap` has not been called. Once Chainlink approves, read both forwarders with the registry's `getForwarder` and pass them in the one `bootstrap` call. For hands-on tests before that, the deployer can be bootstrapped as the only caller (it can only trigger runs; every run is re-checked on-chain and money only moves within each account), and the Chainlink forwarders are then added through the 7-day delay.

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
