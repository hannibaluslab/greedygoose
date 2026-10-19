import { erc20Abi, type Address, type PublicClient, type Transport } from "viem";
import { gooseExecutorAbi } from "@/lib/agents/abis/GooseExecutor";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import type { CHAIN } from "@/lib/chain";
import { saveRuns, type Cash } from "@/lib/cash";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";

/**
 * The account's cash as Base has it now: wallet USDC, savings and whether Save runs, the balances usePosition reads
 * every 15 s. For the batch prepared before JAW's sheet (useSigningCash).
 */
export async function readCash(client: PublicClient<Transport, typeof CHAIN>, user: Address): Promise<Cash> {
  const [[walletRaw, savingsRaw], account] = await Promise.all([
    client.multicall({
      allowFailure: false,
      contracts: [
        { address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [user] },
        { address: PROTOCOLS.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [user] },
      ],
    }),
    GOOSE_EXECUTOR
      ? client.readContract({ address: GOOSE_EXECUTOR, abi: gooseExecutorAbi, functionName: "accounts", args: [user] })
      : undefined,
  ]);
  return { walletRaw, savingsRaw, saveOn: saveRuns(account?.[0] ?? 0) };
}
