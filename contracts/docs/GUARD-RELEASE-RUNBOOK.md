# Guard release runbook: GooseExecutor 0x686c → GooseGuard + GoosePlanner

The exact steps to move production from GooseExecutor `0x686cd88F248DE3F9FC0835566DB798D93881F02D` to GooseGuard and GoosePlanner, in one 30-minute window. Written 2026-10-23 on branch `jl/guard-r2-fixes` @ `43db81c`. **Nothing here has been done yet.**

It closes the gaps the swap rehearsal and Mariano's round-2 review found:

| Gap | Where it is closed |
|---|---|
| 1. The accounts must hold Guard grants before KeeperHub moves, or nobody is protected in between | Step 4, before step 5 |
| 2. GG-05: revoke the 0x686c grants before the repoint | Step 4 (the app revokes them in the same one-tap batch that grants the Guard) |
| 3. Switch the round workflow off while its four Web3 steps change. Keep each step's stored ABI. Second read takes `abi.encode(1,1)` | Step 5 |
| 4. Pause 0x686c in the same sitting as the repoint | Step 6 |
| 5. LV-16: the runner wallet holds 0 ETH on a $1 monthly credit. Fund it and add alerts | P5, P6, step 9 |
| 6. LV-20: the owner is a Safe. Deploy with `GUARD_OWNER` = the Safe | P3, step 2 |
| 7. The live test on the two team accounts, what to watch, the rollback | Step 7, Rollback |

Sources: `script/DeployGuard.s.sol`, `docs/DEPLOYMENTS.md`, `test/audit/GuardSwapRehearsalFork.t.sol` (passes 7 of 7 on a Base fork at block 52,946,000, 2026-10-23), and the live-test steps in `guard-build/design/integration-note-2026-10-22.md`.

