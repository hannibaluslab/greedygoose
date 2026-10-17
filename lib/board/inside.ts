import { parseAbi, zeroAddress, type Address, type Client } from "viem";
import { multicall } from "viem/actions";
import { AAVE } from "@/lib/aave/addresses";
import { AERODROME, AERODROME_V1, SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

const aeroFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
]);
const uniFactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
const psmAbi = parseAbi(["function pocket() view returns (address)"]);

/**
 * Aave V4's hub and spoke. A leg with them is the account's own only next to its own spoke event (lib/board/flows.ts).
 */
export const AAVE_V4_PLACES: readonly Address[] = [AAVE.HUB, AAVE.SPOKE];

/**
 * The swap venues a member's trades go through, from the venues' own factories (lib/swap/venues.ts): each stock
 * against USDC on Aerodrome Slipstream at every tick spacing the app quotes and on Uniswap v3 at every fee tier, each
 * Entry coin against USDC where the app converts it, and Spark's PSM3 with the pocket that pays out its USDC (PSM3
 * itself, read 2026-10-15; read live so a move of it is followed). A trade's two legs go to and come back from the same
 * venue in one transaction (lib/board/flows.ts), so a payout someone else routes through one is money put in. Keyed by
 * lowercase address; the value names the venue, so PSM3 and its pocket are one.
 *
 * The routers are not venues: the app's swaps move tokens between the account and the pool directly, so a router only
 * ever sends the account money someone else left in it (a sweep), which is money put in. Pools never move, so this is
 * read once a session.
 */
export async function readVenues(client: Client): Promise<Map<string, string>> {
  const aero = (factory: Address, token: Address, tickSpacing: number) =>
    ({
      address: factory,
      abi: aeroFactoryAbi,
      functionName: "getPool",
      args: [token, USDC.address, tickSpacing],
    }) as const;
  const uni = (token: Address, fee: number) =>
    ({
      address: UNISWAP.FACTORY as Address,
      abi: uniFactoryAbi,
      functionName: "getPool",
      args: [token, USDC.address, fee],
    }) as const;
  const aeroCalls = [
    ...EQUITIES.flatMap((e) => AERODROME.TICK_SPACINGS.map((t) => aero(AERODROME.FACTORY, e.address, t))),
    ...ENTRY_COINS.flatMap((c) =>
      c.venue.kind === "aerodrome" ? [aero(AERODROME_V1.FACTORY, c.address, c.venue.tickSpacing)] : [],
    ),
  ];
  const uniCalls = [
    ...EQUITIES.flatMap((e) => UNISWAP.FEE_TIERS.map((f) => uni(e.address, f))),
    ...ENTRY_COINS.flatMap((c) => (c.venue.kind === "uniswap" ? [uni(c.address, c.venue.fee)] : [])),
  ];
  const [aeroPools, uniPools, pocket] = await Promise.all([
    multicall(client, { contracts: aeroCalls, allowFailure: false }),
    multicall(client, { contracts: uniCalls, allowFailure: false }),
    multicall(client, {
      contracts: [{ address: SPARK_PSM3.PSM3, abi: psmAbi, functionName: "pocket" }],
      allowFailure: false,
    }),
  ]);
  const venues = new Map<string, string>();
  for (const p of [...aeroPools, ...uniPools]) if (p !== zeroAddress) venues.set(p.toLowerCase(), p.toLowerCase());
  for (const p of [SPARK_PSM3.PSM3, ...pocket]) venues.set(p.toLowerCase(), "psm3");
  return venues;
}
