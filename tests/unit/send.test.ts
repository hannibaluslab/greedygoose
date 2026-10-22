import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  parseUnits,
  toFunctionSelector,
  zeroAddress,
  type Hex,
  type Log,
} from "viem";

// assertAllowed, spied but unchanged: buildSendCalls must run every call of the batch through it, with the recipient.
vi.mock("@/lib/allowlist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/allowlist")>();
  return { ...actual, assertAllowed: vi.fn(actual.assertAllowed) };
});

import { decodeActivity } from "@/lib/activity/decode";
import { AAVE } from "@/lib/aave/addresses";
import { assertAllowed } from "@/lib/allowlist";
import { jobGrant, JOBS, sellGrant, rebalanceGrant, entryGrant, stockLimitsRaw } from "@/lib/agents/permissions";
import { feeBufferRaw, type Cash } from "@/lib/cash";
import { ownCashRow } from "@/lib/cashActivity";
import { APP_CONTRACTS, isAppContract, recipientBlock } from "@/lib/contracts";
import { PROTOCOLS } from "@/lib/protocols/config";
import { aaveV3PoolAbi } from "@/lib/protocols/abis";
import { AERODROME, UNISWAP } from "@/lib/swap/venues";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import { CASH } from "@/config/risk";
import { formatUsd } from "@/lib/formatting";
import { ENTRY_COINS } from "@/lib/tokens/stables";
import {
  SEND_COPY,
  SendStop,
  buildSendCalls,
  defaultAsset,
  parseTo,
  planSend,
  recentRecipients,
  recipientNote,
  sendActivity,
  sendForm,
  sendOptions,
  sendSmallPrint,
  toLookups,
  type Recipient,
  type RecipientChecks,
  type SendData,
  type SendForm,
  type ToState,
} from "@/lib/send";
import type { TradeHolding } from "@/lib/trade";

type Address = `0x${string}`;
const user: Address = "0x000000000000000000000000000000000000dEaD";
const sam: Address = "0x6478829650bC51a36ec553575077603911E72952";
const kit: Address = "0x00000000000000000000000000000000000000eE";
const usd = (n: number) => parseUnits(n.toFixed(6), 6);
/** The network-fee buffer, in dollars. */
const B = CASH.feeBufferUsd;
const stock = (symbol: string) => EQUITIES.find((e) => e.symbol === symbol)!;
const nvda = stock("NVDAc");
const amzn = stock("AMZNc");

const PRICE: Record<string, number> = {
  AAPLc: 250,
  AMZNc: 225,
  GOOGLc: 240,
  METAc: 700,
  MSFTc: 500,
  NVDAc: 200,
  TSLAc: 400,
};

/** A holding as usePosition reads it, from dollars free and backing at Aave's price. */
function holding(symbol: string, freeUsd = 0, backingUsd = 0): TradeHolding {
  const e = stock(symbol);
  const p = PRICE[symbol];
  const raw = (v: number) => BigInt(Math.round((v / p) * 1e8));
  const freeRaw = raw(freeUsd);
  const backingRaw = raw(backingUsd);
  return {
    symbol,
    name: e.name,
    priceUsd: p,
    priceRaw: parseUnits(p.toFixed(8), 8),
    freeRaw,
    backingRaw,
    freeUsd: (Number(freeRaw) / 1e8) * p,
    backingUsd: (Number(backingRaw) / 1e8) * p,
    freeShares: Number(freeRaw) / 1e8,
    backingShares: Number(backingRaw) / 1e8,
    multiplier: 10n ** 18n,
    paused: false,
  };
}
function account(cash: Cash, held: Record<string, [number, number]>): SendData {
  return {
    holdings: EQUITIES.map((e) => holding(e.symbol, ...(held[e.symbol] ?? [0, 0]))),
    cash,
    cashUsd: Number(cash.walletRaw + cash.savingsRaw) / 1e6,
  };
}

/** Shaped like the dev preview's backer: cash mostly in savings, $1.80 of free Amazon beside backing, NVIDIA all backing. */
const backer = account(
  { walletRaw: usd(20), savingsRaw: usd(1_919.18), saveOn: false },
  { AMZNc: [1.8, 1_721.43], NVDAc: [0, 1_341.83], TSLAc: [40, 0] },
);
const empty = account({ walletRaw: 0n, savingsRaw: 0n, saveOn: false }, {});
/** What MAX takes from the backer's cash: all of it less the fee buffer, to the cent. */
const BACKER_MAX = Math.floor((1_939.18 - B) * 100 + 1e-6) / 100;

