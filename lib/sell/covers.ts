import { decodeFunctionData, erc20Abi, isAddressEqual } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import type { Call } from "@/lib/aave/tx";
import { swapOf } from "@/lib/allowlist";
import { feeBufferRaw } from "@/lib/cash";
import { PROTOCOLS } from "@/lib/protocols/config";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { USDC } from "@/lib/tokens/registry";

type Address = `0x${string}`;

const repayOf = (c: Call): bigint | null => {
  if (!isAddressEqual(c.to, AAVE.SPOKE)) return null;
  try {
    const call = decodeFunctionData({ abi: spokeAbi, data: c.data });
    return call.functionName === "repay" ? call.args[1] : null;
  } catch {
    return null;
  }
};

const supplyOf = (c: Call): bigint | null => {
  if (!isAddressEqual(c.to, PROTOCOLS.AAVE_V3_POOL)) return null;
  try {
    const call = decodeFunctionData({ abi: aaveV3PoolAbi, data: c.data });
    return call.functionName === "supply" ? call.args[1] : null;
  } catch {
    return null;
  }
};

/** Every USDC approve to `spender` in the batch: the amounts it approves. */
const usdcApprovesTo = (calls: Call[], spender: Address): bigint[] =>
  calls.flatMap((c) => {
    if (!isAddressEqual(c.to, USDC.address)) return [];
    const call = decodeFunctionData({ abi: erc20Abi, data: c.data });
    return call.functionName === "approve" && isAddressEqual(call.args[0], spender) ? [call.args[1]] : [];
  });

/**
 * The batch's one sale into USDC for the user and its one spend after it (`spendOf`: a repay or a savings supply).
 * Throws unless there is exactly one of each, the sale pays USDC to the user, and the spend comes after it.
 */
function saleThenSpend(
  user: Address,
  calls: Call[],
  spendOf: (c: Call) => bigint | null,
  words: { flow: string; spend: string },
) {
  const swaps = calls.map((c, i) => ({ i, swap: swapOf(c) })).filter((x) => x.swap !== null);
  const spends = calls
    .map((c, i) => ({ i, raw: spendOf(c) }))
    .filter((x): x is { i: number; raw: bigint } => x.raw !== null);
  if (swaps.length !== 1 || spends.length !== 1)
    throw new Error(`Blocked: ${words.flow} is one sale and one ${words.spend}`);
  const sale = swaps[0].swap!.params;
  if (!isAddressEqual(sale.tokenOut, USDC.address) || !isAddressEqual(sale.recipient, user) || spends[0].i < swaps[0].i)
    throw new Error(`Blocked: the ${words.spend} must come after a sale into USDC for the user`);
  return { floorRaw: sale.amountOutMinimum, spendRaw: spends[0].raw };
}

/**
 * A repay that rides on a sale spends only what the sale is sure to bring. Throws unless the batch has exactly one
 * swap into USDC for the user and one repay after it, the repay is no more than the swap's floor (`amountOutMinimum`,
 * less the network-fee buffer when the sale pays the fee), and every USDC approve to the spoke is exactly the repay
 * (or the 0 that resets it). So a batch that would dip into the cash the user already had is never built.
 */
export function assertSaleCoversRepay(user: Address, calls: Call[], feeFromSale: boolean): Call[] {
  const { floorRaw, spendRaw: repayRaw } = saleThenSpend(user, calls, repayOf, {
    flow: "a repay by selling",
    spend: "repay",
  });
  const covered = floorRaw - (feeFromSale ? feeBufferRaw : 0n);
  if (repayRaw <= 0n || repayRaw > covered)
    throw new Error("Blocked: the repay is more than the sale is sure to bring");
  if (usdcApprovesTo(calls, AAVE.SPOKE).some((a) => a !== repayRaw && a !== 0n))
    throw new Error("Blocked: the repay's approval is not exact");
  return calls;
}

/**
 * A savings supply that rides on a sale into cash puts in only what the sale is sure to bring. Throws unless the batch
 * has exactly one swap into USDC for the user and one savings supply after it, the supply is no more than the swap's
 * floor (`amountOutMinimum`) less what the wallet (`walletRaw`, read before the sale) lacks of the network-fee buffer,
 * and every USDC approve to Aave V3's pool is exactly the supply. So the supply never moves cash the user already had,
 * and the wallet always keeps the fee.
 */
export function assertSaleCoversSave(user: Address, calls: Call[], walletRaw: bigint): Call[] {
  const { floorRaw, spendRaw: saveRaw } = saleThenSpend(user, calls, supplyOf, {
    flow: "a sale into savings",
    spend: "savings supply",
  });
  const keep = feeBufferRaw > walletRaw ? feeBufferRaw - walletRaw : 0n;
  if (saveRaw <= 0n || saveRaw > floorRaw - keep)
    throw new Error("Blocked: the savings supply is more than the sale is sure to bring");
  if (usdcApprovesTo(calls, PROTOCOLS.AAVE_V3_POOL).some((a) => a !== saveRaw))
    throw new Error("Blocked: the savings approval is not exact");
  return calls;
}
