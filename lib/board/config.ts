import { isAddress } from "viem";

const board = process.env.NEXT_PUBLIC_GOOSE_BOARD;
const wallFrom = process.env.NEXT_PUBLIC_WALL_FROM_BLOCK;

/**
 * GooseBoard (contracts/src/GooseBoard.sol), the leaderboard's member list. Unset until Adrian deploys it: the
 * Leaderboard tab then says "The leaderboard opens soon." and no move carries join() (lib/board/join.ts).
 */
export const GOOSE_BOARD = board && isAddress(board) ? board : undefined;

/**
 * The block Greedy Fatalities opens from (lib/board/wall.ts): only stock sold after it puts anyone on the Wall, so
 * nobody is named under a rule that wasn't shown yet. Unset (or no board): the Leaderboard has no Wall, and credit stays
 * capped at 1.12. Set at the deploy that ships it, to a block after GooseBoard's deploy.
 */
export const WALL_FROM_BLOCK = GOOSE_BOARD && wallFrom && /^\d+$/.test(wallFrom) ? BigInt(wallFrom) : undefined;

/** Greedy Fatalities is open: credit may go down toward Aave's line (config/risk.ts creditLineFor). */
export const WALL_OPEN = WALL_FROM_BLOCK !== undefined;

/**
 * Where the board reads logs. `mainnet.base.org`, the app's default for everything else, refuses eth_getLogs, so
 * without NEXT_PUBLIC_BASE_RPC_URL the logs come from PublicNode's keyless endpoint, which answers 10,000 blocks a
 * request and only for about the last 10,000 blocks (measured 2026-10-15; older ranges need its personal token). A
 * range it refuses fails the whole board ("Couldn't load the board"), never a partial one.
 */
export const BOARD_LOGS_RPC = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://base-rpc.publicnode.com";

/** Blocks per eth_getLogs request: PublicNode's limit. */
export const BOARD_LOG_CHUNK = 10_000n;
