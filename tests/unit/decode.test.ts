import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAbiItem, type Log } from "viem";
import { decodeActivity } from "@/lib/activity/decode";
import { AAVE } from "@/lib/aave/addresses";
import { spokeAbi } from "@/lib/aave/abis/ISpoke";
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
