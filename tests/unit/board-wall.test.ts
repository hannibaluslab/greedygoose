import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  formatLog,
  getAbiItem,
  type Address,
  type Hex,
  type RpcLog,
} from "viem";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { gooseBoardAbi } from "@/lib/board/abi";
import { decodeWallLogs } from "@/lib/board/logs";
import { countedSales, rankWall, saleMultiple, wallSince, type WallSale } from "@/lib/board/wall";
import type { Holdings } from "@/lib/board/worth";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

/*
 * Greedy Fatalities (lib/board/wall.ts): who is on the Wall, from when, and in what order. The reads are readWall's
 * (lib/board/read.ts); these are the rules it applies to them.
 */

const SAM = "0x000000000000000000000000000000000000a11c" as Address;
const KIT = "0x000000000000000000000000000000000000b0b0" as Address;
const LEO = "0x000000000000000000000000000000000000c0de" as Address;
const BOARD = "0x0E10c55D3f20D4Ea1DEf5aC6c60480b34c07FcA1" as Address;
const NVDA = EQUITIES.find((e) => e.symbol.startsWith("NVDA"))!;
const MSFT = EQUITIES.find((e) => e.symbol.startsWith("MSFT"))!;
const FROM = 1_000n;

const usd6 = (usd: number) => BigInt(Math.round(usd * 1e6));
const priceRaw = (usd: number) => BigInt(Math.round(usd * 1e8));
const shares = (n: number) => BigInt(Math.round(n * 1e8));
/** Every stock at $100 unless named. */
const prices = (over: Partial<Record<number, number>> = {}) => EQUITIES.map((e) => priceRaw(over[e.reserveId] ?? 100));
const holding = (p: { cash?: number; stocks?: Partial<Record<number, number>>; owed: number }): Holdings => ({
  usd6: usd6(p.cash ?? 0),
  stocksRaw: EQUITIES.map((e) => shares(p.stocks?.[e.reserveId] ?? 0)),
  debt6: usd6(p.owed),
});

let n = 0;
const sale = (account: Address, block: bigint, stockReserveId = NVDA.reserveId): WallSale => ({
  account,
  block,
  tx: `0x${(++n).toString(16).padStart(64, "0")}` as Hex,
  logIndex: 0,
  stockReserveId,
});

describe("the multiple at the sale", () => {
  it("is Home's leverage: what they held ÷ what was theirs", () => {
    // $14,200 of NVIDIA, $13,200 owed: $1,000 their own, 14.2x.
    const h = holding({ stocks: { [NVDA.reserveId]: 142 }, owed: 13_200 });
    expect(saleMultiple(h, prices())).toBeCloseTo(14.2, 10);
  });

  it("counts cash and every stock as held, so cash kept aside lowers it", () => {
    const allIn = holding({ stocks: { [NVDA.reserveId]: 50 }, owed: 3_900 });
    const withCash = holding({ cash: 2_000, stocks: { [NVDA.reserveId]: 50 }, owed: 3_900 });
    expect(saleMultiple(allIn, prices())).toBeCloseTo(5_000 / 1_100, 10);
    expect(saleMultiple(withCash, prices())).toBeCloseTo(7_000 / 3_100, 10);
  });

  it("values what they held at the prices it is given (readWall gives the sale's block, not the one before)", () => {
    const h = holding({ stocks: { [MSFT.reserveId]: 10 }, owed: 790 });
    // Before the price update: $1,000 held, 4.76x. At the sale, after a 2% drop: $980 held, 5.16x.
    expect(saleMultiple(h, prices())).toBeCloseTo(1_000 / 210, 10);
    expect(saleMultiple(h, prices({ [MSFT.reserveId]: 98 }))).toBeCloseTo(980 / 190, 10);
  });

  it("is 'wiped' when what they held no longer covered what they owed, and null when nothing was owed", () => {
    expect(saleMultiple(holding({ stocks: { [NVDA.reserveId]: 10 }, owed: 1_000 }), prices())).toBe("wiped");
    expect(saleMultiple(holding({ stocks: { [NVDA.reserveId]: 10 }, owed: 1_200 }), prices())).toBe("wiped");
    expect(saleMultiple(holding({ stocks: { [NVDA.reserveId]: 10 }, owed: 0 }), prices())).toBeNull();
  });
});

