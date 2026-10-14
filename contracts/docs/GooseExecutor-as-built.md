# GooseExecutor as built (M2)

What `src/GooseExecutor.sol` does differently from [GooseExecutor.md](./GooseExecutor.md), and why. The spec is unchanged; read the two together.

| Spec | As built | Why |
| --- | --- | --- |
| `PAGE_SIZE = 48` (§6, an estimate) | 40 | Measured cold on a Base fork (`ExecutorPageForkTest`): an account that owes against all seven stocks, sits in Watch and has too little savings costs about 204k gas to check, so 40 fit under 8.5M (8.2M). One stock costs about 119k. |
| A scan starts at the page's first account | It starts one account further on each pass | A page that runs out of gas or fills `MAX_WORK` would otherwise never reach its tail. |
| `checkData = (Lane, stride, offset)` | `(shard, shards)` | One lane in M2, and a new lane means a new contract anyway (§1). Same rotation: the upkeep owns pages with `p % shards == shard`. |
| Protect reads savings, both limits and the status once the trigger fires | Savings first; the limits only with savings | No savings means no repay; saves two reads (about 38k cold). |
| The executor's USDC, aUSDC and ETH are 0 after a move | Not higher than before the move | Anyone can send the executor a token; a 0 check would let one transfer stop every run. |
| Protect's limit left = `min(USDC left, aUSDC left)` | aUSDC left minus 2 units | The manager charges the aUSDC drop, which Aave's rounding can make a unit or two larger than the amount. |
| A newer grant replaces the stored one (§4) | Only one that starts no earlier; the same grant again is a no-op; failures carry over unless the grant is new | So an older grant the user never revoked can't replace a newer one, and re-registering can't reset a failing account's back-off. `checkLog` skips both cases too. |
| `queue` / `apply` / `cancel` (§9) | `queueChange` / `applyChange` / `cancelChange` | `apply` is reserved in Solidity. `ChangeQueued` also carries the nonce `applyChange` needs. |
| Events | Adds `CodehashSet` and `OwnerSet`; a paused run reverts `RunsPaused` | Every admin change is visible on-chain. |
| `runAccount(lane, account) returns (bool)` | `runAccount(account, preFreeze)`, capped at `RUN_GAS` (1.3M) | The window is computed once per run; the cap holds one account's whole sub-call, not just the manager batch. |
| Holidays (§7) | None at deploy; added through `queueChange(SetHoliday)` | They wait for Chainlink's 24/5 schedule to be checked (item 6 step 9). |

Facts found on the way:

- The manager's daily window includes its last second: at exactly `start + 24 h` the old period still counts.
- With the deploy defaults (trigger 1.50, drop 15%, floor 1.10), Weekend Shield never acts before Watch does: 1.10 / 0.85 = 1.29 < 1.50. The fork test runs it with a 30% drop and a 1.40 floor. Calibration is item 6 step 9.
- The contract only fits under 24 KB through the IR pipeline at 200 runs (`foundry.toml` restricts that to this file). Tests that import it compile the same way, and there `block.timestamp` can be reused after a warp, so they read the time with `vm.getBlockTimestamp()`.
- Measured cold: a run of `MAX_WORK` Protect repays uses 3.8M of Base's 5M perform limit.
