# Developer handover (2026-10-22)

For the developers taking over GreedyGoose (GreedyGoo on screen). Read this page, then [SPEC.md](SPEC.md), then
[CLAUDE.md](../CLAUDE.md). Everything here was checked against `main` @ `6f15de2`, Vercel and Base on 2026-10-22.

## 1. What is live

- **The app:** https://app.greedygoo.com, built from `main` @ `6f15de2`. Real money on Base mainnet.
- **The agents are on for everyone**, on GooseExecutor `0x686c…F02D`: no amount cap and **not audited**. The owner
  accepted that risk for now. Treat every change near the agents as a change to a live money system.
- **The runner** is KeeperHub's free tier, a round every 10 minutes (5,000 runs a month; the round uses about 4,460).
- **The Leaderboard and the Wall of shame** are live on GooseBoard `0x0E10…FcA1`.
- Addresses, blocks, build values and every deploy since day one: [DEPLOYMENTS.md](../contracts/docs/DEPLOYMENTS.md),
  "Live now" at the top.

## 2. Day one

1. **Access.** Ask the owner (Adrian) for what your work needs:
   - GitHub: write access to this repo.
   - `NEXT_PUBLIC_JAW_API_KEY` for `.env.local` (JAW dashboard).
   - Optional: an Alchemy key (Activity's "Received" rows and Home's all-time line) and an RPC that serves old logs
     (the Leaderboard). Use your own keys, never production's.
   - Releases only: the Vercel team that owns the project.
   - Owner only, never shared: the deployer key that owns GooseExecutor, the KeeperHub organisation.
2. **Run it:** README › Run locally (Node 22, `cp .env.example .env.local`, `npm ci`, `npm run dev`). Leave the
   executor settings empty: the Agents tab then says "Coming soon" and nothing you click can grant a permission.
3. **Check it:** `npm run check` and `npm run build`, then forge offline (README › Checks). On 2026-10-22: 1,284 unit
   tests, 114 forge tests offline, the build, all green; 5 known lint warnings ([ARCHITECTURE.md](ARCHITECTURE.md)).
4. **See it without money:** `?as=<address>` under `npm run dev` shows any account read-only (compiled out of
   production). The dev gallery (`/dev/ui`, a 404 in production) shows every screen state from fixtures. The fork
   rehearsal ([scripts/rehearsal](../scripts/rehearsal/README.md)) runs the whole app on a local fork of Base with fake
   money.

## 3. How work flows

1. Branch from `origin/main`, one change per branch.
2. `npm run check` before every commit. Commit messages: `type(scope): what changed, in plain words`.
3. Open a pull request. CI runs lint, types, format, knip, unit tests, the build and forge.
4. The owner merges. A screen the owner approved never changes as a side effect, and product calls go to the owner
   first.
5. Release: `scripts/release.sh <commit on main>`, with the owner's OK. It refuses a commit that isn't on GitHub, ships
   with production's build values and checks the live pages. Never `vercel deploy` by hand.

The rules that bite:

- **Treat the repo as public** (it was public until the handover, so its whole history is out there). No key,
  `.env.local`, `contracts/broadcast/` or account data in a commit. Every `NEXT_PUBLIC_*` value ships in the page, so
  none can be a secret.
- **One write path.** Every transaction goes through `useTx`: allowlist, simulation on Base, then JAW's sheet. A new
  call shape gets its own narrow allowlist rule and tests.
- **Words.** Never on screen: borrow, loan, lock, locked, unlock, collateral, room. Use credit, backs credit, free up,
  in use, cash (SPEC.md › Words).
- **Tests on a fork** go through a keyless public RPC (`BASE_RPC_URL=https://mainnet.base.org`), never the app's
  Alchemy key: production shares its free-tier limit.
- **Contracts:** GooseExecutor must stay under 24,576 bytes. A new executor is a new spender, so every user grants
  their agents again. Deploys are signed by the owner and recorded in DEPLOYMENTS.md.

## 4. Open work

In order of risk. Each line names where the detail lives.

| # | What | Where |
|---|---|---|
| 1 | **The next executor.** The adversarial review found no way to take funds and 14 issues; the 12 fixes are a parked draft that builds, with unit tests not updated. Also in it: a daily per-user limit and a global limit (shape still open), no minimum trade, "fresh mix" trades at the next round, EntryJob's coins (USDbC out, DAI and EURC in) | `jl/executor-fixes`, [FIX-PLAN-2026-10-20.md](../contracts/docs/FIX-PLAN-2026-10-20.md), [REVIEW-2026-10-20-adversarial.md](../contracts/docs/REVIEW-2026-10-20-adversarial.md), [ARCHITECTURE.md](ARCHITECTURE.md) › Before the executor's pre-launch redeploy |
| 2 | **External audit** of GooseExecutor and its jobs: not started. Before the next executor ships, its source is verified on Basescan and reviewed by JustaLab's lead engineer | [GooseExecutor-as-built.md](../contracts/docs/GooseExecutor-as-built.md) |
| 3 | **Eligibility.** The "no US persons" attestation is enforced in the browser only; the geo check is still a TODO hook | `lib/eligibility/index.ts`, D1 in [JUSTALAB-DECISIONS.md](JUSTALAB-DECISIONS.md) |
| 4 | **NYSE holidays:** 12 changes queued on the live executor, to apply after 2026-10-27 10:32 UTC (owner signs) | DEPLOYMENTS.md › NYSE holidays queued |
| 5 | **Old D13 deploy:** cancel its two Chainlink Automation requests to get 0.0008 WETH back (owner signs) | DEPLOYMENTS.md › D13 test deploy |
| 6 | **Chainlink CRE runner** (`GooseReceiver`): waits on Chainlink's deploy access. Until then KeeperHub alone runs the round | DEPLOYMENTS.md › KeeperHub runner |
| 7 | **Dependency advisories** (`npm audit`: 10 high, 1 moderate). Runtime: axios inside `@jaw.id/core` 1.6.3 (1.7.1 is out) and `@justaname.id/sdk` 0.3.0, JustaLab's own packages. The rest is dev tooling (knip 5, eslint-config-next's glob). Upgrade JAW on its own branch and test signing on an iPhone | `package.json` |
| 8 | **Known edge:** a transaction Base never confirms leaves its sheet on "Confirming on Base…"; Close still works | `components/gg/kit/SheetShell.tsx` |
| 9 | **Code clean-up:** oversized files, complex functions, comments that cite people and dates | [ARCHITECTURE.md](ARCHITECTURE.md) › Clean-up ahead |

## 5. Branches

- `main` is the only working branch. Merged branches are deleted on merge.
- `jl/executor-fixes` is the parked draft of open work item 1. Never merge it as it stands: rebase it onto `main`,
  finish it and review it as a new pull request.
- Older experiments and superseded work stay on the owner's machine as a record, not on GitHub.

## 6. Where to read more

- [SPEC.md](SPEC.md): the product rules. It wins over every other doc.
- [ARCHITECTURE.md](ARCHITECTURE.md): layers, conventions, the clean-up ahead.
- [JUSTALAB-DECISIONS.md](JUSTALAB-DECISIONS.md): why each rule exists, by date.
- [contracts/docs](../contracts/docs): the contracts as built, their deploys, the review and JAW's permission manager.
- [archive](archive): history only. Never build from it.
