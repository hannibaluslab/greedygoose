import { erc20Abi, type Address } from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { priceToUsd } from "@/lib/aave/math";
import { PROTOCOLS } from "@/lib/protocols/config";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

/**
 * What the account is worth, read as Home reads it (usePosition): each stock's free and backing shares at Aave's price
 * (the oracle's price already carries the multiplier, so raw units × price), the wallet's USDC and savings, less the
 * credit owed. One multicall, so it can be read at any past block for the P&L line.
 */
export function worthContracts(user: Address) {
  return [
    ...EQUITIES.flatMap((e) => [
      { address: e.address, abi: erc20Abi, functionName: "balanceOf", args: [user] },
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(e.reserveId), user] },
      { address: AAVE.SPOKE_ORACLE, abi: aaveOracleAbi, functionName: "getReservePrice", args: [BigInt(e.reserveId)] },
    ]),
    { address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [user] },
    { address: PROTOCOLS.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [user] },
    { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC.reserveId), user] },
  ] as const;
}

/** A read that failed (before a contract existed, say) counts as 0. */
type Result = { status: "success"; result: unknown } | { status: "failure" };
const big = (r: Result | undefined) => (r?.status === "success" && typeof r.result === "bigint" ? r.result : 0n);

/** worthContracts' results, in dollars: cash + stocks − credit owed. */
export function worthFrom(results: readonly Result[]): number {
  let usd = 0;
  EQUITIES.forEach((e, i) => {
    const [bal, supplied, price] = results.slice(i * 3, i * 3 + 3);
    usd += (Number(big(bal) + big(supplied)) / 10 ** e.decimals) * priceToUsd(big(price));
  });
  const o = EQUITIES.length * 3;
  const cash = Number(big(results[o]) + big(results[o + 1])) / 10 ** USDC.decimals;
  const owed = Number(big(results[o + 2])) / 10 ** USDC.decimals;
  return usd + cash - owed;
}
