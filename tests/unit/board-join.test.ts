import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, toFunctionSelector, type Address, type Client } from "viem";

// The app's board, before anything reads lib/board/config.ts: the allowlist only lets join() through once it's set.
const BOARD = vi.hoisted(() => {
  const board = "0x00000000000000000000000000000000000b0a2d" as const;
  process.env.NEXT_PUBLIC_GOOSE_BOARD = board;
  return board;
});

import { gooseBoardAbi } from "@/lib/board/abi";
import { joinCall, withBoardJoin } from "@/lib/board/join";
import { assertAllowed } from "@/lib/allowlist";
import { buildRepayCalls } from "@/lib/aave/tx";

const user = "0x000000000000000000000000000000000000a11c" as Address;

/** A client whose eth_call answers GooseBoard.joinedAt(user) with `joinedAt`, or fails. */
const clientWith = (joinedAt: bigint | "fail") =>
  ({
    request: async ({ method }: { method: string }) => {
      if (method !== "eth_call") throw new Error(method);
      if (joinedAt === "fail") throw new Error("RPC down");
      return `0x${joinedAt.toString(16).padStart(64, "0")}`;
    },
  }) as unknown as Client;

describe("join on the first move", () => {
  const move = buildRepayCalls({ user, amountRaw: 1_000_000n, all: false });

  it("adds join() at the end of an account's first batch", async () => {
    const batch = await withBoardJoin(clientWith(0n), user, move);
    expect(batch).toEqual([...move, joinCall(BOARD)]);
    expect(batch.at(-1)!.data).toBe(toFunctionSelector("join()"));
  });

  it("leaves later batches alone, an account that left included", async () => {
    expect(await withBoardJoin(clientWith(52_000_000n), user, move)).toBe(move);
  });

  it("goes ahead without it when the board can't be read", async () => {
    expect(await withBoardJoin(clientWith("fail"), user, move)).toBe(move);
  });
});

describe("the allowlist's GooseBoard rule", () => {
  const call = (data: `0x${string}`, value = 0n) => ({ to: BOARD as Address, data, value });

  it("lets through join() with no arguments and no value, and nothing else", () => {
    expect(() => assertAllowed(user, [joinCall(BOARD)])).not.toThrow();
    expect(() => assertAllowed(user, [call(`${toFunctionSelector("join()")}00`)])).toThrow(/unexpected arguments to join/);
    expect(() => assertAllowed(user, [call(toFunctionSelector("join()"), 1n)])).toThrow(/unexpected value/);
    expect(() => assertAllowed(user, [call(encodeFunctionData({ abi: gooseBoardAbi, functionName: "leave" }))])).toThrow(/unexpected call/);
  });
});