const transfer = (token: Address, to: Address, amount: bigint) => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
  value: 0n,
});
const decodeTransfer = (data: Hex) => decodeFunctionData({ abi: erc20Abi, data });

describe("buildSendCalls (Send's one batch)", () => {
  it("cash from the wallet: one transfer of exactly the amount, to the recipient", () => {
    const cash: Cash = { walletRaw: usd(100), savingsRaw: 0n, saveOn: false };
    const calls = buildSendCalls({ user, token: USDC, to: sam, amountRaw: usd(25), cash });
    expect(calls).toHaveLength(1);
    expect(isAddressEqual(calls[0].to, USDC.address)).toBe(true);
    expect(calls[0].value).toBe(0n);
    const { functionName, args } = decodeTransfer(calls[0].data);
    expect(functionName).toBe("transfer");
    expect(args).toEqual([sam, usd(25)]);
    expect(assertAllowed).toHaveBeenLastCalledWith(user, calls, { sendTo: sam });
  });

  it("cash is one pot: when the wallet is short, the savings withdrawal to the user goes first", () => {
    const cash: Cash = { walletRaw: usd(20), savingsRaw: usd(1_919.18), saveOn: false };
    const calls = buildSendCalls({ user, token: USDC, to: sam, amountRaw: usd(100), cash });
    expect(calls).toHaveLength(2);
    expect(isAddressEqual(calls[0].to, PROTOCOLS.AAVE_V3_POOL)).toBe(true);
    const w = decodeFunctionData({ abi: aaveV3PoolAbi, data: calls[0].data });
    // amount + fee buffer − wallet: 100 + the buffer − 20
    expect(w.args).toEqual([USDC.address, usd(100) + feeBufferRaw - usd(20), user]);
    expect(decodeTransfer(calls[1].data).args).toEqual([sam, usd(100)]);
  });

  it("a stock: only its shares move; the cash pays the fee, from savings when the wallet can't", () => {
    const rich: Cash = { walletRaw: usd(5), savingsRaw: 0n, saveOn: false };
    const calls = buildSendCalls({ user, token: nvda, to: sam, amountRaw: 1_234_567n, cash: rich });
    expect(calls).toHaveLength(1);
    expect(isAddressEqual(calls[0].to, nvda.address)).toBe(true);
    expect(decodeTransfer(calls[0].data).args).toEqual([sam, 1_234_567n]);

    const inSavings: Cash = { walletRaw: 0n, savingsRaw: usd(50), saveOn: false };
    const both = buildSendCalls({ user, token: nvda, to: sam, amountRaw: 1n, cash: inSavings });
    expect(both.map((c) => c.to)).toEqual([PROTOCOLS.AAVE_V3_POOL, nvda.address]);
    expect(decodeFunctionData({ abi: aaveV3PoolAbi, data: both[0].data }).args[1]).toBe(feeBufferRaw);
  });

  it("refuses the account itself, the zero address, the app's contracts, 0 and other tokens", () => {
    const cash: Cash = { walletRaw: usd(100), savingsRaw: 0n, saveOn: false };
    const send =
      (to: Address, amountRaw = usd(1), token = USDC) =>
      () =>
        buildSendCalls({ user, token, to, amountRaw, cash });
    expect(send(user)).toThrow(SendStop);
    expect(send(user)).toThrow(SEND_COPY.self);
    expect(send(zeroAddress)).toThrow(SEND_COPY.zero);
    expect(send(AAVE.SPOKE)).toThrow(SEND_COPY.contract);
    expect(send(USDC.address)).toThrow(SEND_COPY.contract);
    expect(send(nvda.address)).toThrow(SEND_COPY.contract);
    expect(send(sam, 0n)).toThrow(SendStop);
    const usdt = { ...USDC, symbol: "USDT", address: ENTRY_COINS[0].address };
    expect(send(sam, usd(1), usdt)).toThrow(SendStop);
  });

  it("never spends cash that isn't there: the amount and the fee buffer must fit", () => {
    const cash: Cash = { walletRaw: usd(10), savingsRaw: 0n, saveOn: false };
    expect(() => buildSendCalls({ user, token: USDC, to: sam, amountRaw: usd(10) - feeBufferRaw + 1n, cash })).toThrow(
      /More than your cash/,
    );
    expect(buildSendCalls({ user, token: USDC, to: sam, amountRaw: usd(10) - feeBufferRaw, cash })).toHaveLength(1);
    // A stock send with no cash for the fee.
    expect(() =>
      buildSendCalls({
        user,
        token: nvda,
        to: sam,
        amountRaw: 1n,
        cash: { walletRaw: feeBufferRaw - 1n, savingsRaw: 0n, saveOn: false },
      }),
    ).toThrow(/More than your cash/);
  });
});