describe("who counts, from when", () => {
  it("a member on the board when the Wall opened counts from its opening; a later one from its first join", () => {
    const since = wallSince({
      from: FROM,
      before: [SAM],
      joins: [
        { account: KIT, block: 1_200n },
        { account: KIT, block: 1_500n }, // left and joined again: its first join still counts
      ],
    });
    expect(since.get(SAM.toLowerCase())).toBe(FROM);
    expect(since.get(KIT.toLowerCase())).toBe(1_200n);
    expect(since.has(LEO.toLowerCase())).toBe(false);
  });

  it("a member who left and joined again after the Wall opened still counts from the opening", () => {
    const since = wallSince({ from: FROM, before: [SAM], joins: [{ account: SAM, block: 1_400n }] });
    expect(since.get(SAM.toLowerCase())).toBe(FROM);
  });

  it("a sale before joining, in the join block, or before the Wall opened isn't counted", () => {
    const since = wallSince({ from: FROM, before: [SAM], joins: [{ account: KIT, block: 1_200n }] });
    const sales = [
      sale(SAM, 900n), // before the Wall opened
      sale(SAM, FROM), // in its opening block
      sale(KIT, 1_100n), // before KIT joined
      sale(KIT, 1_200n), // in KIT's join block
      sale(LEO, 1_300n), // never joined
    ];
    expect(countedSales(sales, since)).toEqual([]);
    const later = [sale(SAM, FROM + 1n), sale(KIT, 1_201n)];
    expect(countedSales(later, since)).toEqual(later);
  });

  it("only a stock sold counts, and a log read twice counts once", () => {
    const since = wallSince({ from: FROM, before: [SAM], joins: [] });
    const usdcSold = sale(SAM, 1_100n, USDC.reserveId);
    const stock = sale(SAM, 1_101n);
    expect(countedSales([usdcSold, stock, { ...stock }], since)).toEqual([stock]);
  });

  it("a sale after leaving still counts: leaving isn't on the list the Wall reads", () => {
    // GooseBoard keeps every account that ever joined in its list; readWall reads that list, never `listed`.
    const since = wallSince({ from: FROM, before: [SAM, KIT], joins: [] });
    expect(countedSales([sale(KIT, 2_000n)], since)).toHaveLength(1);
  });
});

describe("the Wall's order", () => {
  it("nobody yet: no rows", () => {
    expect(rankWall([])).toEqual([]);
  });

  it("boldest first, one row per account at its highest multiple", () => {
    const rows = rankWall([
      { account: SAM, block: 1_100n, multiple: 3.1 },
      { account: KIT, block: 1_200n, multiple: 4.6 },
      { account: SAM, block: 1_300n, multiple: 4.9 }, // SAM sold again, bolder
      { account: SAM, block: 1_400n, multiple: 2.2 },
    ]);
    expect(rows).toEqual([
      { account: SAM, block: 1_300n, multiple: 4.9, rank: 1 },
      { account: KIT, block: 1_200n, multiple: 4.6, rank: 2 },
    ]);
  });

  it("nothing of their own left ranks above every multiple", () => {
    const rows = rankWall([
      { account: SAM, block: 1_100n, multiple: 5.1 },
      { account: KIT, block: 1_200n, multiple: "wiped" },
      { account: KIT, block: 1_100n, multiple: 4.0 },
    ]);
    expect(rows.map((r) => [r.account, r.multiple])).toEqual([
      [KIT, "wiped"],
      [SAM, 5.1],
    ]);
  });

  it("a tie goes to the earlier sale, then by address, so every phone shows the same order", () => {
    const rows = rankWall([
      { account: LEO, block: 1_300n, multiple: 4.2 },
      { account: KIT, block: 1_200n, multiple: 4.2 },
      { account: SAM, block: 1_200n, multiple: 4.2 },
      { account: SAM, block: 1_100n, multiple: 4.2 }, // SAM's earlier sale at the same multiple is its row
    ]);
    expect(rows.map((r) => [r.account, r.block])).toEqual([
      [SAM, 1_100n],
      [KIT, 1_200n],
      [LEO, 1_300n],
    ]);
  });
});

describe("decoding the Wall's logs", () => {
  const log = (address: Address, topics: Hex[], data: Hex, block: bigint, logIndex: number): RpcLog => ({
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    transactionIndex: "0x0",
    blockHash: `0x${"cd".repeat(32)}`,
    removed: false,
  });

  it("reads GooseBoard's Joined and the spoke's LiquidationCall: who, which block, which stock was sold", () => {
    const joined = log(
      BOARD,
      encodeEventTopics({ abi: gooseBoardAbi, eventName: "Joined", args: { account: KIT } }) as Hex[],
      encodeAbiParameters([{ type: "uint256" }], [1_200n]),
      1_200n,
      3,
    );
    const liquidation = log(
      AAVE.SPOKE,
      encodeEventTopics({
        abi: spokeAbi,
        eventName: "LiquidationCall",
        args: { collateralReserveId: BigInt(NVDA.reserveId), debtReserveId: BigInt(USDC.reserveId), user: KIT },
      }) as Hex[],
      encodeAbiParameters(
        getAbiItem({ abi: spokeAbi, name: "LiquidationCall" }).inputs.filter((i) => !i.indexed),
        [LEO, false, 500_000_000n, 1n, { sharesDelta: 0n, offsetRayDelta: 0n, restoredPremiumRay: 0n }, 6n, 1n, 1n],
      ),
      1_300n,
      7,
    );
    const other = log(LEO, [joined.topics[0]!], "0x", 1_300n, 8); // a Joined from another contract
    const { joins, sales } = decodeWallLogs(
      [joined, liquidation, other].map((l) => formatLog(l)),
      BOARD,
    );
    expect(joins).toEqual([{ account: KIT, block: 1_200n }]);
    expect(sales).toEqual([
      { account: KIT, block: 1_300n, tx: `0x${"ab".repeat(32)}`, logIndex: 7, stockReserveId: NVDA.reserveId },
    ]);
  });
});