**Who signs.** The owner signs every transaction, never Claude. Each team account signs its own grants with Face ID. KeeperHub is edited by Adrian (or by Claude in the browser pane, only with Adrian's OK for that edit).

**Shell.** Every command is for zsh (macOS default). Signer flags are placeholders: `--account <deployer keystore>` (a keystore made once with `cast wallet import <name> --interactive`), or `--ledger`. Never put a key on the command line. Never use the app's Alchemy key here: every command uses the keyless `https://mainnet.base.org`.

---

## The 30 minutes

It fits in 30 minutes only if everything under "Before the window" is done first. Nothing in the window waits on the Guard's 48-hour queue.

| Clock | Step | Time |
|---|---|---|
| 0:00 | 1. Pre-checks | 2 min |
| 0:02 | 2. Deploy, then read back | 5 min |
| 0:07 | 3. Check the preview build points at the new addresses | 1 min |
| 0:08 | 4. Both team accounts grant their agents to the Guard; the same one-tap batch revokes their 0x686c grants | 6 min |
| 0:14 | 5. KeeperHub: off, four steps changed, read back, on | 6 min |
| 0:20 | 6. First green run, then pause 0x686c | 2 min |
| 0:22 | 7. Live test: Protect on A1, a plain round on A2 | 4 min |
| 0:26 | 8. Release the app (about 5 min of build) | after |

Step 8 can start at 0:20 in a second terminal. Then the window ends at 0:26. The cost: if the live test fails after the release, the rollback also promotes the old app (one command, below). The safer order releases after step 7, about 31 minutes in all. Adrian picks.

### What money buys

- **The runner never waits on the $1 credit.** Fund the runner wallet before the window (P5). This is the only real spend.
- **No 10-minute waits.** Use KeeperHub's "Run now" in steps 6 and 8 instead of waiting for the next tick. Each manual run counts as one of the free plan's 5,000 runs a month. No paid plan is needed.
- **Gas.** The deploy simulated at 29.9M gas, at most 0.00031 ETH (2026-10-23). The deployer held 0.00099 ETH at block 52,946,000.

What money can't buy: a wrong owner or runner on the Guard takes 48 hours to change. Don't queue a fix. Deploy again (cents, 3 minutes) and use the new addresses.

---

## Before the window

Do these the day before, or any time before. None of them touches production.

**P1. The code is on `origin/main`.** `scripts/release.sh` only releases a commit on `origin/main`. Merging `jl/guard` (with the round-2 fixes) is Adrian's call, after Mariano's yes. Note the commit: it is `<release commit>` below.

**P2. The rehearsal passes on today's chain.** From the release checkout:

```sh
cd <release checkout>/contracts
forge build
BASE_RPC_URL=https://base-rpc.publicnode.com forge test --match-path test/audit/GuardSwapRehearsalFork.t.sol -vv
# 7 passed, 0 failed. Unset REHEARSAL_BLOCK means today's latest block, with A1 and A2's real positions.
```

**P3. The Safe (LV-20).** The Safe is the Guard's owner. It must exist on Base, with its signers ready to sign a pause in minutes.

```sh
export RPC=https://mainnet.base.org
export SAFE=<the Safe's address on Base>
cast code $SAFE --rpc-url $RPC | wc -c                       # more than 3: the Safe has code on Base
cast call $SAFE 'getThreshold()(uint256)' --rpc-url $RPC      # 2 or more
cast call $SAFE 'getOwners()(address[])' --rpc-url $RPC       # the team's signers, nobody else
```

The deployer key only pays the gas. It gets no power over the Guard. 0x686c's owner stays the deployer key `0xF3bB…31aD`, which signs step 6.

**P4. The deployer.**

```sh
export DEPLOYER=0xF3bBaa5f6BEAF49732c28D2bdd2b772AA01031aD
cast balance $DEPLOYER --ether --rpc-url $RPC   # 0.0005 or more
```

From now until step 2, **the deployer sends nothing else.** The fast path below predicts the addresses from its nonce.

**P5. Fund the runner wallet (LV-16).** KeeperHub's wallet `0x9c74…3E93` pays its own gas once the $1 monthly credit is gone. Measured costs: a Protect repay is about 1 cent, a seven-stock sale about 7 cents. Send about 0.005 ETH. Send a small test amount first.

```sh
export RUNNER=0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93
cast send $RUNNER --value 0.0001ether --rpc-url $RPC --account <funding keystore>
cast balance $RUNNER --ether --rpc-url $RPC     # 0.0001: it can receive
cast send $RUNNER --value 0.0049ether --rpc-url $RPC --account <funding keystore>
cast balance $RUNNER --ether --rpc-url $RPC     # 0.005
```

KeeperHub's wallet page also accepts USDC and converts it, if that is easier. Check that page shows the balance too.

**P6. Alerts for the round.** In KeeperHub, turn on notifications (email or Telegram) for failed runs of the round workflow `q5vdv47dieyabhg4toiue`. Send a test notification and check it arrives. Step 9 adds the runner-balance and pause alerts once the Guard's address is known.

**P7. Write down the round workflow as it is today.** Open `q5vdv47dieyabhg4toiue` in KeeperHub. For each of the four Web3 steps, note the contract address, the function, the arguments, the gas limit (writes: 5,500,000) and the stored ABI. Take a screenshot of each. This is the rollback.

| Step id | What | Today | After step 5 |
|---|---|---|---|
| `qzina2TKKSlFGMMfC6qbW` | read 1: `checkUpkeep(abi.encode(0,1))` | 0x686c | GoosePlanner, args unchanged |
| `2_4afTvEv5AZkdoX1m4w9` | write 1: `performUpkeep(performData)`, 5.5M gas | 0x686c | GooseGuard |
| `RD4QxUVvop4xkwtAVdwu6` | read 2: `checkUpkeep(abi.encode(0,1))` | 0x686c | GoosePlanner, args `abi.encode(1,1)` |
| `tth32myHzckGycsW8SHAe` | write 2: `performUpkeep(performData)`, 5.5M gas | 0x686c | GooseGuard |

**P8. Predict the addresses and build the preview (the fast path).** The script deploys five contracts from the deployer, in this order: GooseGuard, ProtectPlanner, TradePlanner, CashPlanner, GoosePlanner. So the Guard lands at the deployer's next nonce and the Planner four nonces later. A dry run shows the same (checked 2026-10-23).

```sh
N=$(cast nonce $DEPLOYER --rpc-url $RPC)
export GUARD=$(cast compute-address $DEPLOYER --nonce $N | awk '{print $NF}')
export PLANNER=$(cast compute-address $DEPLOYER --nonce $((N+4)) | awk '{print $NF}')
export GUARD_BLOCK=$(cast block-number --rpc-url $RPC)   # a block before the deploy: the app reads history from here
echo $GUARD $PLANNER $GUARD_BLOCK

# The dry run: simulated on today's Base, nothing is sent. Its "== Return ==" must print the same two addresses.
cd <release checkout>/contracts
GUARD_OWNER=$SAFE forge script script/DeployGuard.s.sol --rpc-url $RPC --sender $DEPLOYER
rm -rf broadcast/DeployGuard.s.sol/8453/dry-run cache/DeployGuard.s.sol/8453/dry-run
```

Then build a **preview** (not production) of the release commit with those values. The team accounts grant their agents on it in step 4, while production still runs 0x686c. Run it from the repo root, linked to Vercel:

```sh
cd <release checkout>
SHA=<release commit>
SRC=$(mktemp -d); git archive $SHA | tar -x -C $SRC; cp -R .vercel $SRC/.vercel
val() { grep "^$1=" .env.local | head -1 | cut -d= -f2-; }
(cd $SRC && vercel deploy --yes --force \
  --build-env NEXT_PUBLIC_JAW_API_KEY="$(val NEXT_PUBLIC_JAW_API_KEY)" \
  --build-env NEXT_PUBLIC_ALCHEMY_KEY="$(val NEXT_PUBLIC_ALCHEMY_KEY)" \
  --build-env NEXT_PUBLIC_BASE_RPC_URL="$(val NEXT_PUBLIC_BASE_RPC_URL)" \
  --build-env NEXT_PUBLIC_GOOSE_GUARD=$GUARD \
  --build-env NEXT_PUBLIC_GOOSE_GUARD_BLOCK=$GUARD_BLOCK \
  --build-env NEXT_PUBLIC_GOOSE_PLANNER=$PLANNER \
  --build-env NEXT_PUBLIC_AGENTS_LIVE=1 \
  --build-env NEXT_PUBLIC_GOOSE_BOARD=0x0E10c55D3f20D4Ea1DEf5aC6c60480b34c07FcA1 \
  --build-env NEXT_PUBLIC_WALL_FROM_BLOCK=52912478)
rm -rf $SRC
# Prints the preview URL. Note it: <preview URL>.
```

`NEXT_PUBLIC_JAW_API_KEY` lives in Vercel's production env. If `.env.local` doesn't hold it, copy it from there first. Check the preview before the window: sign in with each team account and see its balances (JAW's passkeys are cross-platform, so the same account signs in on the preview). If JAW's key only allows some origins, add the preview's domain in JAW's dashboard.

Without the fast path, build the preview right after step 2 instead. That adds about 5 minutes.

**P9. Positions for the live test.** Both team accounts keep small positions (no amount limit anywhere, decision 9: these are real grants and real money). For step 7, A1 needs health between 1.10 and 1.30, and a few dollars in savings or in the wallet above $1 (Protect repays from there).

---

## Set up the shell (start of the window)

Paste this once. Every later step uses it.

```sh
export RPC=https://mainnet.base.org
export OLD=0x686cd88F248DE3F9FC0835566DB798D93881F02D
export MANAGER=0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8
export SPOKE=0x17905Db0e4A3514467539956c084180616AE7B8D
export RUNNER=0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93
export DEPLOYER=0xF3bBaa5f6BEAF49732c28D2bdd2b772AA01031aD
export A1=0xFf13Dc32AcA90b3D61058ea26Df1D895F842eE1F
export A2=0x33fd640a60542430C256E125c8Da037695e1bD30
export JAW_CLONE=0xc79e2c8f7a03b38abd65a7e073fc3410849544bba74f53360c127775bc891848
export SAFE=<the Safe's address on Base>
export GUARD=<from P8>; export PLANNER=<from P8>; export GUARD_BLOCK=<from P8>

# One abi-encoded Permission: "live" if JAW's manager approved it and didn't revoke it, else "dead".
# 0xdfdd4716 = isApproved(Permission), 0x77e66ddd = isRevoked(Permission).
live() {
  [[ $1 == 0x ]] && { echo none; return; }
  local ok=$(cast call $MANAGER "0xdfdd4716${1#0x}" --rpc-url $RPC)
  local gone=$(cast call $MANAGER "0x77e66ddd${1#0x}" --rpc-url $RPC)
  [[ $ok == *1 && $gone == *0 ]] && echo live || echo dead
}
health() { cast call $SPOKE 'getUserAccountData(address)((uint256,uint256,uint256,uint256,uint256,uint256,uint256))' $1 --rpc-url $RPC | cut -d, -f3; }
oldstate() {
  local acc=$(cast call $OLD 'accounts(address)(uint8,uint32,uint8,uint48,uint32,uint8,uint48,bool,uint32,uint32)' $1 --rpc-url $RPC)
  echo "$1 on 0x686c: jobs $(echo $acc | sed -n 1p), keepMix $(echo $acc | sed -n 8p)," \
    "mix $(cast call $OLD 'mixes(address)(uint256)' $1 --rpc-url $RPC)," \
    "topUps on, keep: $(cast call $OLD 'topUps(address)(bool,uint32,uint48,uint56,uint56,uint56,uint256)' $1 --rpc-url $RPC | sed -n '1p;3p' | tr '\n' ' ')," \
    "health$(health $1)"
}
oldgrants() { for J in 0 1 2 3 4; do echo "$1 job $J on 0x686c: $(live $(cast call $OLD 'permissionOf(address,uint8)' $1 $J --rpc-url $RPC))"; done; }
guardstate() { cast call $GUARD 'accountOf(address)((uint24,uint8,uint32,uint32,address),(uint112,uint16,uint16,uint32,bool,bool,uint48))' $1 --rpc-url $RPC; }
guardgrants() { for J in 0 1 2 3 4; do echo "$1 job $J on the Guard: $(live $(cast call $GUARD 'permissionOf(address,uint8)(bytes)' $1 $J --rpc-url $RPC))"; done; }
```

Jobs are bits: 1 = Save, 2 = Protect, 4 = Protect · sell, 8 = Rebalance, 16 = Turn into cash. A `jobs` of 15 is the first four. `oldstate`, `oldgrants` and `health` were run against a Base fork on 2026-10-23. The Guard ones use the same shapes as the rehearsal's `test_6`.

---

## Step 1. Pre-checks (0:00, 2 min)

```sh
cast call $OLD 'memberCount()(uint256)' --rpc-url $RPC       # 2. More: stop. Someone else uses 0x686c and needs their own move.
cast call $OLD 'members(uint256)(address)' 0 --rpc-url $RPC  # A1
cast call $OLD 'members(uint256)(address)' 1 --rpc-url $RPC  # A2
cast call $OLD 'paused()(bool)' --rpc-url $RPC               # false
cast nonce $DEPLOYER --rpc-url $RPC                           # the N from P8. Different: the fast path is off, rebuild the preview after step 2.
cast balance $RUNNER --ether --rpc-url $RPC                   # about 0.005 (P5)
for A in $A1 $A2; do oldstate $A; oldgrants $A; done | tee ~/guard-release-before.txt
```

The last line saves the "before" picture: which agents run on 0x686c, each account's mix and top-ups, and its health. Step 4 copies it. A job whose bit is on but whose grant is `dead` isn't running today. Note it, and decide with the account holder whether it goes on in step 4.

At block 52,946,000 (2026-10-23) these read: both accounts jobs 15 with top-ups on (A1 keeps $5 as cash, A2 $500), health 1.148 (A1) and 1.104 (A2). A2's four grants were live. **A1's Protect and Protect · sell grants were dead** (revoked in JAW's manager while 0x686c still had the bits on), so Protect wasn't running for A1 on 0x686c then.

---

## Step 2. Deploy (0:02, 5 min) — gap 6

The owner broadcasts. `GUARD_OWNER` is the Safe, not the deployer. The script checks every address the Guard fixes on Base before it sends anything, and reads the owner and the runner back after.

```sh
cd <release checkout>/contracts
GUARD_OWNER=$SAFE forge script script/DeployGuard.s.sol --rpc-url $RPC --broadcast --slow --account <deployer keystore>
```

Read the addresses from the broadcast file. They must equal the predicted ones.

```sh
B=broadcast/DeployGuard.s.sol/8453/run-latest.json
G=$(jq -r '[.transactions[] | select(.contractName | startswith("GooseGuard"))][0].contractAddress' $B)
P=$(jq -r '[.transactions[] | select(.contractName | startswith("GoosePlanner"))][0].contractAddress' $B)
GTX=$(jq -r '[.transactions[] | select(.contractName | startswith("GooseGuard"))][0].hash' $B)
cast to-check-sum-address $G; cast to-check-sum-address $P   # the same as $GUARD and $PLANNER
echo deployed at block $(cast receipt $GTX blockNumber --rpc-url $RPC)   # $GUARD_BLOCK is at or before it
```

If they differ: `export GUARD=…` and `export PLANNER=…` with the deployed ones, and rebuild the preview (P8's second block). That adds about 5 minutes.

Read back. Each line's expected answer is in its comment. One wrong answer: stop, and deploy again rather than queue a fix.

```sh
cast call $GUARD 'owner()(address)' --rpc-url $RPC                       # $SAFE
cast call $GUARD 'isRunner(address)(bool)' $RUNNER --rpc-url $RPC        # true
cast call $GUARD 'isRunner(address)(bool)' $DEPLOYER --rpc-url $RPC      # false
cast call $GUARD 'paused()(bool)' --rpc-url $RPC                         # false
cast call $GUARD 'membersLength()(uint256)' --rpc-url $RPC               # 0
cast call $GUARD 'codehashOk(bytes32)(bool)' $JAW_CLONE --rpc-url $RPC   # true: JAW's passkey accounts may register
cast call $GUARD 'SALE_FLOOR_BPS()(uint256)' --rpc-url $RPC              # 300
cast call $GUARD 'SWAP_FLOOR_BPS()(uint256)' --rpc-url $RPC              # 50
cast call $GUARD 'BAND_BPS()(uint256)' --rpc-url $RPC                    # 100
cast call $GUARD 'KEEP_BACK()(uint256)' --rpc-url $RPC                   # 1000000
cast call $GUARD 'DUST()(uint256)' --rpc-url $RPC                        # 1000000
cast call $PLANNER 'GUARD()(address)' --rpc-url $RPC                     # $GUARD
for f in 'PROTECT()(address)' 'TRADER()(address)' 'CASH()(address)'; do
  cast call $(cast call $PLANNER $f --rpc-url $RPC) 'GUARD()(address)' --rpc-url $RPC   # $GUARD, three times
done
cast call $PLANNER 'PACK_GAS()(uint256)' --rpc-url $RPC                  # 5300000
cast call $PLANNER 'SKIP_WEEKENDS()(bool)' --rpc-url $RPC                # false
cast call $PLANNER 'checkUpkeep(bytes)(bool,bytes)' $(cast abi-encode 'f(uint256,uint256)' 0 1) --rpc-url $RPC   # false 0x: no members yet
```

---

## Step 3. The preview points at the Guard (0:07, 1 min)

Open `<preview URL>`. Read the addresses its scripts carry:

```sh
U=<preview URL>
JS=$(for p in /home /agents; do curl -s "$U$p" | grep -o '/_next/static/[^"]*\.js'; done | sort -u)
ALL=$(for f in ${(f)JS}; do curl -s "$U$f"; done)
for v in $GUARD $PLANNER; do grep -q -i -F "$v" <<<"$ALL" && echo "preview has $v" || echo "MISSING $v"; done
```

If the preview sits behind Vercel's login, `curl` sees the login page. Then check in the browser instead: the Agents tab opens (not "Coming soon"), and its switches read off for both accounts.

---

## Step 4. Both accounts grant their agents to the Guard and revoke their 0x686c grants (0:08, 6 min) — gaps 1 and 2, GG-05

This comes before KeeperHub moves. The app's one-tap batch grants the agents to the Guard **and** revokes every live 0x686c grant of the same agents in JAW's manager (GG-05), in one Face ID. So the old and new grants never live side by side.

**From here until step 5 is on, nobody protects A1 and A2:** KeeperHub still runs 0x686c, which has no grants left, and the Guard isn't run yet. Keep this under 10 minutes. Don't start if either account's health is under 1.08 (from there a fall of about 5% reaches Protect's line, 1.03):

```sh
health $A1; health $A2   # both over 1.08e18
```

On `<preview URL>`, signed in as A1, then as A2:

1. Agents → switch on the same agents as in `~/guard-release-before.txt`. Protect must be on for both.
2. Rebalance → set the same mix, Keep my mix and top-ups (with the same "keep as cash") as before.
3. Each change is one Face ID.

Read back:

```sh
for A in $A1 $A2; do guardstate $A; guardgrants $A; done
cast call $GUARD 'membersLength()(uint256)' --rpc-url $RPC   # 2
```

Expected, for each account:
- `guardstate`: the first number is 1 or 2 (a member). The second is the same jobs as before. Then the mix, `keepMix` and `topUpsOn, keep` match the before file. `line` and `target` read 0 0 (the defaults, 1.03 and 1.12).
- `guardgrants`: `live` for every job that is on, `none` for each one that is off.

```sh
for A in $A1 $A2; do oldgrants $A; done   # every line "dead": the batch revoked them
```

A revoke can't be undone. A rollback to 0x686c means new grants (Rollback, R3).

---

## Step 5. KeeperHub: off, four steps, read back, on (0:14, 6 min) — gap 3

A half-edited round can look green while it protects nobody. The rehearsal showed it: the Planner's moves sent to 0x686c's `performUpkeep` succeed and move nothing (`GuardSwapRehearsalFork.t.sol`, test 5, case c). So the round is off for the whole edit.

1. **Switch the workflow `q5vdv47dieyabhg4toiue` off.** Check it reads off.
2. **Read 1** (`qzina2TKKSlFGMMfC6qbW`): contract address → `$PLANNER`. Function and arguments unchanged (`checkUpkeep`, `abi.encode(0,1)`).
3. **Write 1** (`2_4afTvEv5AZkdoX1m4w9`): contract address → `$GUARD`. Function, `performData` reference and gas limit 5,500,000 unchanged.
4. **Read 2** (`RD4QxUVvop4xkwtAVdwu6`): contract address → `$PLANNER`. Arguments → `abi.encode(1,1)`, which is
   `0x00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001`
   (`cast abi-encode 'f(uint256,uint256)' 1 1`). The second read then starts halfway down the member list.
5. **Write 2** (`tth32myHzckGycsW8SHAe`): contract address → `$GUARD`. Nothing else.

**Keep each step's stored ABI.** KeeperHub's condition and writes read `upkeepNeeded` and `performData` by name. GoosePlanner's `checkUpkeep` returns the same types with no names, so its own ABI would break the round. If KeeperHub fetches a new ABI when the address changes, put the stored one back:

```json
[{"type":"function","name":"checkUpkeep","stateMutability":"view","inputs":[{"name":"checkData","type":"bytes"}],"outputs":[{"name":"upkeepNeeded","type":"bool"},{"name":"performData","type":"bytes"}]}]
```

```json
[{"type":"function","name":"performUpkeep","stateMutability":"nonpayable","inputs":[{"name":"performData","type":"bytes"}],"outputs":[]}]
```

The selectors are the same on both contracts (`checkUpkeep(bytes)` is `0x6e04ff0d`), so the stored ABI calls the new contracts correctly.

The address field is a contenteditable box: select-all doesn't clear it, new text gets appended. Press End, then Backspace until it is empty, then paste. Check it with `document.getElementById('contractAddress').innerText` in the browser console.

**Read back, still off.** Save. Then in the browser console on app.keeperhub.com (signed in), paste this with the two addresses filled in:

```js
const PLANNER = '<PLANNER>', GUARD = '<GUARD>', OLD = '0x686cd88f248de3f9fc0835566db798d93881f02d';
const want = { qzina2TKKSlFGMMfC6qbW: ['read 1', PLANNER], RD4QxUVvop4xkwtAVdwu6: ['read 2', PLANNER],
  '2_4afTvEv5AZkdoX1m4w9': ['write 1', GUARD], tth32myHzckGycsW8SHAe: ['write 2', GUARD] };
const w = await (await fetch('/api/workflows/q5vdv47dieyabhg4toiue')).json();
const rows = [];
(function walk(o) {
  if (!o || typeof o !== 'object') return;
  if (want[o.id]) {
    const s = JSON.stringify(o);
    const addrs = [...new Set((s.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) || []).map((a) => a.toLowerCase()))];
    rows.push({ step: want[o.id][0], right: addrs.includes(want[o.id][1].toLowerCase()), old: addrs.includes(OLD),
      args11: /0{63}10{63}1/.test(s), names: s.includes('upkeepNeeded') || s.includes('performData') });
  }
  Object.values(o).forEach(walk);
})(w);
console.table(rows);
```

Expected: every row `right` true and `old` false. `args11` true for read 2 only. `names` true for all four. If a step shows twice, both copies must agree.

Then a dry read of what the round will see:

```sh
cast call $PLANNER 'checkUpkeep(bytes)(bool,bytes)' $(cast abi-encode 'f(uint256,uint256)' 0 1) --rpc-url $RPC
cast call $PLANNER 'checkUpkeep(bytes)(bool,bytes)' $(cast abi-encode 'f(uint256,uint256)' 1 1) --rpc-url $RPC
# Neither reverts. true + moves, or false 0x when nothing is due.
```

6. **Switch the workflow on.** Check it reads on.

---

## Step 6. First green run, then pause 0x686c (0:20, 2 min) — gap 4

1. KeeperHub → the round → **Run now**. In the run log: read 1 ran on the Planner, the condition ran, and if `upkeepNeeded` was true the write's transaction went to `$GUARD` and succeeded. The same for read 2 and write 2.
2. Pause 0x686c, in this same sitting. Its owner is the deployer key:

```sh
cast send $OLD 'pause()' --rpc-url $RPC --account <deployer keystore>
cast call $OLD 'paused()(bool)' --rpc-url $RPC                                                     # true
cast call $OLD 'checkUpkeep(bytes)(bool,bytes)' $(cast abi-encode 'f(uint256,uint256)' 0 1) --rpc-url $RPC   # false 0x
```

The pause revokes nothing (rehearsal test 5, case d). The grants were revoked in step 4. Together they keep 0x686c out.

Optional: start step 8 now in a second terminal (see "The 30 minutes").

---

## Step 7. Live test (0:22, 4 min) — gap 7

Real accounts, real grants, no amount limit, small positions. Two tests.

**A1: Protect steps in.** A1 raises its own Protect line above its health, so Protect acts now, with no price move.

```sh
health $A1   # for example 1.148e18. It must be between 1.10e18 and 1.30e18.
```

1. On `<preview URL>`, as A1: Protect → line = the first choice above A1's health, target = 0.05 or more above the line (at most 1.40). Example: health 1.148 → line 1.20, target 1.25. One Face ID.
2. Read back the line and the plan:

```sh
cast call $GUARD 'linesOf(address)(uint256,uint256)' $A1 --rpc-url $RPC   # 1200000000000000000 1250000000000000000 in the example
cast call $PLANNER 'planOf(address)((uint8,uint8,uint256,uint256,uint8,uint8))' $A1 --rpc-url $RPC
# First number 2 = repay, 4 = sale. 0 = nothing planned: A1 has nothing to repay with. Add a few dollars of cash, or switch Protect · sell on.
```

3. KeeperHub → **Run now**.
4. Watch, in this order:
   - KeeperHub's run log: no failed step. Write 1 has a transaction hash.
   - Basescan, that transaction: from `0x9c74…3E93`, to `$GUARD`, status success.
   - The Guard's events since the deploy:

```sh
cast logs --from-block $GUARD_BLOCK --address $GUARD 'ProtectRepaid(address indexed,uint256,uint256,uint256,uint256)' --rpc-url $RPC   # one, for A1
cast logs --from-block $GUARD_BLOCK --address $GUARD 'ProtectSold(address indexed,uint256[7],uint256,uint256,uint256)' --rpc-url $RPC   # a sale, if the plan was 4
cast logs --from-block $GUARD_BLOCK --address $GUARD 'Refused(address indexed,uint8 indexed,bytes4)' --rpc-url $RPC                     # none
health $A1   # at the target, at most 0.01 over it: 1.25e18 to 1.26e18 in the example
```

   - The app: A1's Activity shows Protect's move.
5. A1 sets Protect back to the defaults in the app (line 1.03, target 1.12). Read back:

```sh
cast call $GUARD 'linesOf(address)(uint256,uint256)' $A1 --rpc-url $RPC   # 1030000000000000000 1120000000000000000
```

**A2: a plain round.** A2 changes nothing.

```sh
cast call $PLANNER 'planOf(address)((uint8,uint8,uint256,uint256,uint8,uint8))' $A2 --rpc-url $RPC   # what the next round does for A2; 0 = nothing
```

The same "Run now" covered A2. If A2's plan wasn't 0, its move shows in the logs above (`Saved`, `Rebalanced`, `TopUpInvested` or a Protect event), and `Refused` stays empty.

**Then watch the next two scheduled rounds** (every 10 minutes, after the window): both green, no `Refused`, both accounts' health where it was. Check `cast balance $RUNNER --ether --rpc-url $RPC` once the $1 credit runs out: it goes down by cents, never fast.

**Stop and roll back on any of these:**
- A KeeperHub step fails, or a write's transaction reverts.
- A `Refused` event, for any reason.
- A move for an account other than A1 or A2 that its owner didn't expect.
- A1's health ends under its line, or more than 0.01 over its target.
- The run log is green but the read went to 0x686c, or the write went anywhere but `$GUARD`.

---

## Step 8. Release the app (5 min)

First note today's production deployment. It is the app's rollback:

```sh
cd <release checkout>
vercel ls --prod | head -5    # (newer CLIs: --environment production) note the newest production URL: <previous production URL>
```

Fill in the three values at the top of `scripts/release.sh` (`GUARD=`, `GUARD_BLOCK=`, `PLANNER=`) with `$GUARD`, `$GUARD_BLOCK` and `$PLANNER`. Then:

```sh
scripts/release.sh <release commit>
# Ends with "Released <sha> to https://app.greedygoo.com." and "live:" for the Guard, its block and the Planner.
```

Then, signed in as A1 on app.greedygoo.com: the Agents tab shows A1's agents on.

After the release, 0x686c can't take new grants from the app. Until then, check once more that no new account joined it:

```sh
cast call $OLD 'memberCount()(uint256)' --rpc-url $RPC   # still 2
```

---

## Step 9. After the window

1. **Alerts on the Guard (LV-16).** Add a small KeeperHub workflow, every 3 hours (`0 */3 * * *`): 248 runs a month, so with the round's 4,464 the total stays under the free 5,000. Its steps:
   - Web3 read: Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`, `getEthBalance(address)` with `0x9c74d428Ff2707e0E9cB576AFFFD87c1b1eF3E93` → if under 2000000000000000 (0.002 ETH) → notify.
   - Web3 read: `$GUARD`, `paused()` → if true → notify.
   Send a test notification. The round's failed-run notifications are already on (P6).
2. **Record the deploy** in `docs/DEPLOYMENTS.md`: the Guard and the Planner (address, block, transaction), the three helpers, the commit, the cost, the owner (the Safe), the runner, and the round workflow's four steps. Mark 0x686c paused, with its grants revoked. Put the Guard's real deploy block in `scripts/release.sh` the next time it changes.
3. **Commit `scripts/release.sh`** with the three values, so the next release keeps them.

---

## Rollback

Pick the smallest one that stops the problem. Each one has its read-back.

**R1. Save, Rebalance or Turn into cash misbehave.** The Safe pauses the Guard. Protect keeps running: the Guard's pause never stops Protect.

In Safe{Wallet}: the Safe → New transaction → Transaction Builder → address `$GUARD`, value 0, data `0x8456cb59` (`pause()`) → sign to the threshold → execute.

```sh
cast call $GUARD 'paused()(bool)' --rpc-url $RPC   # true
```

To undo: the same, with data `0x3f4ba83a` (`unpause()`).

**R2. Protect itself misbehaves.** Switch the round workflow off. Nothing runs the Guard after that. Then each account turns its agents off on app.greedygoo.com (or on the preview, before step 8), which revokes its Guard grants.

```sh
for A in $A1 $A2; do guardgrants $A; done   # every line "dead" or "none"
```

From here nobody protects the accounts. Watch their health by hand until R3 or a fix.

**R3. Back to 0x686c.** The step 4 grants are revoked for good, so each account grants again.

1. The round workflow off (R2).
2. If step 8 ran: `vercel promote <previous production URL>`, or promote it in Vercel's dashboard. Check app.greedygoo.com serves the old app again.
3. Unpause 0x686c:

```sh
cast send $OLD 'unpause()' --rpc-url $RPC --account <deployer keystore>
cast call $OLD 'paused()(bool)' --rpc-url $RPC   # false
```

4. On app.greedygoo.com (`main`), A1 and A2 switch their agents on again (new grants to 0x686c). Read back:

```sh
for A in $A1 $A2; do oldstate $A; oldgrants $A; done   # the same jobs as ~/guard-release-before.txt, each "live"
```

5. Each account turns its Guard agents off on the preview (R2's revoke), so only one contract holds live grants.
6. KeeperHub: the four steps back to 0x686c as written in P7, read 2's arguments back to `abi.encode(0,1)`, the stored ABI untouched. Run P7's check (the console snippet with `PLANNER` and `GUARD` both set to 0x686c's address: every `right` true).
7. The round workflow on, then Run now: green, and its writes go to 0x686c.
8. The Safe pauses the Guard (R1), so nothing new runs on it.