describe("assertAllowed: the transfer rule (Send only)", () => {
  const ok = { sendTo: sam };

  it("passes one transfer of USDC or a registry stock to the declared recipient", () => {
    for (const token of [USDC.address, ...EQUITIES.map((e) => e.address)]) {
      const batch = [transfer(token, sam, 1n)];
      expect(assertAllowed(user, batch, ok)).toBe(batch);
    }
  });

  it("blocks a transfer in any batch that doesn't declare who it pays (every other flow)", () => {
    expect(() => assertAllowed(user, [transfer(USDC.address, sam, 1n)])).toThrow(/unexpected call/);
    expect(() => assertAllowed(user, [transfer(nvda.address, sam, 1n)], { listSlot: 1n })).toThrow(/unexpected call/);
  });

  it("blocks a transfer to anyone but the declared recipient", () => {
    expect(() => assertAllowed(user, [transfer(USDC.address, kit, 1n)], ok)).toThrow(/unexpected recipient/);
  });

  it("blocks a transfer to the user, even when declared", () => {
    expect(() => assertAllowed(user, [transfer(USDC.address, user, 1n)], { sendTo: user })).toThrow(
      /unexpected recipient/,
    );
  });

  it("blocks a transfer to the zero address or any app or protocol contract, even when declared", () => {
    for (const to of [zeroAddress, ...APP_CONTRACTS]) {
      expect(() => assertAllowed(user, [transfer(USDC.address, to, 1n)], { sendTo: to })).toThrow(
        /unexpected recipient/,
      );
    }
    // The ones that matter most, by name.
    for (const to of [
      AAVE.SPOKE,
      AAVE.HUB,
      PROTOCOLS.AAVE_V3_POOL,
      PROTOCOLS.AUSDC,
      AERODROME.ROUTER,
      UNISWAP.SWAP_ROUTER_02,
      USDC.address,
      nvda.address,
    ]) {
      expect(isAppContract(to)).toBe(true);
    }
  });

  it("blocks a transfer on a token outside the registry", () => {
    // Another dollar the app knows (USDT): approve only, to its venue.
    expect(() => assertAllowed(user, [transfer(ENTRY_COINS[0].address, sam, 1n)], ok)).toThrow(/unexpected call/);
    // Savings' own token, and an unknown token.
    expect(() => assertAllowed(user, [transfer(PROTOCOLS.AUSDC, sam, 1n)], ok)).toThrow(/unexpected target/);
    expect(() => assertAllowed(user, [transfer("0x00000000000000000000000000000000000000a1", sam, 1n)], ok)).toThrow(
      /unexpected target/,
    );
  });

  it("blocks a transfer with value, of 0, or more than one in a batch", () => {
    expect(() => assertAllowed(user, [{ ...transfer(USDC.address, sam, 1n), value: 1n }], ok)).toThrow(
      /unexpected value/,
    );
    expect(() => assertAllowed(user, [transfer(USDC.address, sam, 0n)], ok)).toThrow(/unexpected recipient/);
    expect(() => assertAllowed(user, [transfer(USDC.address, sam, 1n), transfer(nvda.address, sam, 1n)], ok)).toThrow(
      /more than one transfer/,
    );
  });

  it("gives transferFrom nothing", () => {
    const from = {
      to: USDC.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [user, sam, 1n] }),
      value: 0n,
    };
    expect(() => assertAllowed(user, [from], ok)).toThrow(/unexpected call/);
  });

  it("a declared recipient doesn't loosen anything else: approvals still go only to the spoke or a router", () => {
    const approve = {
      to: USDC.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [sam, 1n] }),
      value: 0n,
    };
    expect(() => assertAllowed(user, [approve], ok)).toThrow(/unexpected spender/);
  });
});

