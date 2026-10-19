import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseUnits, zeroAddress, type Address } from "viem";
import type { Cash } from "@/lib/cash";
import { planSend, type Recipient, type RecipientChecks, type SendData } from "@/lib/send";
import { EQUITIES, USDC } from "@/lib/tokens/registry";
import type { TradeHolding } from "@/lib/trade";

/*
 * planSend's outputs over a table of accounts, assets, amounts, recipients and Base's answers, captured before planSend
 * was broken into steps: every case must keep the same output (a digest of it, so the snapshot stays small).
 */

const usd = (n: number) => parseUnits(n.toFixed(6), 6);
const PRICE: Record<string, number> = {
  AAPLc: 250,
  AMZNc: 225,
  GOOGLc: 240,
  METAc: 700,
  MSFTc: 500,
  NVDAc: 200,
  TSLAc: 400,
};

function holding(symbol: string, freeUsd = 0, backingUsd = 0): TradeHolding {
  const e = EQUITIES.find((x) => x.symbol === symbol)!;
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

const account = (cash: Cash, held: Record<string, [number, number]>): SendData => ({
  holdings: EQUITIES.map((e) => holding(e.symbol, ...(held[e.symbol] ?? [0, 0]))),
  cash,
  cashUsd: Number(cash.walletRaw + cash.savingsRaw) / 1e6,
});

const ACCOUNTS: Record<string, SendData> = {
  rich: account(
    { walletRaw: usd(20), savingsRaw: usd(1_919.18), saveOn: true },
    { AMZNc: [1.8, 1_721.43], NVDAc: [0, 2_500], TSLAc: [0.09, 0], AAPLc: [300, 0] },
  ),
  shortCash: account({ walletRaw: usd(0.04), savingsRaw: 0n, saveOn: false }, { AAPLc: [500, 0], NVDAc: [80, 20] }),
  empty: account({ walletRaw: 0n, savingsRaw: 0n, saveOn: false }, {}),
};

const user: Address = "0x000000000000000000000000000000000000dEaD";
const other: Address = "0x1111111111111111111111111111111111111111";
const RECIPIENTS: Record<string, Recipient | null> = {
  none: null,
  named: { address: other, name: "sam.justan.id", onBase: true },
  address: { address: other, name: null, onBase: true },
  ethOnly: { address: other, name: "sam.eth", onBase: false },
  self: { address: user, name: null, onBase: true },
  zero: { address: zeroAddress, name: null, onBase: true },
  usdc: { address: USDC.address, name: null, onBase: true },
};
const CHECKS: Record<string, RecipientChecks> = {
  waiting: {},
  used: { base: { code: false, used: true, notAccount: false }, ethCode: false },
  unused: { base: { code: false, used: false, notAccount: false }, ethCode: false },
  notAccount: { base: { code: true, used: true, notAccount: true }, ethCode: false },
  unchecked: { base: null, ethCode: null },
  ethContract: { base: { code: false, used: false, notAccount: false }, ethCode: true },
};
const ASSETS = [null, "cash", "NVDAc", "AAPLc", "AMZNc", "TSLAc"];
const AMOUNTS = ["", "0.001", "0.5", "1", "25", "100", "5000", "x"];

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
const digest = (v: unknown) => createHash("sha256").update(json(v)).digest("hex").slice(0, 16);

describe("planSend over a table of cases", () => {
  it("keeps every case's output", () => {
    // One digest per account, asset and recipient, over every amount, MAX or not, and every answer from Base.
    const out: Record<string, string> = {};
    let cases = 0;
    for (const [name, data] of Object.entries(ACCOUNTS))
      for (const asset of ASSETS)
        for (const [who, recipient] of Object.entries(RECIPIENTS)) {
          const views: unknown[] = [];
          for (const amount of AMOUNTS)
            for (const all of [false, true])
              for (const checks of Object.values(CHECKS)) {
                views.push(planSend({ asset, amount, all, data, user, recipient, checks }));
                cases++;
              }
          out[`${name} ${asset} ${who}`] = digest(views);
        }
    expect(cases).toBeGreaterThan(5_000);
    expect(out).toMatchSnapshot();
  });
});
