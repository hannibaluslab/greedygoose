import { erc20Abi, type Address, type PublicClient, type Transport } from "viem";
import { guardAbi } from "@/lib/agents/abis/GooseGuard";
import { GOOSE_GUARD } from "@/lib/agents/config";
import type { CHAIN } from "@/lib/chain";
import { walletSwept, type Cash } from "@/lib/cash";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";

/**
 * The account's cash as Base has it now: wallet USDC, savings and whether an agent may sweep the wallet, the balances
 * usePosition reads every 15 s. For the batch prepared before JAW's sheet (useSigningCash).
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
    GOOSE_GUARD
      ? client.readContract({ address: GOOSE_GUARD, abi: guardAbi, functionName: "accountOf", args: [user] })
      : undefined,
  ]);
  return {
    walletRaw,
    savingsRaw,
    saveOn: account ? walletSwept(account[0].jobs, account[1].topUpsOn) : false,
    rescuing: account ? account[0].rescueAt !== 0 : false,
  };
}