describe("agents can't send out (Send is user-signed only)", () => {
  const TRANSFER = toFunctionSelector("transfer(address,uint256)");
  const TRANSFER_FROM = toFunctionSelector("transferFrom(address,address,uint256)");
  const limits = stockLimitsRaw(EQUITIES.map(() => true));

  it("no agent grant lists transfer or transferFrom", () => {
    const grants = [
      ...JOBS.map((job) => jobGrant(job, limits)),
      sellGrant(limits),
      rebalanceGrant(limits),
      entryGrant(),
    ];
    for (const g of grants) {
      for (const c of g.calls ?? []) {
        expect([TRANSFER, TRANSFER_FROM]).not.toContain((c.selector ?? "").toLowerCase());
      }
    }
  });
});

describe("parseTo (what was typed in To)", () => {
  it("takes an address all lowercase or in its checksum's capitals", () => {
    expect(parseTo(sam.toLowerCase())).toEqual({ kind: "address", address: sam });
    expect(parseTo(` ${sam} `)).toEqual({ kind: "address", address: sam });
  });

  it("calls mixed capitals that don't match the checksum a typo", () => {
    const wrong = sam.replace("bC51", "bc51");
    expect(parseTo(wrong)).toEqual({ kind: "invalid", text: SEND_COPY.typo });
  });

  it("takes an address in all capitals, EIP-55's other form without a checksum (QR codes use it), with 0x or 0X", () => {
    expect(parseTo(`0x${sam.slice(2).toUpperCase()}`)).toEqual({ kind: "address", address: sam });
    expect(parseTo(`0X${sam.slice(2).toUpperCase()}`)).toEqual({ kind: "address", address: sam });
    expect(parseTo(`0X${sam.slice(2).toLowerCase()}`)).toEqual({ kind: "address", address: sam });
  });

  it("reads a name that starts with 0x as a name, not a bad address", () => {
    expect(parseTo("0xfoo.eth")).toEqual({ kind: "name", name: "0xfoo.eth" });
    expect(parseTo("0xsam.justan.id")).toEqual({ kind: "name", name: "0xsam.justan.id" });
  });

  it("says what an address looks like when it's too short, too long or not hex", () => {
    expect(parseTo("0x6478")).toEqual({ kind: "invalid", text: SEND_COPY.shape });
    expect(parseTo(`${sam}00`)).toEqual({ kind: "invalid", text: SEND_COPY.shape });
    expect(parseTo(`0x${"g".repeat(40)}`)).toEqual({ kind: "invalid", text: SEND_COPY.shape });
  });

  it("reads anything else as a name: a bare one under the app's parent, a dotted one as typed", () => {
    expect(parseTo("Sam")).toEqual({ kind: "name", name: "sam.justan.id" });
    expect(parseTo("vitalik.eth")).toEqual({ kind: "name", name: "vitalik.eth" });
    expect(parseTo("kit.other.justan.id")).toEqual({ kind: "name", name: "kit.other.justan.id" });
    expect(parseTo("a b")).toEqual({ kind: "invalid", text: SEND_COPY.badName });
    expect(parseTo("  ")).toEqual({ kind: "empty" });
  });
});

