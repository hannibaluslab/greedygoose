import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatLog, type Address, type RpcLog } from "viem";
import { memberFlows, type FlowRules } from "@/lib/board/flows";
import { AAVE_V4_PLACES } from "@/lib/board/inside";
import { ADDRESSES_PER_QUERY, addressGroups, decodeRecords } from "@/lib/board/logs";
import { BOARD_TOKENS } from "@/lib/board/tokens";
import { tokenInfo } from "@/lib/board/tokens";
import { PROTOCOLS } from "@/lib/protocols/config";
import { USDC } from "@/lib/tokens/registry";

/*
 * The board's decoder and money rules on real Base transactions, recorded once (tests/unit/fixtures/board-logs.json:
 * each transaction's full receipt logs, from eth_getTransactionReceipt on 2026-10-15). They pin the Aave V4 spoke's
 * field mapping (suppliedAmount, drawnAmount, totalAmountRepaid), Aave V3's events, and the paymaster's fee record.
 */

const fixture = JSON.parse(readFileSync("tests/unit/fixtures/board-logs.json", "utf8")) as {
  txs: Record<string, { hash: string; logs: RpcLog[] }>;
};
const records = (k: string) => decodeRecords(fixture.txs[k].logs.map((l) => formatLog(l)));
const rules: FlowRules = {
  usdc: USDC.address,
  ausdc: PROTOCOLS.AUSDC,
  token: tokenInfo,
  venue: () => undefined,
  aave: (a) => AAVE_V4_PLACES.some((b) => b.toLowerCase() === a.toLowerCase()),
};
const flows = (k: string, who: Address) => memberFlows(who, 0n, records(k), rules);

describe("decoding real Base logs", () => {
  it("an Aave V4 Supply and Borrow: the stock and USDC legs with the hub are the account's own; what it sent on is money out", () => {
    const who = "0x31744E44d6aF88225C1dBEFbe5Df8308fAeA641B" as Address;
    const r = records("spoke.Borrow");
    expect(r.filter((x) => x.kind === "spoke")).toMatchObject([
      { event: "Supply", reserveId: 0, caller: who, user: who, amount: 77_724_756n },
      { event: "Borrow", reserveId: 7, caller: who, user: who, amount: 202_315_060n },
    ]);
    const f = flows("spoke.Borrow", who);
    expect(f.moves).toEqual([
      { block: 52_629_055n, dir: "out", usd6: 85_668_350n },
      { block: 52_629_055n, dir: "out", usd6: 107_087_129n },
    ]);
    expect(f.credit.map((c) => c.delta)).toEqual([202_315_060n]);
  });

  it("an Aave V4 Repay is the total repaid, from the account's own USDC; the USDC that arrived first is money in", () => {
    const who = "0xEF83ABC641B98af01f0652E3Af49a25d65C601A5" as Address;
    expect(records("spoke.Repay").find((x) => x.kind === "spoke")).toMatchObject({
      event: "Repay",
      reserveId: 7,
      caller: who,
      user: who,
      amount: 17_488_397_676n,
    });
    const f = flows("spoke.Repay", who);
    expect(f.moves).toEqual([{ block: 52_632_788n, dir: "in", usd6: 17_488_397_676n }]);
    expect(f.credit.map((c) => c.delta)).toEqual([-17_488_397_676n]);
  });

  it("an Aave V4 Supply alone moves no money", () => {
    const who = "0x12F0228426F29652248B70a089FBBb2d18299FA0" as Address;
    expect(records("spoke.Supply").find((x) => x.kind === "spoke")).toMatchObject({
      event: "Supply",
      reserveId: 0,
      amount: 15_039_282n,
    });
    expect(flows("spoke.Supply", who)).toEqual({ moves: [], swaps: [], credit: [] });
  });

  it("Aave V3 savings in and out are the account's own; the USDC it was sent first is money in", () => {
    const saver = "0x17E22cc314015300C8Ac8748d215ED0F3d5dD2ca" as Address;
    expect(records("v3.Supply").find((x) => x.kind === "savings")).toMatchObject({
      event: "Supply",
      by: saver,
      for: saver,
      amount: 200_002_000n,
    });
    expect(flows("v3.Supply", saver).moves).toEqual([{ block: 52_625_312n, dir: "in", usd6: 200_002_000n }]);
    const taker = "0x767C68EA2b4594023B433a5979401460258BaBC5" as Address;
    expect(records("v3.Withdraw").find((x) => x.kind === "savings")).toMatchObject({
      event: "Withdraw",
      by: taker,
      for: taker,
      amount: 1_500_000_000n,
    });
    expect(flows("v3.Withdraw", taker)).toEqual({ moves: [], swaps: [], credit: [] });
  });

  it("Aave V3 USDC credit drawn and repaid by the account is its credit, not money", () => {
    const drew = "0x234888E6DAFDd64A3890Bd2CD8E5558cE81a8E37" as Address;
    expect(records("v3.Borrow").find((x) => x.kind === "savingsCredit")).toMatchObject({
      event: "Borrow",
      debtor: drew,
      by: drew,
      amount: 190_000_000_000n,
    });
    expect(flows("v3.Borrow", drew)).toMatchObject({ moves: [], credit: [{ delta: 190_000_000_000n }] });
    const repaid = "0x4431Cb163D86E411B9bEF0839e44f152CBD22C93" as Address;
    expect(records("v3.Repay").find((x) => x.kind === "savingsCredit")).toMatchObject({
      event: "Repay",
      debtor: repaid,
      by: repaid,
      amount: 2_689_075_367n,
      aTokens: false,
    });
    expect(flows("v3.Repay", repaid)).toMatchObject({ moves: [], credit: [{ delta: -2_689_075_367n }] });
  });

  it("JAW's paymaster fee (ERC-20 mode) is a cost: the payment beside it is money out, the fee isn't", () => {
    const who = "0xc21d75f8D0Acc71580cd1b789058386d9a8ca443" as Address;
    expect(records("paymaster.fee").find((x) => x.kind === "fee")).toMatchObject({
      user: who,
      token: USDC.address,
      amount: 3_245n,
    });
    expect(flows("paymaster.fee", who).moves).toEqual([{ block: 52_626_007n, dir: "out", usd6: 10_200_000n }]);
  });
});

describe("log requests PublicNode takes", () => {
  it("cuts the tracked tokens into groups of at most 10 addresses, keeping every one once and in order", () => {
    const tokens = BOARD_TOKENS.map((t) => t.address);
    const groups = addressGroups(tokens);
    expect(tokens.length).toBeGreaterThan(ADDRESSES_PER_QUERY);
    expect(groups.every((g) => g.length > 0 && g.length <= ADDRESSES_PER_QUERY)).toBe(true);
    expect(groups.flat()).toEqual(tokens);
  });

  it("keeps a short list in one request", () => {
    const two = [USDC.address, PROTOCOLS.AUSDC];
    expect(addressGroups(two)).toEqual([two]);
  });
});
