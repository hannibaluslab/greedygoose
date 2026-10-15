import { encodeFunctionData, type Address, type Client } from "viem";
import { readContract } from "viem/actions";
import type { Call } from "@/lib/aave/tx";
import { assertAllowed } from "@/lib/allowlist";
import { gooseBoardAbi } from "./abi";
import { GOOSE_BOARD } from "./config";

/** GooseBoard.join(): no arguments, no value. */
export function joinCall(board: Address): Call {
  return { to: board, data: encodeFunctionData({ abi: gooseBoardAbi, functionName: "join" }), value: 0n };
}

/**
 * The batch with join() added at the end when `user` has never joined (Adrian, 2026-10-15: everyone is on the board
 * from their first move, any move, with no prompt of its own). An account that left (`listed` false, `joinedAt` set)
 * has joined before and isn't put back. Nothing is added when no board is configured, or when the read fails: the
 * move goes ahead as it is and the next one tries again. join() is a no-op for a member, so a stale read costs only
 * its gas. Appended, so a revert still points at the move's own call (useTx's explainRevert).
 */
export async function withBoardJoin(client: Client, user: Address, batch: Call[]): Promise<Call[]> {
  const board = GOOSE_BOARD;
  if (!board) return batch;
  let joinedAt: bigint;
  try {
    joinedAt = await readContract(client, { address: board, abi: gooseBoardAbi, functionName: "joinedAt", args: [user] });
  } catch {
    return batch;
  }
  if (joinedAt !== 0n) return batch;
  return [...batch, ...assertAllowed(user, [joinCall(board)])];
}