describe("recipientNote (the guards)", () => {
  const r = (address: Address, extra: Partial<Recipient> = {}): Recipient => ({
    address,
    name: null,
    onBase: true,
    ...extra,
  });
  const used: RecipientChecks = { base: { code: true, used: true, notAccount: false } };

  it("refuses the account itself, the zero address and the app's contracts, before Base answers", () => {
    expect(recipientNote(r(user), user, {})).toEqual({ block: SEND_COPY.self, warn: null, waiting: false });
    expect(recipientNote(r(zeroAddress), user, {})).toEqual({ block: SEND_COPY.zero, warn: null, waiting: false });
    expect(recipientNote(r(AAVE.SPOKE), user, {})).toEqual({ block: SEND_COPY.contract, warn: null, waiting: false });
    expect(recipientBlock(sam, user)).toBeNull();
  });

  it("waits for Base before it lets the send go, so a warning never lands after the tap", () => {
    expect(recipientNote(r(sam), user, {}).waiting).toBe(true);
    expect(recipientNote(r(sam), user, used)).toEqual({ block: null, warn: null, waiting: false });
  });

  it("says so when Base couldn't be asked, rather than letting the send go as if it had been checked", () => {
    expect(recipientNote(r(sam), user, { base: null })).toEqual({
      block: null,
      warn: SEND_COPY.unchecked,
      waiting: false,
    });
  });

  it("refuses any other token or trading pool, which Base says isn't an account", () => {
    expect(recipientNote(r(kit), user, { base: { code: true, used: true, notAccount: true } })).toEqual({
      block: SEND_COPY.notAccount,
      warn: null,
      waiting: false,
    });
    expect(
      recipientNote(r(kit, { name: "pool.eth", onBase: false }), user, {
        base: { code: true, used: true, notAccount: true },
        ethCode: false,
      }).block,
    ).toBe(SEND_COPY.notAccount);
  });

  it("warns, without blocking, on an address Base has never seen used", () => {
    expect(recipientNote(r(sam), user, { base: { code: false, used: false, notAccount: false } })).toEqual({
      block: null,
      warn: SEND_COPY.unused,
      waiting: false,
    });
  });

  it("a name with only an Ethereum address: refused when it's a contract there with nothing on Base, else always warned", () => {
    const eth = r(sam, { name: "rae.eth", onBase: false });
    expect(recipientNote(eth, user, { base: { code: false, used: false, notAccount: false } }).waiting).toBe(true);
    expect(
      recipientNote(eth, user, { base: { code: false, used: false, notAccount: false }, ethCode: true }).block,
    ).toBe(SEND_COPY.ethOnlyContract("rae.eth"));
    expect(recipientNote(eth, user, { base: { code: true, used: true, notAccount: false }, ethCode: true })).toEqual({
      block: null,
      warn: SEND_COPY.ethOnly,
      waiting: false,
    });
    // A plain key is warned too: an exchange's deposit address is one, and may not take money on Base.
    expect(recipientNote(eth, user, { base: { code: false, used: true, notAccount: false }, ethCode: false })).toEqual({
      block: null,
      warn: SEND_COPY.ethOnly,
      waiting: false,
    });
  });

  it("a name with only an Ethereum address that couldn't be checked on Ethereum or Base is refused, since a lost send can't be told apart", () => {
    const eth = r(sam, { name: "rae.eth", onBase: false });
    expect(recipientNote(eth, user, { base: { code: false, used: true, notAccount: false }, ethCode: null })).toEqual({
      block: SEND_COPY.ethUnchecked,
      warn: null,
      waiting: false,
    });
    expect(recipientNote(eth, user, { base: null, ethCode: true })).toEqual({
      block: SEND_COPY.ethUnchecked,
      warn: null,
      waiting: false,
    });
    // A JAW name is the same account everywhere: its Ethereum address is its Base one, so nothing of this applies.
    expect(recipientNote(r(sam, { name: "sam.justan.id" }), user, used)).toEqual({
      block: null,
      warn: null,
      waiting: false,
    });
  });
});

