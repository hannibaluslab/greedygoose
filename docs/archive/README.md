# Archive

Docs kept for the record. None of them is current. Don't build from them.

What is current:

- [SPEC.md](../SPEC.md) is the product truth. It wins over every other doc.
- [JUSTALAB-DECISIONS.md](../JUSTALAB-DECISIONS.md) records why each rule exists.
- [GooseExecutor-as-built.md](../../contracts/docs/GooseExecutor-as-built.md) is the contract truth.
- [DEPLOYMENTS.md](../../contracts/docs/DEPLOYMENTS.md) is the deploy truth.

| Doc | What it was | What supersedes it |
| --- | --- | --- |
| [original-ideas.md](original-ideas.md) | The first briefs: a stock-backed USDC consumer app, then the "Invest and Earn Wallet" project brief | SPEC.md |
| [mvp-parked.md](mvp-parked.md) | Leo's MVP list of what not to build (was `docs/PARKED.md`). It still calls the Rebalancer, Protect's selling and cash yield parked, and they are built | SPEC.md; JUSTALAB-DECISIONS.md, D11 ("Agents are in scope") |
| [guardian-poc.md](guardian-poc.md) | Leo's POC Guardian: a keeper server repaying from savings, with GuardianChecker (was `docs/guardian.md`) | Protect in GooseExecutor (GooseExecutor-as-built.md); JUSTALAB-DECISIONS.md, D12 (no server) and "2026-10-19 · Protect's line and the runner switch" |
| [ux-notes-2026-10-16.md](ux-notes-2026-10-16.md) | UX fixes mapped on 2026-10-16 from a test on an iPhone (was `docs/UX-NOTES-2026-10-16.md`) | SPEC.md and the decisions log for what was decided since |
| [goose-executor-plan.md](goose-executor-plan.md) | The GooseExecutor design plan, built on D14: grants through JAW's screens with no checker, registration by a log trigger (was `contracts/docs/GooseExecutor.md`) | GooseExecutor-as-built.md (written as its changes against this plan's sections, so the plan is still read with it); JUSTALAB-DECISIONS.md, "2026-10-20 · One signature per change: D14 dropped" |

D14 was dropped on 2026-10-20. Each change is now one batch and one Face ID: the app approves the grant in JAW's manager, registers it with GooseExecutor and makes any cash move together (`lib/tx/plans/agents.ts`). [MANAGER-NOTES.md](../../contracts/docs/MANAGER-NOTES.md) stays in `contracts/docs` for the manager's facts. Its section 7, "What this means for D14", describes the path the app no longer takes.
