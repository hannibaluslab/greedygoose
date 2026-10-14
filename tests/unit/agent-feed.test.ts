import { describe, expect, it } from "vitest";
import { maxUint256 } from "viem";
import type { AgentEvent } from "@/lib/agents/events";
import { describeAgentEvent, limitOf, type MoveContext, type Words } from "@/lib/agents/feed";
import { STATUS_LABEL } from "@/lib/risk/status";
import { ENTRY_COINS } from "@/lib/tokens/stables";

const text = (w: Words) => w.map((p) => (typeof p === "string" ? p : STATUS_LABEL[p.status])).join("");
const WAD = 10n ** 18n;
const hf = (x: number) => (BigInt(Math.round(x * 1000)) * WAD) / 1000n;
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const at = 1_760_000_000;
/** Aave's prices on the board: Tesla at $383, Apple at $250, NVIDIA at $180 (8 decimals, by reserve id). */
const prices = [250e8, 0, 0, 0, 0, 180e8, 383e8].map(BigInt);
const sevenWith = (r: number, raw: bigint) => Array.from({ length: 7 }, (_, i) => (i === r ? raw : 0n));

function row(e: AgentEvent, ctx?: MoveContext) {
  const m = describeAgentEvent(e, at, ctx)!;
  return { by: m.by, line: text(m.line), details: Object.fromEntries(m.details.map((d) => [d.label, text(d.value)])) };
}