describe("toLookups (To's lookups, in order)", () => {
  /** A lookup whose answers the test hands out, one per name, whenever it likes. */
  function names() {
    const waiting = new Map<
      string,
      { ok: (v: Awaited<ReturnType<Parameters<typeof toLookups>[1]>>) => void; fail: (e: unknown) => void }
    >();
    const lookup = (name: string) =>
      new Promise<Awaited<ReturnType<Parameters<typeof toLookups>[1]>>>((ok, fail) => waiting.set(name, { ok, fail }));
    return {
      lookup,
      answer: (name: string, address: Address | null) =>
        waiting.get(name)!.ok(address ? { name, address, onBase: true } : null),
      fail: (name: string) => waiting.get(name)!.fail(new Error("rpc down")),
    };
  }
  function setup() {
    const n = names();
    const states: ToState[] = [];
    const to = toLookups((s) => states.push(s), n.lookup);
    return { ...n, to, last: () => states.at(-1) };
  }

  it("a name looked up becomes who it is", async () => {
    const { to, answer, last } = setup();
    const done = to.find("extenso");
    expect(last()).toEqual({ kind: "looking", name: "extenso.justan.id" });
    answer("extenso.justan.id", sam);
    await done;
    expect(last()).toEqual({ kind: "found", recipient: { address: sam, name: "extenso.justan.id", onBase: true } });
  });

  it("an edit while looking drops the lookup: what was typed before never becomes the recipient", async () => {
    const { to, answer, last } = setup();
    const done = to.find("extenso");
    to.edit(); // typed "vitalik.eth" over it
    expect(last()).toEqual({ kind: "idle" });
    answer("extenso.justan.id", sam);
    await done;
    expect(last()).toEqual({ kind: "idle" });
  });

  it("clearing the field while looking drops the lookup too, and a new Find wins over the old one", async () => {
    const { to, answer, last } = setup();
    const first = to.find("extenso");
    to.clear();
    const second = to.find("vitalik.eth");
    answer("extenso.justan.id", sam);
    await first;
    expect(last()).toEqual({ kind: "looking", name: "vitalik.eth" });
    answer("vitalik.eth", kit);
    await second;
    expect(last()).toEqual({ kind: "found", recipient: { address: kit, name: "vitalik.eth", onBase: true } });
  });

  it("a paste or a pick while looking wins, and the late answer is dropped", async () => {
    const { to, answer, fail, last } = setup();
    const a = to.find("extenso");
    await to.find(kit);
    answer("extenso.justan.id", sam);
    await a;
    expect(last()).toEqual({ kind: "found", recipient: { address: kit, name: null, onBase: true } });
    const b = to.find("rae.eth");
    to.pick(sam);
    fail("rae.eth");
    await b;
    // A pick carries no name of its own: the screen checks the address's name again before showing one.
    expect(last()).toEqual({ kind: "found", recipient: { address: sam, name: null, onBase: true } });
  });

  it("an edit clears why there was no one, and a failed lookup says so", async () => {
    const { to, fail, answer, last } = setup();
    const a = to.find("rae.eth");
    fail("rae.eth");
    await a;
    expect(last()).toEqual({ kind: "none", text: SEND_COPY.lookupFailed });
    to.edit();
    expect(last()).toEqual({ kind: "idle" });
    const b = to.find("nobody.eth");
    answer("nobody.eth", null);
    await b;
    expect(last()).toEqual({ kind: "none", text: SEND_COPY.noName("nobody.eth") });
  });

  it("an edit leaves who it is alone (the field isn't shown then) and does nothing while idle", async () => {
    const { to, last } = setup();
    to.edit();
    expect(last()).toBeUndefined();
    await to.find(sam);
    to.edit();
    expect(last()).toEqual({ kind: "found", recipient: { address: sam, name: null, onBase: true } });
  });
});

