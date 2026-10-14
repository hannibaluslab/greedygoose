import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAbiItem, type Log } from "viem";
import { decodeActivity } from "@/lib/activity/decode";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
import { GUARDIAN } from "@/lib/guardian/config";
import { EQUITIES, USDC } from "@/lib/tokens/registry";

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const other: Address = "0x00000000000000000000000000000000000000ee";
const pool: Address = "0x00000000000000000000000000000000000000aa";
const nvda = EQUITIES.find((e) => e.symbol === "NVDAc")!;

const log = (address: Address, topics: ReturnType<typeof encodeEventTopics>, data: `0x${string}`) =>
  ({ address, topics, data, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false }) as unknown as Log;
const transfer = (token: Address, from: Address, to: Address, value: bigint) =>
  log(token, encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }), encodeAbiParameters([{ type: "uint256" }], [value]));
const withdrawEvent = (who: Address, amount: bigint) => {
  const ev = getAbiItem({ abi: spokeAbi, name: "Withdraw" });
  const topics = encodeEventTopics({ abi: [ev], eventName: "Withdraw", args: { reserveId: BigInt(nvda.reserveId), caller: who, user: who } });
  return log(AAVE.SPOKE, topics, encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [amount, amount]));
};
const repayEvent = (who: Address, amount: bigint) => {
  const ev = getAbiItem({ abi: spokeAbi, name: "Repay" });
  const topics = encodeEventTopics({ abi: [ev], eventName: "Repay", args: { reserveId: BigInt(USDC.reserveId), caller: who, user: who } });
  const premium = { type: "tuple", components: [{ type: "int256" }, { type: "int256" }, { type: "uint256" }] } as const;
  return log(AAVE.SPOKE, topics, encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, premium], [amount, amount, [0n, 0n, 0n]]));
};

describe("decodeActivity: sales", () => {
  it("stock out and USDC in is a sale of that stock, for what came in", () => {
    const items = decodeActivity([transfer(nvda.address, user, pool, 2_000_000n), transfer(USDC.address, pool, user, 4_580_000n)], user);
    expect(items).toEqual([{ kind: "sell", symbol: "NVDAc", amount: 0.02, receivedUsd: 4.58 }]);
  });

  it("a sale from backing: the shares come out of Aave, then sell", () => {
    const logs = [
      withdrawEvent(user, 2_000_000n),
      transfer(nvda.address, AAVE.HUB, user, 2_000_000n),
      transfer(nvda.address, user, pool, 2_000_000n),
      transfer(USDC.address, pool, user, 4_580_000n),
    ];
    expect(decodeActivity(logs, user)).toEqual([
      { kind: "withdraw", symbol: "NVDAc", amount: 0.02 },
      { kind: "sell", symbol: "NVDAc", amount: 0.02, receivedUsd: 4.58 },
    ]);
  });

  it("stock out alone is still a send, and USDC in alone a receive", () => {
    expect(decodeActivity([transfer(nvda.address, user, other, 1_000_000n)], user)).toEqual([{ kind: "send", symbol: "NVDAc", amount: 0.01 }]);
    expect(decodeActivity([transfer(USDC.address, other, user, 1_000_000n), transfer(USDC.address, other, user, 2_000_000n)], user)).toEqual([
      { kind: "receive", symbol: "USDC", amount: 1 },
      { kind: "receive", symbol: "USDC", amount: 2 },
    ]);
  });

  it("another account's sale in the same bundle isn't the user's", () => {
    const logs = [transfer(nvda.address, other, pool, 2_000_000n), transfer(USDC.address, pool, other, 4_580_000n)];
    expect(decodeActivity(logs, user)).toEqual([]);
  });
});

describe("decodeActivity: savings stay inside the cash (D15, D20)", () => {
  // Aave V3 sends the USDC from the aToken contract to the account; the fee buffer stays behind in the wallet.
  const fromSavings = (raw: bigint, to: Address = user) => transfer(USDC.address, GUARDIAN.AUSDC, to, raw);
  const intoSavings = (raw: bigint) => transfer(USDC.address, user, GUARDIAN.AUSDC, raw);

  it("a repay paid from savings is one repay, paid from cash", () => {
    const logs = [fromSavings(10_500_000n), repayEvent(user, 10_000_000n), transfer(USDC.address, user, AAVE.HUB, 10_000_000n)];
    expect(decodeActivity(logs, user)).toEqual([{ kind: "repay", symbol: "USDC", amount: 10 }]);
  });

  it("a buy paid from savings is one buy, paid what the swap took", () => {
    const logs = [fromSavings(1_500_000n), transfer(USDC.address, user, pool, 1_000_000n), transfer(nvda.address, pool, user, 436_000n)];
    expect(decodeActivity(logs, user)).toEqual([{ kind: "buy", symbol: "NVDAc", amount: 0.00436, paidUsd: 1 }]);
  });

  it("a Credit Buy whose cash part came from savings is credit taken and a buy", () => {
    const borrow = getAbiItem({ abi: spokeAbi, name: "Borrow" });
    const borrowLog = log(
      AAVE.SPOKE,
      encodeEventTopics({ abi: [borrow], eventName: "Borrow", args: { reserveId: BigInt(USDC.reserveId), caller: user, user } }),
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [200_000_000n, 200_000_000n]),
    );
    const logs = [
      fromSavings(100_500_000n),
      borrowLog,
      transfer(USDC.address, AAVE.HUB, user, 200_000_000n),
      transfer(USDC.address, user, pool, 300_000_000n),
      transfer(nvda.address, pool, user, 130_000_000n),
    ];
    const items = decodeActivity(logs, user);
    expect(items.map((i) => i.kind)).toEqual(["borrow", "buy"]);
    expect(items[1]).toEqual({ kind: "buy", symbol: "NVDAc", amount: 1.3, paidUsd: 300 });
  });

  it("money moving between the wallet and savings alone is no move: the cash didn't change", () => {
    expect(decodeActivity([fromSavings(5_000_000n)], user)).toEqual([]);
    expect(decodeActivity([intoSavings(5_000_000n)], user)).toEqual([]);
  });

  it("another account's withdrawal in the same bundle isn't the user's", () => {
    const logs = [fromSavings(5_000_000n, other), repayEvent(user, 1_000_000n)];
    expect(decodeActivity(logs, user)).toEqual([{ kind: "repay", symbol: "USDC", amount: 1 }]);
  });
});
