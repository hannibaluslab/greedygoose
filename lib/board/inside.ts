import { parseAbi, zeroAddress, type Address, type Client } from "viem";
import { multicall } from "viem/actions";
import { AAVE } from "@/lib/aave/addresses";
import { GOOSE_EXECUTOR } from "@/lib/agents/config";
import { GUARDIAN } from "@/lib/guardian/config";
import { AERODROME, AERODROME_V1, ROUTERS, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { GOOSE_BOARD } from "./config";

const aeroFactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)"]);
const uniFactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);

/** Places with no pool to look up: Aave, the swap routers, Spark's PSM3, the agents' executor and the board. */
export function fixedInside(): Address[] {
  return [
    AAVE.HUB,
    AAVE.SPOKE,
    GUARDIAN.AAVE_V3_POOL,
    ...ROUTERS,
    AERODROME_V1.ROUTER,
    SPARK_PSM3.PSM3,
    ...(GOOSE_EXECUTOR ? [GOOSE_EXECUTOR] : []),
    ...(GOOSE_BOARD ? [GOOSE_BOARD] : []),
  ];
}

/**
 * Every pool the app's swaps can trade through, from the venues' own factories (lib/swap/venues.ts): each stock
 * against USDC on Aerodrome Slipstream at every tick spacing the app quotes and on Uniswap v3 at every fee tier, and
 * each Entry coin against USDC where the app converts it. A swap's two legs go to and come from its pool, so they
 * stay inside the account. Pools never move, so this is read once.
 */
export async function readInside(client: Client): Promise<Address[]> {
  const aero = (factory: Address, token: Address, tickSpacing: number) =>
    ({ address: factory, abi: aeroFactoryAbi, functionName: "getPool", args: [token, USDC.address, tickSpacing] }) as const;
  const uni = (token: Address, fee: number) => ({ address: UNISWAP.FACTORY as Address, abi: uniFactoryAbi, functionName: "getPool", args: [token, USDC.address, fee] }) as const;
  const aeroCalls = [
    ...EQUITIES.flatMap((e) => AERODROME.TICK_SPACINGS.map((t) => aero(AERODROME.FACTORY, e.address, t))),
    ...ENTRY_COINS.flatMap((c) => (c.venue.kind === "aerodrome" ? [aero(AERODROME_V1.FACTORY, c.address, c.venue.tickSpacing)] : [])),
  ];
  const uniCalls = [
    ...EQUITIES.flatMap((e) => UNISWAP.FEE_TIERS.map((f) => uni(e.address, f))),
    ...ENTRY_COINS.flatMap((c) => (c.venue.kind === "uniswap" ? [uni(c.address, c.venue.fee)] : [])),
  ];
  const [aeroPools, uniPools] = await Promise.all([
    multicall(client, { contracts: aeroCalls, allowFailure: false }),
    multicall(client, { contracts: uniCalls, allowFailure: false }),
  ]);
  return [...fixedInside(), ...[...aeroPools, ...uniPools].filter((p) => p !== zeroAddress)];
}
