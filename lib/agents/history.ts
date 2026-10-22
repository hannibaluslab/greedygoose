import { erc20Abi, formatLog, pad, toHex, type Address, type Client, type Log, type RpcLog } from "viem";
import { getBlock, multicall } from "viem/actions";
import { AAVE } from "@/lib/aave/addresses";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import type { AgentLog } from "@/lib/agents/events";
import { movesMoney, type MoveContext } from "@/lib/agents/feed";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";

/** Blocks per getLogs request. */
export const LOG_CHUNK = 5_000n;

/** A week of Base blocks (2 seconds each). The feeds read a week at a time. */
export const WEEK_BLOCKS = 302_400n;

/**
 * The ranges to read from `from` to `to`, newest first, cut on LOG_CHUNK boundaries: a chunk the chain has moved past
 * is the same request every time, so it can be read once and kept.
 */
export function logChunks(from: bigint, to: bigint, size = LOG_CHUNK): { from: bigint; to: bigint }[] {
  const out: { from: bigint; to: bigint }[] = [];
  for (let hi = to, start = (to / size) * size; hi >= from; start -= size) {
    const lo = start > from ? start : from;
    out.push({ from: lo, to: hi });
    hi = lo - 1n;
  }
  return out;
}

/** GooseGuard's logs about `account` in one range: every event about an account has it as its first indexed topic. */
export async function readAgentLogs(
  client: Client,
  q: { guard: Address; account: Address; from: bigint; to: bigint },
): Promise<Log[]> {
  const logs = (await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: q.guard,
        topics: [null, pad(q.account.toLowerCase() as Address)],
        fromBlock: toHex(q.from),
        toBlock: toHex(q.to),
      },
    ],
  })) as RpcLog[];
  return logs.map((l) => formatLog(l));
}

const held = (shares: readonly bigint[]) => shares.flatMap((s, r) => (s > 0n ? [r] : []));

/**
 * When a move happened, and what the chain said around it: the account's debt and cash at the block before and at
 * its own block, and Aave's price for what it traded. These read past state, so Base's node must serve it (an archive
 * read). A read that fails leaves its part out.
 */
export async function readMoveContext(
  client: Client,
  q: { account: Address },
  e: AgentLog,
): Promise<{ time: number; ctx: MoveContext }> {
  const block = await getBlock(client, { blockNumber: e.blockNumber });
  const money = movesMoney(e);
  const traded =
    e.kind === "sold"
      ? held(e.sharesRaw)
      : e.kind === "rebalanced"
        ? [...new Set([...held(e.soldRaw), ...held(e.boughtRaw)])]
        : [];

  const balances = (blockNumber: bigint) =>
    multicall(client, {
      blockNumber,
      allowFailure: false,
      contracts: [
        {
          address: AAVE.SPOKE,
          abi: spokeAbi,
          functionName: "getUserTotalDebt",
          args: [BigInt(USDC.reserveId), q.account],
        },
        { address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [q.account] },
        { address: PROTOCOLS.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [q.account] },
      ],
    }).catch(() => undefined);
  const [before, after, prices] = await Promise.all([
    money ? balances(e.blockNumber - 1n) : undefined,
    money ? balances(e.blockNumber) : undefined,
    traded.length
      ? multicall(client, {
          blockNumber: e.blockNumber,
          allowFailure: false,
          contracts: traded.map(
            (r) =>
              ({
                address: AAVE.SPOKE_ORACLE,
                abi: aaveOracleAbi,
                functionName: "getReservePrice",
                args: [BigInt(r)],
              }) as const,
          ),
        }).catch(() => undefined)
      : undefined,
  ]);

  const ctx: MoveContext = {};
  if (before && after) {
    ctx.owedRaw = [before[0], after[0]];
    ctx.cashRaw = [before[1] + before[2], after[1] + after[2]];
  }
  if (prices) ctx.pricesRaw = Array.from({ length: 7 }, (_, r) => prices[traded.indexOf(r)] ?? 0n);
  return { time: Number(block.timestamp), ctx };
}
