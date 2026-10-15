import { describe, expect, it } from "vitest";
import { zeroAddress, type Address, type Hex } from "viem";
import { flowTotals, memberFlows, peakCredit, priceBlocks, quiet, type Amount, type BoardRecord, type FlowRules } from "@/lib/board/flows";
import { tokenInfo } from "@/lib/board/tokens";
import { GUARDIAN } from "@/lib/guardian/config";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import { SPARK_PSM3, UNISWAP } from "@/lib/swap/venues";

const SAM = "0x000000000000000000000000000000000000a11c" as Address;
const KIT = "0x000000000000000000000000000000000000b0b0" as Address;
const OUTSIDE = "0x00000000000000000000000000000000000ca5e0" as Address;
const POOL = "0x00000000000000000000000000000000000000f1" as Address;
const POOL2 = "0x00000000000000000000000000000000000000f2" as Address;
const HUB = "0x00000000000000000000000000000000000000a4" as Address;
const PSM3 = SPARK_PSM3.PSM3 as Address;
const NVDA = EQUITIES[5].address;
const USDE = ENTRY_COINS.find((c) => c.symbol === "USDe")!;
const USDS = ENTRY_COINS.find((c) => c.symbol === "USDS")!;

const same = (list: Address[]) => (a: Address) => list.some((b) => b.toLowerCase() === a.toLowerCase());
/** Each pool is its own venue; PSM3 and its pocket are one. */
const venues = (pools: Address[], psm: Address[] = []) => (a: Address) =>
  pools.some((b) => b.toLowerCase() === a.toLowerCase()) ? a.toLowerCase() : psm.some((b) => b.toLowerCase() === a.toLowerCase()) ? "psm3" : undefined;
const rules: FlowRules = { usdc: USDC.address, ausdc: GUARDIAN.AUSDC, token: tokenInfo, venue: venues([POOL, POOL2], [PSM3]), aave: same([HUB]) };
/** $100 a share at every block, for settling swaps. */
const PRICE = 100n * 10n ** 8n;
const value = (a: Amount) => ("usd6" in a ? a.usd6 : (a.stock.raw * PRICE) / 10n ** 10n);
const totals = (records: BoardRecord[], who = SAM) => flowTotals(memberFlows(who, 10n, records, rules), value);
let n = 0;
/** A log at `block`: its own transaction unless given one, and always its own log index. */
const at = (block: bigint, tx?: Hex) => {
  n += 1;
  return { block, tx: tx ?? (`0x${n.toString(16).padStart(64, "0")}` as Hex), logIndex: n };
};
const transfer = (block: bigint, token: Address, from: Address, to: Address, value: bigint, tx?: Hex): BoardRecord => ({
  kind: "transfer",
  ...at(block, tx),
  token,
  from,
  to,
  value,
});
const flows = (records: BoardRecord[], who = SAM, joinedAt = 10n) => memberFlows(who, joinedAt, records, rules);

