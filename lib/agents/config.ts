import { isAddress } from "viem";

const executor = process.env.NEXT_PUBLIC_GOOSE_EXECUTOR;
const deployBlock = process.env.NEXT_PUBLIC_GOOSE_EXECUTOR_BLOCK;

/**
 * GooseExecutor (contracts/src/GooseExecutor.sol), the spender of every agent permission (D14). Unset until it is
 * deployed after the audit; the agents stay off in the app until then. A D13 test deploy is never set here in
 * production config.
 */
export const GOOSE_EXECUTOR = executor && isAddress(executor) ? executor : undefined;

/**
 * Whether the agents can be switched on: GooseExecutor is set and Chainlink has approved its automation
 * (NEXT_PUBLIC_AGENTS_LIVE=1). Until then the Agents tab reads the real figures and shows "Coming soon" where its
 * switches and Save would be (rulings 19, 22).
 */
export const AGENTS_LIVE = !!GOOSE_EXECUTOR && process.env.NEXT_PUBLIC_AGENTS_LIVE === "1";

/**
 * The block GooseExecutor was deployed in, set with it: an account's agent history is read from there, in chunks (no
 * indexer, D12). Without it the history is read back as far as the user asks.
 */
export const GOOSE_EXECUTOR_BLOCK = deployBlock && /^\d+$/.test(deployBlock) ? BigInt(deployBlock) : 0n;
