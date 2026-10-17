import { erc20Abi, type Address, type Client } from "viem";
import { multicall } from "viem/actions";
import { AAVE } from "@/lib/aave/addresses";
import { aaveOracleAbi } from "@/lib/aave/abis/IAaveOracle";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { GUARDIAN } from "@/lib/guardian/config";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { AAVE_V3_USDC_DEBT, USDC_RESERVE_ID } from "./tokens";

/**
 * What a member holds at one block, in raw units: dollars (wallet USDC, savings, USDC supplied to Aave V4 and the
 * other dollar coins at face value, in USDC units), each stock (in the wallet plus supplied to Aave, which includes
 * what backs credit) and the USDC credit owed, on Aave V4 and on Aave V3 (drawn against savings, in another app).
 */
export type Holdings = { usd6: bigint; stocksRaw: bigint[]; debt6: bigint };

/** Aave's price for each stock (8 decimals), by reserve id. */
export type Prices = bigint[];

const PER_ACCOUNT = 2 + ENTRY_COINS.length + EQUITIES.length * 2 + 3;
/** Accounts per multicall: about 1,100 calls, well inside a node's eth_call gas cap. */
const ACCOUNTS_PER_CALL = 50;

const toUsd6 = (value: bigint, decimals: number) =>
  decimals >= 6 ? value / 10n ** BigInt(decimals - 6) : value * 10n ** BigInt(6 - decimals);

function holdingsCalls(a: Address) {
  return [
    { address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [a] },
    { address: GUARDIAN.AUSDC, abi: erc20Abi, functionName: "balanceOf", args: [a] },
    ...ENTRY_COINS.map((c) => ({ address: c.address, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as const),
    ...EQUITIES.flatMap((e) => [
      { address: e.address, abi: erc20Abi, functionName: "balanceOf", args: [a] } as const,
      {
        address: AAVE.SPOKE,
        abi: spokeAbi,
        functionName: "getUserSuppliedAssets",
        args: [BigInt(e.reserveId), a],
      } as const,
    ]),
    { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserSuppliedAssets", args: [BigInt(USDC_RESERVE_ID), a] },
    { address: AAVE.SPOKE, abi: spokeAbi, functionName: "getUserTotalDebt", args: [BigInt(USDC_RESERVE_ID), a] },
    { address: AAVE_V3_USDC_DEBT, abi: erc20Abi, functionName: "balanceOf", args: [a] },
  ] as const;
}

/** Runs a read now, or through a limiter (lib/board/limit.ts). */
type Limit = <T>(job: () => Promise<T>) => Promise<T>;
const now: Limit = (job) => job();

/**
 * Each account's holdings at `blockNumber` (an archive read for a past block), 50 accounts a multicall, each through
 * `limit`. Throws if any read fails.
 */
export async function readHoldings(
  client: Client,
  accounts: readonly Address[],
  blockNumber: bigint,
  limit: Limit = now,
): Promise<Holdings[]> {
  const groups: Address[][] = [];
  for (let i = 0; i < accounts.length; i += ACCOUNTS_PER_CALL) groups.push(accounts.slice(i, i + ACCOUNTS_PER_CALL));
  const reads = await Promise.all(
    groups.map((group) =>
      limit(
        async () =>
          (await multicall(client, {
            blockNumber,
            allowFailure: false,
            batchSize: 0,
            contracts: group.flatMap(holdingsCalls),
          })) as bigint[],
      ),
    ),
  );
  return groups.flatMap((group, g) =>
    group.map((_, j) => {
      const v = reads[g].slice(j * PER_ACCOUNT, (j + 1) * PER_ACCOUNT);
      const [usdc, ausdc] = v;
      const coins = ENTRY_COINS.reduce((sum, c, k) => sum + toUsd6(v[2 + k], c.decimals), 0n);
      const s = 2 + ENTRY_COINS.length;
      const stocksRaw = EQUITIES.map((_, k) => v[s + 2 * k] + v[s + 2 * k + 1]);
      const [usdcSupplied, debtV4, debtV3] = v.slice(s + 2 * EQUITIES.length);
      return { usd6: usdc + ausdc + coins + usdcSupplied, stocksRaw, debt6: debtV4 + debtV3 };
    }),
  );
}

/** Aave's price for every stock at `blockNumber`. */
export async function readPrices(client: Client, blockNumber: bigint, limit: Limit = now): Promise<Prices> {
  return limit(
    async () =>
      (await multicall(client, {
        blockNumber,
        allowFailure: false,
        contracts: EQUITIES.map(
          (e) =>
            ({
              address: AAVE.SPOKE_ORACLE,
              abi: aaveOracleAbi,
              functionName: "getReservePrice",
              args: [BigInt(e.reserveId)],
            }) as const,
        ),
      })) as bigint[],
  );
}

/** A stock amount in USDC units at Aave's price: raw (8 decimals) × price (8 decimals) → 6 decimals. */
export const stockUsd6 = (raw: bigint, price: bigint) => (raw * price) / 10n ** 10n;

/** Net worth in USDC units: dollars + stocks at Aave's price − credit owed. */
export function worth6(h: Holdings, prices: Prices): bigint {
  return h.usd6 + h.stocksRaw.reduce((sum, raw, r) => sum + stockUsd6(raw, prices[r]), 0n) - h.debt6;
}