describe("memberFlows", () => {
  it("counts only what happens after the join block", () => {
    const f = flows([transfer(10n, USDC.address, OUTSIDE, SAM, 5n), transfer(11n, USDC.address, OUTSIDE, SAM, 7n)]);
    expect(f.moves).toEqual([{ block: 11n, dir: "in", usd6: 7n }]);
  });

  it("values dollar coins at face value in USDC units, and stocks by reserve", () => {
    const f = flows([
      transfer(11n, USDE.address, OUTSIDE, SAM, 3n * 10n ** 18n),
      transfer(12n, NVDA, SAM, OUTSIDE, 150_000_000n),
      transfer(13n, GUARDIAN.AUSDC, KIT, SAM, 2_000_000n),
    ]);
    expect(f.moves).toEqual([
      { block: 11n, dir: "in", usd6: 3_000_000n },
      { block: 12n, dir: "out", stock: { reserveId: 5, raw: 150_000_000n } },
      { block: 13n, dir: "in", usd6: 2_000_000n },
    ]);
  });

  it("settles a swap's two legs per transaction: the member's own trade is neither money in nor out", () => {
    const tx = `0x${"5".repeat(64)}` as Hex;
    // $100 for one share at $100, and $100 for 0.99 shares (the pool's fee and price): a cost, not money taken out.
    const f = flows([transfer(11n, USDC.address, SAM, POOL, 100_000_000n, tx), transfer(11n, NVDA, POOL, SAM, 99_000_000n, tx)]);
    expect(f.moves).toEqual([]);
    expect(f.swaps).toEqual([{ block: 11n, venue: POOL.toLowerCase(), got: [{ stock: { reserveId: 5, raw: 99_000_000n } }], paid: [{ usd6: 100_000_000n }] }]);
    expect(flowTotals(f, value)).toEqual({ putIn: 0n, takenOut: 0n });
    expect(priceBlocks(f)).toEqual([]);
  });

  it("counts a payout someone else routes through a pool to the member as money put in", () => {
    // Another wallet swaps $10,000 of USDC for NVIDIA with the member as the recipient: the member paid the pool nothing.
    const tx = `0x${"6".repeat(64)}` as Hex;
    expect(totals([transfer(11n, USDC.address, OUTSIDE, POOL, 10_000_000_000n, tx), transfer(11n, NVDA, POOL, SAM, 10_000_000_000n, tx)])).toEqual({
      putIn: 10_000_000_000n,
      takenOut: 0n,
    });
    // Spark's PSM3 paying out USDC for someone else's USDS.
    expect(totals([transfer(12n, USDS.address, OUTSIDE, PSM3, 5n * 10n ** 18n), transfer(12n, USDC.address, PSM3, SAM, 5_000_000n)])).toEqual({ putIn: 5_000_000n, takenOut: 0n });
  });

  it("counts what a swap router sends the member (a sweep of someone else's money) as money put in, even next to the member's own trade", () => {
    const tx = `0x${"7".repeat(64)}` as Hex;
    const own = [transfer(11n, USDC.address, SAM, POOL, 1_000_000n, tx), transfer(11n, NVDA, POOL, SAM, 1_000_000n, tx)];
    const sweep = transfer(11n, USDC.address, UNISWAP.SWAP_ROUTER_02, SAM, 5_000_000_000n, tx);
    expect(totals([...own, sweep])).toEqual({ putIn: 5_000_000_000n, takenOut: 0n });
  });

  it("counts a payout from another venue as money put in, even in the same transaction as the member's own trade", () => {
    // Sam's own $1 trade on one pool, and $10,000 of NVIDIA from another pool he paid nothing.
    const tx = `0x${"8".repeat(64)}` as Hex;
    const f = flows([
      transfer(11n, USDC.address, SAM, POOL, 1_000_000n, tx),
      transfer(11n, NVDA, POOL, SAM, 1_000_000n, tx),
      transfer(11n, NVDA, POOL2, SAM, 10_000_000_000n, tx),
    ]);
    expect(f.swaps.map((x) => x.venue)).toEqual([POOL.toLowerCase()]);
    expect(f.moves).toEqual([{ block: 11n, dir: "in", stock: { reserveId: 5, raw: 10_000_000_000n } }]);
    expect(flowTotals(f, value)).toEqual({ putIn: 10_000_000_000n, takenOut: 0n });
    expect(priceBlocks(f)).toEqual([11n]);
  });

  it("takes Spark's PSM3 and its pocket as one venue", () => {
    const tx = `0x${"8a".repeat(32)}` as Hex;
    const pocket = "0x00000000000000000000000000000000000000c0" as Address;
    const r: FlowRules = { ...rules, venue: venues([POOL], [PSM3, pocket]) };
    const f = memberFlows(SAM, 10n, [transfer(11n, USDS.address, SAM, PSM3, 5n * 10n ** 18n, tx), transfer(11n, USDC.address, pocket, SAM, 5_000_000n, tx)], r);
    expect(f.moves).toEqual([]);
    expect(f.swaps.map((x) => x.venue)).toEqual(["psm3"]);
  });

  it("counts a swap paid out to someone else as money taken out, and money put in for them", () => {
    const tx = `0x${"9".repeat(64)}` as Hex;
    const records = [transfer(11n, USDC.address, SAM, POOL, 50_000_000n, tx), transfer(11n, NVDA, POOL, KIT, 50_000_000n, tx)];
    expect(totals(records)).toEqual({ putIn: 0n, takenOut: 50_000_000n });
    expect(totals(records, KIT)).toEqual({ putIn: 50_000_000n, takenOut: 0n });
  });

  it("treats a leg with Aave V4 as the member's own only next to its own spoke event for that reserve", () => {
    const tx = `0x${"a".repeat(64)}` as Hex;
    const spokeAt = (event: "Supply" | "Withdraw" | "Borrow" | "Repay", reserveId: number, caller: Address, user: Address): BoardRecord => ({
      kind: "spoke",
      ...at(11n, tx),
      event,
      reserveId,
      caller,
      user,
      amount: 7n,
    });
    expect(flows([transfer(11n, NVDA, SAM, HUB, 7n, tx), spokeAt("Supply", 5, SAM, SAM)]).moves).toEqual([]);
    expect(flows([transfer(11n, USDC.address, HUB, SAM, 7n, tx), spokeAt("Borrow", 7, SAM, SAM)]).moves).toEqual([]);
    // From the hub with no event of the member's own (it withdrew someone else's position): money put in.
    expect(flows([transfer(11n, NVDA, HUB, SAM, 7n, tx), spokeAt("Withdraw", 5, SAM, KIT)]).moves).toEqual([{ block: 11n, dir: "in", stock: { reserveId: 5, raw: 7n } }]);
    // The wrong reserve doesn't explain it either.
    expect(flows([transfer(11n, NVDA, HUB, SAM, 7n, tx), spokeAt("Withdraw", 0, SAM, SAM)]).moves).toHaveLength(1);
    // Supplying for someone else: money taken out.
    expect(flows([transfer(11n, NVDA, SAM, HUB, 7n, tx), spokeAt("Supply", 5, SAM, KIT)]).moves).toEqual([{ block: 11n, dir: "out", stock: { reserveId: 5, raw: 7n } }]);
  });

  it("is quiet when nothing happened after joining", () => {
    expect(quiet(flows([transfer(10n, USDC.address, OUTSIDE, SAM, 5n)]))).toBe(true);
    expect(quiet(flows([transfer(11n, USDC.address, OUTSIDE, SAM, 5n)]))).toBe(false);
  });

  it("treats the paymaster's fee as a cost, matched once by amount and token in its transaction", () => {
    const tx = `0x${"f".repeat(64)}` as Hex;
    const fee: BoardRecord = { kind: "fee", ...at(11n, tx), user: SAM, token: USDC.address, amount: 2_628n };
    const f = flows([
      transfer(11n, USDC.address, SAM, OUTSIDE, 13_960_578n, tx), // a payment in the same operation: money out
      transfer(11n, USDC.address, SAM, "0x4337ff05c84b9a80ea0a78dbe7b8e102f66d4c08", 2_628n, tx),
      fee,
    ]);
    expect(f.moves).toEqual([{ block: 11n, dir: "out", usd6: 13_960_578n }]);
    // Another member's fee record doesn't hide Sam's transfer.
    const other = flows([transfer(12n, USDC.address, SAM, OUTSIDE, 2_628n, tx), { ...fee, user: KIT }]);
    expect(other.moves).toHaveLength(1);
  });

  it("reads a transfer between two members once for each side, even when both queries return it", () => {
    const t = transfer(11n, USDC.address, SAM, KIT, 50n);
    expect(flows([t, t]).moves).toEqual([{ block: 11n, dir: "out", usd6: 50n }]);
    expect(flows([t, t], KIT).moves).toEqual([{ block: 11n, dir: "in", usd6: 50n }]);
  });

  it("keeps the member's own savings moves inside, and counts savings moved by or for someone else", () => {
    const [save, take] = [`0x${"b".repeat(64)}` as Hex, `0x${"c".repeat(64)}` as Hex];
    const s = (event: "Supply" | "Withdraw", by: Address, to: Address, amount: bigint, tx?: Hex, block = 13n): BoardRecord => ({
      kind: "savings",
      ...at(block, tx),
      event,
      reserve: USDC.address,
      by,
      for: to,
      amount,
    });
    const own = [
      transfer(11n, USDC.address, SAM, GUARDIAN.AUSDC, 100n, save),
      transfer(11n, GUARDIAN.AUSDC, zeroAddress, SAM, 101n, save),
      s("Supply", SAM, SAM, 100n, save, 11n),
      transfer(12n, GUARDIAN.AUSDC, SAM, zeroAddress, 50n, take),
      transfer(12n, USDC.address, GUARDIAN.AUSDC, SAM, 50n, take),
      s("Withdraw", SAM, SAM, 50n, take, 12n),
    ];
    expect(flows(own).moves).toEqual([]);
    // USDC out of the savings token with no withdrawal or credit of the member's own beside it: money put in.
    expect(flows([transfer(14n, USDC.address, GUARDIAN.AUSDC, SAM, 70n)]).moves).toEqual([{ block: 14n, dir: "in", usd6: 70n }]);
    // Supplying savings for someone else: money taken out (and money put in for them).
    const gift = `0x${"d".repeat(64)}` as Hex;
    const forKit = [transfer(15n, USDC.address, SAM, GUARDIAN.AUSDC, 30n, gift), s("Supply", SAM, KIT, 30n, gift, 15n), transfer(15n, GUARDIAN.AUSDC, zeroAddress, KIT, 30n, gift)];
    expect(flows(forKit).moves).toEqual([{ block: 15n, dir: "out", usd6: 30n }]);
    expect(flows(forKit, KIT).moves).toEqual([{ block: 15n, dir: "in", usd6: 30n }]);
    expect(flows([s("Supply", KIT, SAM, 40n)]).moves).toEqual([{ block: 13n, dir: "in", usd6: 40n }]);
    expect(flows([s("Withdraw", SAM, OUTSIDE, 30n)]).moves).toEqual([{ block: 13n, dir: "out", usd6: 30n }]);
    expect(flows([s("Withdraw", KIT, SAM, 20n)]).moves).toEqual([{ block: 13n, dir: "in", usd6: 20n }]);
    // Another reserve's savings aren't the member's cash.
    expect(flows([{ ...s("Supply", KIT, SAM, 40n), reserve: OUTSIDE } as BoardRecord]).moves).toEqual([]);
  });

  it("counts Aave acting on the member's position for someone else, and tracks credit", () => {
    const spoke = (event: "Supply" | "Withdraw" | "Borrow" | "Repay" | "LiquidationCall", reserveId: number, caller: Address, amount: bigint): BoardRecord => ({
      kind: "spoke",
      ...at(11n),
      event,
      reserveId,
      caller,
      user: SAM,
      amount,
    });
    const own = flows([spoke("Supply", 5, SAM, 9n), spoke("Borrow", 7, SAM, 300n), spoke("Repay", 7, SAM, 100n)]);
    expect(own.moves).toEqual([]);
    expect(own.credit.map((c) => c.delta)).toEqual([300n, -100n]);

    const others = flows([spoke("Supply", 5, KIT, 9n), spoke("Repay", 7, KIT, 50n), spoke("Withdraw", 5, KIT, 4n), spoke("Borrow", 7, KIT, 20n)]);
    expect(others.moves.map((m) => m.dir)).toEqual(["in", "in", "out", "out"]);
    expect(others.moves[0]).toMatchObject({ stock: { reserveId: 5, raw: 9n } });
    expect(others.moves[1]).toMatchObject({ usd6: 50n });

    const liquidated = flows([spoke("LiquidationCall", 7, OUTSIDE, 120n)]);
    expect(liquidated.moves).toEqual([]);
    expect(liquidated.credit.map((c) => c.delta)).toEqual([-120n]);
  });

  it("tracks Aave V3 USDC credit: the member's own is inside and in its credit, someone else's on its behalf is money", () => {
    const tx = `0x${"e".repeat(64)}` as Hex;
    const v3 = (event: "Borrow" | "Repay" | "LiquidationCall", debtor: Address, by: Address, amount: bigint, extra: object = {}, t: Hex = tx): BoardRecord => ({
      kind: "savingsCredit",
      ...at(11n, t),
      event,
      reserve: USDC.address,
      debtor,
      by,
      amount,
      ...extra,
    });
    // Sam draws $700 against his savings (in Aave's own app): USDC out of the savings token, next to his own Borrow.
    const drawn = flows([transfer(11n, USDC.address, GUARDIAN.AUSDC, SAM, 700n, tx), v3("Borrow", SAM, SAM, 700n)]);
    expect(drawn.moves).toEqual([]);
    expect(drawn.credit.map((c) => c.delta)).toEqual([700n]);
    // And repays it.
    const repaid = `0x${"f1".repeat(32)}` as Hex;
    const back = flows([transfer(11n, USDC.address, SAM, GUARDIAN.AUSDC, 700n, repaid), v3("Repay", SAM, SAM, 700n, { aTokens: false }, repaid)]);
    expect(back.moves).toEqual([]);
    expect(back.credit.map((c) => c.delta)).toEqual([-700n]);
    // Kit repays Sam's: money put in for Sam. Kit draws on Sam's credit (delegated): money taken out of Sam's.
    expect(flows([v3("Repay", SAM, KIT, 40n, {}, `0x${"f2".repeat(32)}`)]).moves).toEqual([{ block: 11n, dir: "in", usd6: 40n }]);
    const delegated = flows([v3("Borrow", SAM, KIT, 25n, {}, `0x${"f3".repeat(32)}`)]);
    expect(delegated.moves).toEqual([{ block: 11n, dir: "out", usd6: 25n }]);
    expect(delegated.credit.map((c) => c.delta)).toEqual([25n]);
    // Kit, who got that USDC on Sam's credit: money put in.
    expect(flows([transfer(11n, USDC.address, GUARDIAN.AUSDC, KIT, 25n, `0x${"f3".repeat(32)}`), v3("Borrow", SAM, KIT, 25n, {}, `0x${"f3".repeat(32)}`)], KIT).moves).toEqual([
      { block: 11n, dir: "in", usd6: 25n },
    ]);
    // A liquidator taking Sam's savings as savings: the liquidation's cost, not money taken out.
    const liq = `0x${"f4".repeat(32)}` as Hex;
    const liquidated = flows([transfer(11n, GUARDIAN.AUSDC, SAM, OUTSIDE, 52n, liq), v3("LiquidationCall", SAM, OUTSIDE, 50n, { collateral: USDC.address, aTokens: true }, liq)]);
    expect(liquidated.moves).toEqual([]);
    expect(liquidated.credit.map((c) => c.delta)).toEqual([-50n]);
    // Another reserve's credit isn't in net worth, so it isn't tracked.
    expect(flows([{ ...v3("Borrow", SAM, SAM, 9n, {}, `0x${"f5".repeat(32)}`), reserve: OUTSIDE } as BoardRecord])).toEqual({ moves: [], swaps: [], credit: [] });
  });

  it("ignores tokens it doesn't track and transfers to itself", () => {
    expect(flows([transfer(11n, OUTSIDE, OUTSIDE, SAM, 5n), transfer(11n, USDC.address, SAM, SAM, 5n)]).moves).toEqual([]);
  });
});

describe("peakCredit", () => {
  const step = (block: bigint, delta: bigint) => ({ block, logIndex: 0, delta });
  it("is the most in use at once: at joining, after each step, or now", () => {
    expect(peakCredit(0n, [], 0n)).toBe(0n);
    expect(peakCredit(100n, [], 50n)).toBe(100n);
    expect(peakCredit(0n, [step(2n, -50n), step(1n, 300n), step(3n, 100n)], 360n)).toBe(360n);
    expect(peakCredit(0n, [step(1n, 300n), step(2n, -400n), step(3n, 100n)], 100n)).toBe(300n);
  });
});
