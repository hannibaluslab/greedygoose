import { isAddress } from "viem";

const guard = process.env.NEXT_PUBLIC_GOOSE_GUARD;
const deployBlock = process.env.NEXT_PUBLIC_GOOSE_GUARD_BLOCK;
const planner = process.env.NEXT_PUBLIC_GOOSE_PLANNER;

/**
 * GooseGuard (contracts/src/GooseGuard.sol), the one contract that moves money and the spender of every agent
 * permission: every check that a grant is ours compares its spender with this. Unset until it is deployed; the agents
 * stay off in the app until then.
 */
export const GOOSE_GUARD = guard && isAddress(guard) ? guard : undefined;

/**
 * GoosePlanner, the read-only views over the Guard (what a round would do, the numbers its rules run with, the top-ups
 * ready, the weekend calendar). It can be swapped without anyone granting again, so it is a setting of its own.
 */
export const GOOSE_PLANNER = planner && isAddress(planner) ? planner : undefined;

/**
 * Whether the agents can be switched on: the Guard and the Planner are set and the runner is on
 * (NEXT_PUBLIC_AGENTS_LIVE=1, the go-live checklist in contracts/docs/DEPLOYMENTS.md). Until then the Agents tab reads
 * the real figures and shows "Coming soon" where its switches and Save would be (rulings 19, 22).
 */
export const AGENTS_LIVE = !!GOOSE_GUARD && !!GOOSE_PLANNER && process.env.NEXT_PUBLIC_AGENTS_LIVE === "1";

/**
 * The block GooseGuard was deployed in, set with it: an account's agent history is read from there, in chunks (no
 * indexer, D12). Without it the history is read back as far as the user asks.
 */
export const GOOSE_GUARD_BLOCK = deployBlock && /^\d+$/.test(deployBlock) ? BigInt(deployBlock) : 0n;
