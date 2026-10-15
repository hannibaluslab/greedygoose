import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAbiItem, parseAbi, type Log } from "viem";
import { entryPoint08Abi, entryPoint08Address } from "viem/account-abstraction";
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

describe("decodeActivity: JAW's network fee isn't a move (D4)", () => {
  // As on JAW's receipts (tx 0xfb269d33…): the paymaster pulls the fee in USDC to its treasury in its postOp, then
  // says what it took; EntryPoint v0.8 names the paymaster for the user's operation.
  const paymaster: Address = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402";
  const treasury: Address = "0x4337Ff05c84B9A80Ea0a78dBE7B8E102F66d4c08";
  const opHash = `0x${"ab".repeat(32)}` as const;
  const sponsoredAbi = parseAbi([
    "event UserOperationSponsored(bytes32 indexed userOpHash, address indexed user, uint8 paymasterMode, address token, uint256 tokenAmountPaid, uint256 exchangeRate)",
  ]);
  const sponsored = (who: Address, amount: bigint, token: Address = USDC.address, from: Address = paymaster) =>
    log(
      from,
      encodeEventTopics({ abi: sponsoredAbi, eventName: "UserOperationSponsored", args: { userOpHash: opHash, user: who } }),
      encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [1, token, amount, 10n ** 18n]),
    );
  const operation = (sender: Address, at: Address = entryPoint08Address) =>
    log(
      at,
      encodeEventTopics({ abi: entryPoint08Abi, eventName: "UserOperationEvent", args: { userOpHash: opHash, sender, paymaster } }),
      encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, true, 1n, 1n]),
    );
  const fee = 10_858n;

  it("a repay with its fee is the repay alone", () => {
    const logs = [repayEvent(user, 10_000_000n), transfer(USDC.address, user, AAVE.HUB, 10_000_000n), transfer(USDC.address, user, treasury, fee), sponsored(user, fee), operation(user)];
    expect(decodeActivity(logs, user)).toEqual([{ kind: "repay", symbol: "USDC", amount: 10 }]);
  });

  it("a buy's price leaves the fee out, so a Credit Buy's cash part is 0", () => {
    const logs = [transfer(USDC.address, user, pool, 1_000_000n), transfer(nvda.address, pool, user, 436_000n), transfer(USDC.address, user, treasury, fee), sponsored(user, fee), operation(user)];
    expect(decodeActivity(logs, user)).toEqual([{ kind: "buy", symbol: "NVDAc", amount: 0.00436, paidUsd: 1 }]);
  });

  it("is read from the chain, never assumed: anything that doesn't match stays a send", () => {
    const send = transfer(USDC.address, user, treasury, fee);
    // No user operation from EntryPoint v0.8 for this user.
    expect(decodeActivity([send, sponsored(user, fee)], user)).toEqual([{ kind: "send", symbol: "USDC", amount: 0.010858 }]);
    expect(decodeActivity([send, sponsored(user, fee), operation(user, other)], user)).toEqual([{ kind: "send", symbol: "USDC", amount: 0.010858 }]);
    expect(decodeActivity([send, sponsored(user, fee), operation(other)], user)).toEqual([{ kind: "send", symbol: "USDC", amount: 0.010858 }]);
    // A different amount, another user's fee, or a fee in another token.
    expect(decodeActivity([send, sponsored(user, fee + 1n), operation(user)], user)).toEqual([{ kind: "send", symbol: "USDC", amount: 0.010858 }]);
    expect(decodeActivity([send, sponsored(other, fee), operation(user)], user)).toEqual([{ kind: "send", symbol: "USDC", amount: 0.010858 }]);
    expect(decodeActivity([send, sponsored(user, fee, nvda.address), operation(user)], user)).toEqual([{ kind: "send", symbol: "USDC", amount: 0.010858 }]);
    // Emitted by something other than the operation's paymaster.
    expect(decodeActivity([send, sponsored(user, fee, USDC.address, other), operation(user)], user)).toEqual([{ kind: "send", symbol: "USDC", amount: 0.010858 }]);
  });

  it("takes out one transfer only, the one before the paymaster's record", () => {
    const logs = [transfer(USDC.address, user, other, fee), transfer(USDC.address, user, treasury, fee), sponsored(user, fee), operation(user)];
    expect(decodeActivity(logs, user)).toEqual([{ kind: "send", symbol: "USDC", amount: 0.010858 }]);
  });
});
