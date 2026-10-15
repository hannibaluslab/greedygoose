import { describe, expect, it } from "vitest";
import { zeroAddress, type Address, type Hex } from "viem";
import { memberFlows, peakCredit, type BoardRecord, type FlowRules } from "@/lib/board/flows";
import { tokenInfo } from "@/lib/board/tokens";
import { GUARDIAN } from "@/lib/guardian/config";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { ENTRY_COINS } from "@/lib/tokens/stables";

const SAM = "0x000000000000000000000000000000000000a11c" as Address;
const KIT = "0x000000000000000000000000000000000000b0b0" as Address;
const OUTSIDE = "0x00000000000000000000000000000000000ca5e0" as Address;
const POOL = "0x00000000000000000000000000000000000000f1" as Address;
const NVDA = EQUITIES[5].address;
const USDE = ENTRY_COINS.find((c) => c.symbol === "USDe")!;

const rules: FlowRules = { usdc: USDC.address, ausdc: GUARDIAN.AUSDC, token: tokenInfo, inside: (a) => a.toLowerCase() === POOL.toLowerCase() };
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

  it("keeps a swap's two legs inside the account", () => {
    const tx = `0x${"5".repeat(64)}` as Hex;
    expect(flows([transfer(11n, USDC.address, SAM, POOL, 100n, tx), transfer(11n, NVDA, POOL, SAM, 1n, tx)]).moves).toEqual([]);
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
    const own = [
      transfer(11n, USDC.address, SAM, GUARDIAN.AUSDC, 100n),
      transfer(11n, GUARDIAN.AUSDC, zeroAddress, SAM, 101n),
      transfer(12n, GUARDIAN.AUSDC, SAM, zeroAddress, 50n),
      transfer(12n, USDC.address, GUARDIAN.AUSDC, SAM, 50n),
    ];
    const s = (event: "Supply" | "Withdraw", by: Address, to: Address, amount: bigint): BoardRecord => ({
      kind: "savings",
      ...at(13n),
      event,
      reserve: USDC.address,
      by,
      for: to,
      amount,
    });
    expect(flows([...own, s("Supply", SAM, SAM, 100n), s("Withdraw", SAM, SAM, 50n)]).moves).toEqual([]);
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
