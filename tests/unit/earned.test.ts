import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { averageYield, earnedPeriod, moveIn, sinceLastMoveRaw } from "@/lib/earned";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";

const events = parseAbi([
  "event Mint(address indexed caller, address indexed onBehalfOf, uint256 value, uint256 balanceIncrease, uint256 index)",
  "event Burn(address indexed from, address indexed target, uint256 value, uint256 balanceIncrease, uint256 index)",
]);
const ME = "0xFf13Dc32AcA90b3D61058ea26Df1D895F842eE1F";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const data = (value: bigint, increase: bigint) =>
  encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [value, increase, 10n ** 27n]);
const mint = (to: string, increase: bigint, address: string = PROTOCOLS.AUSDC) => ({
  address: address as `0x${string}`,
  topics: encodeEventTopics({
    abi: events,
    eventName: "Mint",
    args: { caller: to as `0x${string}`, onBehalfOf: to as `0x${string}` },
  }) as Hex[],
  data: data(1_000_000n, increase),
});
const burn = (from: string, increase: bigint) => ({
  address: PROTOCOLS.AUSDC,
  topics: encodeEventTopics({
    abi: events,
    eventName: "Burn",
    args: { from: from as `0x${string}`, target: from as `0x${string}` },
  }) as Hex[],
  data: data(1_000_000n, increase),
});

describe("total earned in savings", () => {
  it("adds the interest each of the account's own aUSDC Mints and Burns closed", () => {
    expect(moveIn([mint(ME, 29n), burn(ME, 100n)], ME).inc).toBe(129n);
  });

  it("leaves out someone else's moves and other tokens' events", () => {
    expect(moveIn([mint(OTHER, 50n), mint(ME, 7n, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")], ME)).toEqual({
      inc: 0n,
      net: 0n,
    });
  });

  it("reads what went in and came out from the pool's USDC Supply and Withdraw", () => {
    const pool = parseAbi([
      "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
      "event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)",
    ]);
    const supply = {
      address: PROTOCOLS.AAVE_V3_POOL,
      topics: encodeEventTopics({
        abi: pool,
        eventName: "Supply",
        args: { reserve: USDC.address, onBehalfOf: ME, referralCode: 0 },
      }) as Hex[],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ME, 5_000_000n]),
    };
    const withdraw = {
      address: PROTOCOLS.AAVE_V3_POOL,
      topics: encodeEventTopics({
        abi: pool,
        eventName: "Withdraw",
        args: { reserve: USDC.address, user: ME, to: ME },
      }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [1_250_000n]),
    };
    expect(moveIn([supply, withdraw, mint(ME, 3n)], ME)).toEqual({ inc: 3n, net: 3_750_000n });
  });

  it("adds what built up since the last move: the balance now less the balance at that move's index", () => {
    // 1,757,694 scaled at index 1.14988… was 2,021,138; the balance is 2,021,167 now.
    expect(sinceLastMoveRaw(2_021_167n, 1_757_694n, 1149880534825988900466754985n)).toBe(29n);
    expect(sinceLastMoveRaw(0n, 0n, 0n)).toBe(0n);
  });

  const DAY = 86_400;
  // $100 in on day 0; on day 10 the move closes $1 of interest and $100 more goes in; $0.50 built up since, to day 20.
  const moves = [
    { t: 0, inc: 0, net: 100 },
    { t: 10 * DAY, inc: 1, net: 100 },
  ];

  it("all time: every stretch's interest, the balance averaged over the time since the first move in", () => {
    const all = earnedPeriod(moves, 0.5, 20 * DAY, null);
    expect(all.earnedUsd).toBeCloseTo(1.5, 9);
    expect(all.heldUsd).toBeCloseTo((100 * 10 + 201 * 10) / 20, 9);
    expect(all.days).toBe(20);
    expect(all.fromSec).toBe(0);
  });

  it("a week: the share of each stretch inside it, by time", () => {
    const week = earnedPeriod(moves, 0.5, 20 * DAY, 13 * DAY);
    expect(week.earnedUsd).toBeCloseTo(0.5 * (7 / 10), 9);
    expect(week.heldUsd).toBeCloseTo(201, 9);
    expect(week.days).toBe(7);
    const twelve = earnedPeriod(moves, 0.5, 20 * DAY, 8 * DAY);
    expect(twelve.earnedUsd).toBeCloseTo(1 * (2 / 10) + 0.5, 9);
  });

  it("a year on a younger account starts at its first move in; nothing saved, nothing to show", () => {
    expect(earnedPeriod(moves, 0.5, 20 * DAY, 20 * DAY - 365 * DAY).days).toBe(20);
    expect(earnedPeriod([], 0, 20 * DAY, null)).toEqual({ earnedUsd: 0, heldUsd: 0, days: 0, fromSec: null });
  });
});

describe("the yearly rate a period really earned", () => {
  const p = (earnedUsd: number, heldUsd: number, days: number) => ({ earnedUsd, heldUsd, days, fromSec: 0 });

  it("is what was earned over what was held, compounded over a year", () => {
    // $100 held for a year earning $4 is 4%; the same rate over 30 days reads the same.
    expect(averageYield(p(4, 100, 365))).toBeCloseTo(0.04, 10);
    const daily = 1.04 ** (1 / 365) - 1;
    expect(averageYield(p(100 * ((1 + daily) ** 30 - 1), 100, 30))).toBeCloseTo(0.04, 10);
  });

  it("says nothing under a day, with nothing held, or before any money went in", () => {
    expect(averageYield(p(0.001, 1, 0.5))).toBeNull();
    expect(averageYield(p(0, 0, 3))).toBeNull();
    expect(averageYield({ earnedUsd: 0, heldUsd: 0, days: 0, fromSec: null })).toBeNull();
  });
});
