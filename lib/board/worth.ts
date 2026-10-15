import { erc20Abi, type Address, type Client } from "viem";
import { multicall } from "viem/actions";
import { AAVE } from "@/lib/aave/addresses";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { GUARDIAN } from "@/lib/guardian/config";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { USDC_RESERVE_ID } from "./tokens";

/**
 * What a member holds at one block, in raw units: dollars (wallet USDC, savings, USDC supplied to Aave V4 and the
 * other dollar coins at face value, in USDC units), each stock (in the wallet plus supplied to Aave, which includes
 * what backs credit) and the credit owed.
 */
export type Holdings = { usd6: bigint; stocksRaw: bigint[]; debt6: bigint };

/** Aave's price for each stock (8 decimals), by reserve id. */
export type Prices = bigint[];

const PER_ACCOUNT = 2 + ENTRY_COINS.length + EQUITIES.length * 2 + 2;
/** Accounts per multicall: about 1,100 calls, well inside a node's eth_call gas cap. */
const ACCOUNTS_PER_CALL = 50;

const toUsd6 = (value: bigint, decimals: number) => (decimals >= 6 ? value / 10n ** BigInt(decimals - 6) : value * 10n ** BigInt(6 - decimals));

function holdingsCalls(a: Address) {
  return [
    { address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [a] },
    { address: GUARDIAN.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [a] },
    ...ENTRY_COINS.map((c) => ({ address: c.address, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as const),
    ...EQUITIES.flatMap((e) => [
      { address: e.address, abi: erc20Abi, functionName: "balanceOf", args: [a] } as const,
      { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(e.reserveId), a] } as const,
    ]),
    { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(USDC_RESERVE_ID), a] },
    { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC_RESERVE_ID), a] },
  ] as const;
}

/** Each account's holdings at `blockNumber` (an archive read for a past block). Throws if any read fails. */
export async function readHoldings(client: Client, accounts: readonly Address[], blockNumber: bigint): Promise<Holdings[]> {
  const out: Holdings[] = [];
  for (let i = 0; i < accounts.length; i += ACCOUNTS_PER_CALL) {
    const group = accounts.slice(i, i + ACCOUNTS_PER_CALL);
    const r = (await multicall(client, {
      blockNumber,
      allowFailure: false,
      batchSize: 0,
      contracts: group.flatMap(holdingsCalls),
    })) as bigint[];
    group.forEach((_, j) => {
      const v = r.slice(j * PER_ACCOUNT, (j + 1) * PER_ACCOUNT);
      const [usdc, ausdc] = v;
      const coins = ENTRY_COINS.reduce((sum, c, k) => sum + toUsd6(v[2 + k], c.decimals), 0n);
      const s = 2 + ENTRY_COINS.length;
      const stocksRaw = EQUITIES.map((_, k) => v[s + 2 * k] + v[s + 2 * k + 1]);
      const [usdcSupplied, debt6] = v.slice(s + 2 * EQUITIES.length);
      out.push({ usd6: usdc + ausdc + coins + usdcSupplied, stocksRaw, debt6 });
    });
  }
  return out;
}

/** Aave's price for every stock at `blockNumber`. */
export async function readPrices(client: Client, blockNumber: bigint): Promise<Prices> {
  return (await multicall(client, {
    blockNumber,
    allowFailure: false,
    contracts: EQUITIES.map((e) => ({ address: AAVE.SPOKE_ORACLE, abi: aaveOracleAbi, functionName: "getReservePrice", args: [BigInt(e.reserveId)] }) as const),
  })) as bigint[];
}

/** A stock amount in USDC units at Aave's price: raw (8 decimals) × price (8 decimals) → 6 decimals. */
export const stockUsd6 = (raw: bigint, price: bigint) => (raw * price) / 10n ** 10n;

/** Net worth in USDC units: dollars + stocks at Aave's price − credit owed. */
export function worth6(h: Holdings, prices: Prices): bigint {
  return h.usd6 + h.stocksRaw.reduce((sum, raw, r) => sum + stockUsd6(raw, prices[r]), 0n) - h.debt6;
}