describe("describeAgentEvent: the Agents board's rows", () => {
  it("draws the board's sale: what sold, why, what's owed, the status, the cash and the day's limit", () => {
    const sale: AgentEvent = { kind: "sold", sharesRaw: sevenWith(6, 46_997_389n), repaidRaw: usdc(178.2), hfBefore: hf(1.08), hfAfter: hf(1.52), atOnce: true };
    expect(row(sale, { owedRaw: [usdc(780), usdc(600)], cashRaw: [usdc(400), usdc(400)], used: { spentRaw: usdc(180), capRaw: usdc(300) }, pricesRaw: prices })).toEqual({
      by: "Protect",
      line: "Sold $180 of Tesla to repay. Back to Safe.",
      details: {
        Why: "Your credit reached Act, so Protect sold at once.",
        "You owe": "$780 → $600",
        Status: "Act → Safe",
        "Your cash": "Not touched",
        "Used today": "$180 of $300",
      },
    });
  });

  it("draws the board's heads-up: credit in Watch, asked to repay or add more", () => {
    const r = row({ kind: "heads-up", hf: hf(1.24), sellValueRaw: usdc(180), sellAfter: 1_760_635_800 });
    expect(r.line).toBe("Credit reached Watch. Asked you to repay or add more.");
    expect(r.details["Would sell"]).toBe("$180 of backing stock");
    expect(r.details["Sells at"]).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
  });

  it("says a heads-up's sale waits for prices to reopen when its wait ended while they were held", () => {
    // Sunday 2025-10-12 20:00 New York: the reopening the executor gives a heads-up sent just before Friday's freeze.
    expect(row({ kind: "heads-up", hf: hf(1.2), sellValueRaw: usdc(50), sellAfter: 1_760_313_600 }).details["Sells at"]).toBe("When prices reopen");
    // A minute later the market is open, so a sale due then is given its time.
    expect(row({ kind: "heads-up", hf: hf(1.2), sellValueRaw: usdc(50), sellAfter: 1_760_313_660 }).details["Sells at"]).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
  });

  it("names a sale that comes after the heads-up, and what the swaps left in the wallet", () => {
    const sale: AgentEvent = { kind: "sold", sharesRaw: sevenWith(5, 100_000_000n), repaidRaw: usdc(178.2), hfBefore: hf(1.2), hfAfter: hf(1.4), atOnce: false };
    const r = row(sale, { cashRaw: [usdc(10), usdc(11.8)], pricesRaw: prices });
    expect(r.line).toBe("Sold $180 of NVIDIA to repay. Now Watch.");
    expect(r.details.Why).toBe("Your credit was still in Watch after the heads-up.");
    expect(r.details["Your cash"]).toBe("Not used · +$1.80");
  });

  it("falls back to shares when Aave's price at the move can't be read", () => {
    const sale: AgentEvent = { kind: "sold", sharesRaw: sevenWith(6, 47_000_000n), repaidRaw: 1n, hfBefore: hf(1), hfAfter: hf(1.6), atOnce: true };
    expect(row(sale).line).toBe("Sold 0.47 shares of Tesla to repay. Back to Safe.");
  });

  it("says a repay from savings used your cash, rounding what's owed up to the cent", () => {
    const r = row(
      { kind: "repaid", amountRaw: usdc(120), hfBefore: hf(1.3), hfAfter: hf(1.65), reason: "watch" },
      { owedRaw: [780_000_001n, 660_000_001n], used: { spentRaw: usdc(120), capRaw: usdc(300) } },
    );
    expect(r).toMatchObject({ by: "Protect", line: "Repaid $120 from your cash. Back to Safe." });
    expect(r.details).toEqual({
      Why: "Your credit reached Watch.",
      "You owe": "$780.01 → $660.01",
      Status: "Watch → Safe",
      "Your cash": "$120 used",
      "Used today": "$120 of $300",
    });
    const weekend = row({ kind: "repaid", amountRaw: usdc(16.58), hfBefore: hf(1.8), hfAfter: maxUint256, reason: "weekend" });
    expect(weekend.line).toBe("Repaid $16.58 from your cash. Nothing owed now.");
    expect(weekend.details.Status).toBe("Safe → Nothing owed");
    expect(weekend.details.Why).toMatch(/weekend/);
  });

  it("draws a Rebalance row, with the week's limit", () => {
    const r = row(
      { kind: "rebalanced", soldRaw: sevenWith(0, 20_000_000n), boughtRaw: sevenWith(5, 27_777_778n) },
      { cashRaw: [usdc(5), usdc(5.002)], used: { spentRaw: usdc(50), capRaw: usdc(500) }, pricesRaw: prices },
    );
    expect(r).toMatchObject({ by: "Rebalance", line: "Sold $50 of Apple, bought $50 of NVIDIA." });
    expect(r.details).toEqual({ Why: "Your mix drifted too far from its target.", "Your cash": "Not touched", "Used this week": "$50 of $500" });
  });

  it("reads a Save as money arriving, with no agent and no limit (D20)", () => {
    const r = row({ kind: "saved", amountRaw: usdc(40) });
    expect(r).toEqual({
      by: "Cash",
      line: "$40 added to your cash.",
      details: { Why: "Money that arrives in your account earns with the rest of your cash." },
    });
    expect(limitOf({ kind: "saved", amountRaw: 1n })).toBeNull();
  });

  it("reads a conversion as other dollars arriving as cash, and a coin waiting for a fair price as nothing", () => {
    const usde = ENTRY_COINS[1];
    const r = row({ kind: "converted", coin: usde.address, amountInRaw: 1_000n * 10n ** 18n, usdcOutRaw: 999_569_790n });
    expect(r).toEqual({
      by: "Cash",
      line: "1,000 USDe arrived as $999.57 cash.",
      details: { Why: "Dollars other than USDC become cash, at 99.5% of face value or better.", "Your cash": "+$999.57" },
    });
    expect(row({ kind: "converted", coin: ENTRY_COINS[0].address, amountInRaw: usdc(120), usdcOutRaw: usdc(119.83) }).line).toBe(
      "120 USDT arrived as $119.83 cash.",
    );
    expect(limitOf({ kind: "converted", coin: usde.address, amountInRaw: 1n, usdcOutRaw: 1n })).toBeNull();
    expect(describeAgentEvent({ kind: "entry-waiting", coin: ENTRY_COINS[0].address, amountInRaw: 1n, retryAt: at + 3600 }, at)).toBeNull();
  });

  it("names switches, the mix and failed runs in plain words, with the executor's own error name", () => {
    expect(row({ kind: "job-on", job: "sell", capRaw: usdc(300), end: 1_791_984_607 }).line).toBe("Protect can sell backing stock, up to $300 a day.");
    expect(row({ kind: "job-on", job: "rebalance", capRaw: usdc(500), end: 1_791_984_607 }).line).toBe("Rebalance is on, up to $500 a week.");
    expect(row({ kind: "job-off", job: "protect", reason: "stuck" }).line).toBe("Protect is off: its last runs didn't go through.");
    expect(row({ kind: "job-off", job: "rebalance", reason: "revoked" }).line).toBe("Rebalance is off.");
    // Earning and converting are switched on once, where they matter: their switches make no row (D20).
    for (const job of ["save", "entry"] as const) {
      expect(describeAgentEvent({ kind: "job-on", job, capRaw: usdc(1_000), end: 1_791_984_607 }, at)).toBeNull();
      expect(describeAgentEvent({ kind: "job-off", job, reason: "expired" }, at)).toBeNull();
    }
    expect(row({ kind: "mix", weightsBps: [2500, 0, 0, 0, 0, 5000, 2500] }).line).toBe("Your mix: NVIDIA 50%, Apple 25%, Tesla 25%.");
    expect(row({ kind: "mix", weightsBps: [0, 0, 0, 0, 0, 0, 0] }).line).toBe("Your mix is cleared.");
    const failed = row({ kind: "run-failed", reason: "0x122158cf", fails: 2 });
    expect(failed).toMatchObject({ by: "Agents", line: "A run didn't go through. Nothing moved." });
    expect(failed.details).toMatchObject({ "In a row": "2", Code: "DebtNotLower" });
    expect(failed.details["Tries again"]).toBe(new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format((at + 1200) * 1000));
    expect(row({ kind: "run-failed", reason: "0x5a154675", fails: 8 }).details).toEqual({ "In a row": "8", Code: "0x5a154675" });
    expect(describeAgentEvent({ kind: "run-deferred" }, at)).toBeNull();
  });

  it("never uses the words D17 bans, nor a savings pot or an agent for the cash (D20)", () => {
    const events: AgentEvent[] = [
      { kind: "job-on", job: "protect", capRaw: 1n, end: at },
      ...(["revoked", "expired", "not-owner", "stuck"] as const).map((reason) => ({ kind: "job-off", job: "sell", reason }) as const),
      { kind: "saved", amountRaw: 1n },
      { kind: "repaid", amountRaw: 1n, hfBefore: hf(1.2), hfAfter: hf(1.6), reason: "weekend" },
      { kind: "heads-up", hf: hf(1.2), sellValueRaw: 1n, sellAfter: at },
      { kind: "heads-up-cleared", hf: hf(1.3) },
      { kind: "sold", sharesRaw: sevenWith(1, 1n), repaidRaw: 1n, hfBefore: hf(1), hfAfter: hf(1.4), atOnce: false },
      { kind: "keep-mix", on: true },
      { kind: "keep-mix", on: false },
      { kind: "rebalance-skipped" },
      { kind: "converted", coin: ENTRY_COINS[3].address, amountInRaw: 1n, usdcOutRaw: 1n },
    ];
    for (const e of events) {
      const m = describeAgentEvent(e, at)!;
      const all = [m.line, ...m.details.map((d) => d.value)].map(text).join(" ");
      expect(all, e.kind).not.toMatch(/borrow|lock|saving/i);
      if (e.kind === "saved" || e.kind === "converted") expect(all, e.kind).not.toMatch(/agent|save|receive|limit/i);
    }
  });
});