describe("Send's options and amount", () => {
  it("lists Cash, then the stocks that can go, then those that can't, each in Home's order", () => {
    const opts = sendOptions(backer);
    expect(opts.map((o) => [o.asset, o.disabled])).toEqual([
      ["cash", false],
      ["AMZNc", false],
      ["TSLAc", false],
      ["NVDAc", true],
    ]);
    expect(opts[0].right).toBe(formatUsd(BACKER_MAX));
    expect(opts.find((o) => o.asset === "AMZNc")!.sub).toBe("$1,721.43 of it backs your credit");
    expect(opts.find((o) => o.asset === "NVDAc")!.sub).toBe(SEND_COPY.subAllBacks);
    expect(defaultAsset(backer)).toBe("cash");
    expect(defaultAsset(backer, "AMZNc")).toBe("AMZNc");
    expect(defaultAsset(backer, "NVDAc")).toBe("cash");
    expect(defaultAsset(empty)).toBeNull();
  });

  it("cash MAX is the cash less the fee buffer, and typing more snaps to it", () => {
    let f: SendForm = { asset: "cash", amount: "", all: false };
    f = sendForm(f, { type: "max" }, backer);
    expect(f).toEqual({ asset: "cash", amount: BACKER_MAX.toFixed(2), all: false });
    expect(sendForm(f, { type: "amount", value: "5000" }, backer).amount).toBe(BACKER_MAX.toFixed(2));
    const v = planSend({ ...f, data: backer, user, recipient: null, checks: {} });
    expect(v.amountRaw).toBe(usd(BACKER_MAX));
  });

  it("stock MAX sends every free share exactly, never one that backs credit", () => {
    const f = sendForm({ asset: "AMZNc", amount: "", all: false }, { type: "max" }, backer);
    expect(f.all).toBe(true);
    const amznHolding = backer.holdings.find((h) => h.symbol === "AMZNc")!;
    const v = planSend({ ...f, data: backer, user, recipient: null, checks: {} });
    expect(v.sharesRaw).toBe(amznHolding.freeRaw);
    expect(v.amountRaw).toBe(amznHolding.freeRaw);
    expect(v.hint).toMatchObject({ shares: amznHolding.freeShares, upToUsd: 1.8 });
  });

  it("typed dollars become shares at Aave's price, rounded down, and the screen says how many", () => {
    const v = planSend({ asset: "TSLAc", amount: "10", all: false, data: backer, user, recipient: null, checks: {} });
    expect(v.sharesRaw).toBe(2_500_000n); // $10 at $400
    expect(v.hint).toMatchObject({ shares: 0.025, priceUsd: 400 });
  });

  it("says why the amount can't go", () => {
    const at = (asset: string, amount: string, data = backer) =>
      planSend({ asset, amount, all: false, data, user, recipient: null, checks: {} }).amountNote;
    // Under the fee buffer: any cash amount is more than the cash, or leaves less than the buffer.
    const thinUsd = B * 0.6;
    const thin = account({ walletRaw: usd(thinUsd), savingsRaw: 0n, saveOn: false }, { TSLAc: [40, 0] });
    expect(at("cash", "5", thin)).toBe(SEND_COPY.overCash(thinUsd));
    expect(at("cash", (thinUsd / 2).toFixed(2), thin)).toBe(SEND_COPY.feeBuffer);
    expect(at("TSLAc", "5", thin)).toBe(SEND_COPY.noFee);
    expect(at("NVDAc", "5")).toBe(SEND_COPY.allBacks("NVIDIA"));
    expect(at("TSLAc", "0.000001")).toBe(SEND_COPY.tooSmall);
    expect(at("TSLAc", "10")).toBeNull();
  });

  it("is ready only with an amount, a recipient that passed its guards and Base's answer", () => {
    const plan = (recipient: Recipient | null, checks: RecipientChecks) =>
      planSend({ asset: "cash", amount: "25", all: false, data: backer, user, recipient, checks });
    const toSam: Recipient = { address: sam, name: "sam.justan.id", onBase: true };
    expect(plan(null, {}).ready).toBe(false);
    expect(plan(toSam, {}).ready).toBe(false);
    expect(plan({ ...toSam, address: user }, {}).ready).toBe(false);
    const v = plan(toSam, { base: { code: true, used: true, notAccount: false } });
    expect(v.ready).toBe(true);
    expect(v.button).toBe("Send");
    expect(v.rows).toEqual([
      { label: "To", value: "sam.justan.id" },
      { label: "They get", value: "$25.00" },
    ]);
    expect(v.sentTitle).toBe("Sent $25.00 to sam.justan.id");
    expect(v.smallPrint).toBe(`In one go: exactly 25.00 USDC goes to ${sam} on Base. A send can’t be undone.`);
    // A warning lets it go.
    const fresh = plan(toSam, { base: { code: false, used: false, notAccount: false } });
    expect(fresh.ready).toBe(true);
    expect(fresh.toNote).toEqual({ text: SEND_COPY.unused, tone: "watch" });
  });

  it("a stock's summary and small print give the shares, to the last decimal", () => {
    const v = planSend({
      asset: "TSLAc",
      amount: "10",
      all: false,
      data: backer,
      user,
      recipient: { address: sam, name: null, onBase: true },
      checks: { base: { code: true, used: true, notAccount: false } },
    });
    expect(v.button).toBe("Send");
    expect(v.sentTitle).toBe("Sent 0.025 Tesla to 0x6478…2952");
    expect(v.rows[0]).toEqual({ label: "To", value: "0x6478…2952" });
    expect(v.rows[1].value).toBe("0.025 TSLA · about $10.00");
    // MAX after a refresh left fewer free shares: the fewer are sent, and "about" is what they're worth, not the dollars typed.
    const before = sendForm({ asset: "TSLAc", amount: "", all: false }, { type: "max" }, backer);
    const after = account(backer.cash, { AMZNc: [1.8, 1_721.43], NVDAc: [0, 1_341.83], TSLAc: [30, 0] });
    const moved = planSend({
      ...before,
      data: after,
      user,
      recipient: { address: sam, name: null, onBase: true },
      checks: { base: { code: true, used: true, notAccount: false } },
    });
    expect(moved.amountRaw).toBe(after.holdings.find((h) => h.symbol === "TSLAc")!.freeRaw);
    expect(moved.rows[1].value).toBe("0.075 TSLA · about $30.00");
    expect(v.smallPrint).toContain("exactly 0.025 TSLA goes");
    expect(sendSmallPrint({ token: amzn, amountRaw: 723_456n, multiplier: 10n ** 18n, to: sam })).toContain(
      "exactly 0.00723456 AMZN",
    );
    // A split: shares shown are raw × uiMultiplier.
    expect(sendSmallPrint({ token: amzn, amountRaw: 723_456n, multiplier: 2n * 10n ** 18n, to: sam })).toContain(
      "exactly 0.01446912 AMZN",
    );
  });
});

