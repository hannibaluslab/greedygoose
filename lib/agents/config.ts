import { isAddress } from "viem";

const executor = process.env.NEXT_PUBLIC_GOOSE_EXECUTOR;

/**
 * GooseExecutor (contracts/src/GooseExecutor.sol), the spender of every agent permission (D14). Unset until it is
 * deployed after the audit; the agents stay off in the app until then. A D13 test deploy is never set here in
 * production config.
 */
export const GOOSE_EXECUTOR = executor && isAddress(executor) ? executor : undefined;