describe("Activity and the quick picks", () => {
  it("records the send with who it went to, and the name for this device", () => {
    expect(sendActivity(USDC, usd(25), { address: sam, name: "sam.justan.id", onBase: true })).toEqual([
      { kind: "send", symbol: "USDC", amount: 25, to: sam, toName: "sam.justan.id" },
    ]);
    expect(sendActivity(nvda, 1_234_567n, { address: sam, name: null, onBase: true })).toEqual([
      { kind: "send", symbol: "NVDAc", amount: 0.01234567, to: sam },
    ]);
  });

  it("Recent: the people this device sent to, newest first, once each, skipping failures", () => {
    const send = (id: string, time: number, to: Address, status: "done" | "failed" = "done", toName?: string) => ({
      id,
      time,
      status,
      items: [{ kind: "send" as const, symbol: "USDC", amount: 1, to, ...(toName ? { toName } : {}) }],
    });
    const local = [
      send("a", 1, kit),
      send("b", 3, sam, "done", "sam.justan.id"),
      send("c", 2, sam),
      send("d", 4, user, "failed"),
      {
        id: "e",
        time: 5,
        status: "done" as const,
        items: [{ kind: "buy" as const, symbol: "NVDAc", amount: 1, paidUsd: 1 }],
      },
    ];
    expect(recentRecipients(local)).toEqual([
      { address: sam, name: "sam.justan.id" },
      { address: kit, name: null },
    ]);
  });
});

describe("who a send went to, read back from the chain", () => {
  const log = (token: Address, from: Address, to: Address, value: bigint) =>
    ({
      address: token,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
      data: encodeAbiParameters([{ type: "uint256" }], [value]),
      blockHash: null,
      blockNumber: null,
      logIndex: null,
      transactionHash: null,
      transactionIndex: null,
      removed: false,
    }) as unknown as Log;

  it("a cash send from savings decodes as one send to the recipient, the savings leg left out", () => {
    const logs = [
      log(USDC.address, PROTOCOLS.AUSDC, user, usd(80) + feeBufferRaw),
      log(USDC.address, user, sam, usd(100)),
    ];
    expect(decodeActivity(logs, user)).toEqual([{ kind: "send", symbol: "USDC", amount: 100, to: sam }]);
  });

  it("a stock send names its recipient; USDC to two people names no one", () => {
    expect(decodeActivity([log(nvda.address, user, sam, 1_000_000n)], user)).toEqual([
      { kind: "send", symbol: "NVDAc", amount: 0.01, to: sam },
    ]);
    expect(decodeActivity([log(USDC.address, user, sam, usd(1)), log(USDC.address, user, kit, usd(2))], user)).toEqual([
      { kind: "send", symbol: "USDC", amount: 3 },
    ]);
  });

  it("the Cash sheet's row says who, by name on this device, else the short address", () => {
    const row = (items: Parameters<typeof ownCashRow>[0]["items"]) =>
      ownCashRow({ key: "k", time: 0, status: "done", items });
    expect(
      row([{ kind: "send", symbol: "USDC", amount: 20, to: sam, toName: "sam.justan.id" }])!.details,
    ).toContainEqual({ label: "To", value: ["sam.justan.id"] });
    expect(row([{ kind: "send", symbol: "USDC", amount: 20, to: sam }])!.details).toContainEqual({
      label: "To",
      value: ["0x6478…2952"],
    });
    expect(row([{ kind: "send", symbol: "USDC", amount: 20 }])!.details.some((d) => d.label === "To")).toBe(false);
  });
});
