import { describe, expect, it } from "vitest";
import { maxUint256 } from "viem";
import type { AgentEvent } from "@/lib/agents/events";
import { describeAgentEvent, type MoveContext, type Words } from "@/lib/agents/feed";
import { clockText } from "@/lib/clock";
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
  it("draws the board's sale: what sold, why, what's owed, the status and the cash, with no limit", () => {
    const sale: AgentEvent = {
      kind: "sold",
      sharesRaw: sevenWith(6, 46_997_389n),
      repaidRaw: usdc(178.2),
      hfBefore: hf(1.02),
      hfAfter: hf(1.12),
    };
    expect(
      row(sale, {
        owedRaw: [usdc(780), usdc(600)],
        cashRaw: [usdc(400), usdc(400)],
        pricesRaw: prices,
      }),
    ).toEqual({
      by: "Protector",
      line: "Sold $180 of Tesla to repay. Back to Watch.",
      details: {
        Why: "Your credit fell under 1.03.",
        "You owe": "$780 → $600",
        Status: "Act → Watch",
        "My cash": "Not touched",
      },
    });
  });

  it("names a sale that goes on through a rescue above 1.03, and what the swaps left in the wallet", () => {
    const sale: AgentEvent = {
      kind: "sold",
      sharesRaw: sevenWith(5, 100_000_000n),
      repaidRaw: usdc(178.2),
      hfBefore: hf(1.08),
      hfAfter: hf(1.12),
    };
    const r = row(sale, { cashRaw: [usdc(10), usdc(11.8)], pricesRaw: prices });
    expect(r.line).toBe("Sold $180 of NVIDIA to repay. Back to Watch.");
    expect(r.details.Why).toBe("Protector went on until 1.12.");
    // A sale cut short (a run's six slices, a limit, the pool's window) says it's still in Act.
    expect(row({ ...sale, hfAfter: hf(1.07) }, { pricesRaw: prices }).line).toBe(
      "Sold $180 of NVIDIA to repay. Still in Act.",
    );
    expect(r.details["My cash"]).toBe("Not used · +$1.80");
  });

  it("falls back to shares when Aave's price at the move can't be read", () => {
    const sale: AgentEvent = {
      kind: "sold",
      sharesRaw: sevenWith(6, 47_000_000n),
      repaidRaw: 1n,
      hfBefore: hf(1),
      hfAfter: hf(1.6),
    };
    expect(row(sale).line).toBe("Sold 0.47 shares of Tesla to repay. Back to Safe.");
  });

  it("says a repay from savings used your cash, rounding what's owed up to the cent, with no limit", () => {
    const r = row(
      { kind: "repaid", amountRaw: usdc(120), hfBefore: hf(1.02), hfAfter: hf(1.12) },
      { owedRaw: [780_000_001n, 660_000_001n] },
    );
    expect(r).toMatchObject({ by: "Protector", line: "Repaid $120 from your cash. Back to Watch." });
    expect(r.details).toEqual({
      Why: "Your credit fell under 1.03.",
      "You owe": "$780.01 → $660.01",
      Status: "Act → Watch",
      "My cash": "$120 used",
    });
    // A rescue going on above the line, and one that paid off everything.
    expect(row({ kind: "repaid", amountRaw: usdc(30), hfBefore: hf(1.06), hfAfter: hf(1.12) }).details.Why).toBe(
      "Protector went on until 1.12.",
    );
    const all = row({ kind: "repaid", amountRaw: usdc(16.58), hfBefore: hf(1.02), hfAfter: maxUint256 });
    expect(all.line).toBe("Repaid $16.58 from your cash. Nothing owed now.");
    expect(all.details.Status).toBe("Act → Nothing owed");
  });

  it("draws a Rebalancer row: what traded, why and the cash, with no limit", () => {
    const r = row(
      { kind: "rebalanced", soldRaw: sevenWith(0, 20_000_000n), boughtRaw: sevenWith(5, 27_777_778n) },
      { cashRaw: [usdc(5), usdc(5.002)], pricesRaw: prices },
    );
    expect(r).toMatchObject({ by: "Rebalancer", line: "Sold $50 of Apple, bought $50 of NVIDIA." });
    expect(r.details).toEqual({
      Why: "Your mix drifted too far from its target.",
      "My cash": "Not touched",
    });
  });

  it("draws top-ups going into the mix: how much, what it bought and the cash it used", () => {
    const r = row({
      kind: "top-up-invested",
      amountRaw: usdc(300),
      boughtRaw: sevenWith(5, 166_666_666n),
    });
    expect(r).toEqual({
      by: "Rebalancer",
      line: "Put $300 of top-ups into your mix.",
      details: {
        Why: "Top-ups above what you keep as cash go into your mix.",
        Bought: "NVIDIA",
        "My cash": "$300 used",
      },
    });
    const two = row({ kind: "top-up-invested", amountRaw: usdc(1_250.5), boughtRaw: [1n, 0n, 0n, 0n, 0n, 1n, 0n] });
    expect(two.line).toBe("Put $1,250.50 of top-ups into your mix.");
    expect(two.details.Bought).toBe("Apple and NVIDIA");
  });

  it("says top-ups switched on with Keep, on with Keep $0, or off; a top-up counted makes no row", () => {
    expect(row({ kind: "top-ups-set", on: true, keepRaw: usdc(500) })).toEqual({
      by: "Rebalancer",
      line: "Top-ups above $500 go into your mix.",
      details: {},
    });
    expect(row({ kind: "top-ups-set", on: true, keepRaw: 0n }).line).toBe("Every top-up goes into your mix.");
    expect(row({ kind: "top-ups-set", on: false, keepRaw: usdc(500) }).line).toBe("Top-ups stay in your cash.");
    expect(describeAgentEvent({ kind: "top-up-counted", amountRaw: usdc(300), waitingRaw: usdc(300) }, at)).toBeNull();
  });

  it("reads a Save as money arriving, with no agent and no limit (D20)", () => {
    const r = row({ kind: "saved", amountRaw: usdc(40) });
    expect(r).toEqual({
      by: "Cash",
      line: "$40 added to your cash.",
      details: { Why: "Money that arrives in your account earns with the rest of your cash." },
    });
  });

  it("reads a conversion as other dollars arriving as cash, and a coin waiting for a fair price as nothing", () => {
    const usde = ENTRY_COINS[1];
    const r = row({
      kind: "converted",
      coin: usde.address,
      amountInRaw: 1_000n * 10n ** 18n,
      usdcOutRaw: 999_569_790n,
    });
    expect(r).toEqual({
      by: "Cash",
      line: "1,000 USDe arrived as $999.57 cash.",
      details: {
        Why: "Dollars other than USDC become cash, at 99.5% of face value or better.",
        "My cash": "+$999.57",
      },
    });
    expect(
      row({ kind: "converted", coin: ENTRY_COINS[0].address, amountInRaw: usdc(120), usdcOutRaw: usdc(119.83) }).line,
    ).toBe("120 USDT arrived as $119.83 cash.");
    expect(
      describeAgentEvent(
        { kind: "entry-waiting", coin: ENTRY_COINS[0].address, amountInRaw: 1n, retryAt: at + 3600 },
        at,
      ),
    ).toBeNull();
  });

  it("names switches, the mix and failed runs in plain words, with the executor's own error name", () => {
    // No agent has an amount limit: the switches name none, whatever cap the grant holds (the executor's CAP_MAX).
    expect(row({ kind: "job-on", job: "protect", capRaw: usdc(5), end: 1_791_984_607 }).line).toBe(
      "Protector is on. If your credit falls under 1.03, it repays from your cash.",
    );
    expect(row({ kind: "job-on", job: "sell", capRaw: usdc(5), end: 1_791_984_607 }).line).toBe(
      "Protector can sell backing stock.",
    );
    expect(row({ kind: "job-on", job: "rebalance", capRaw: usdc(500), end: 1_791_984_607 }).line).toBe(
      "Rebalancer is on.",
    );
    expect(row({ kind: "job-off", job: "protect", reason: "stuck" }).line).toBe(
      "Protector is off: its last runs didn’t go through.",
    );
    expect(row({ kind: "job-off", job: "rebalance", reason: "revoked" }).line).toBe("Rebalancer is off.");
    // Earning and converting are switched on once, where they matter: their switches make no row (D20).
    for (const job of ["save", "entry"] as const) {
      expect(describeAgentEvent({ kind: "job-on", job, capRaw: usdc(1_000), end: 1_791_984_607 }, at)).toBeNull();
      expect(describeAgentEvent({ kind: "job-off", job, reason: "expired" }, at)).toBeNull();
    }
    expect(row({ kind: "mix", weightsBps: [2500, 0, 0, 0, 0, 5000, 2500] }).line).toBe(
      "Your mix: NVIDIA 50%, Apple 25%, Tesla 25%.",
    );
    expect(row({ kind: "mix", weightsBps: [0, 0, 0, 0, 0, 0, 0] }).line).toBe("Your mix is cleared.");
    const failed = row({ kind: "run-failed", reason: "0x122158cf", fails: 2 });
    expect(failed).toMatchObject({ by: "Agents", line: "A run didn’t go through. Nothing moved." });
    expect(failed.details).toMatchObject({ "In a row": "2", Code: "DebtNotLower" });
    // On the viewer's clock with its GMT offset ("12:33 PM GMT+3").
    expect(failed.details["Tries again"]).toBe(clockText(at + 1200));
    expect(failed.details["Tries again"]).toMatch(/^\d{1,2}:\d{2}\s[AP]M GMT([+-]\d{1,2}(:\d{2})?)?$/);
    expect(row({ kind: "run-failed", reason: "0x5a154675", fails: 8 }).details).toEqual({
      "In a row": "8",
      Code: "0x5a154675",
    });
    expect(describeAgentEvent({ kind: "run-deferred" }, at)).toBeNull();
  });

  it("never uses the words D17 bans, nor a savings pot or an agent for the cash (D20)", () => {
    const events: AgentEvent[] = [
      { kind: "job-on", job: "protect", capRaw: 1n, end: at },
      ...(["revoked", "expired", "not-owner", "stuck"] as const).map(
        (reason) => ({ kind: "job-off", job: "sell", reason }) as const,
      ),
      { kind: "saved", amountRaw: 1n },
      { kind: "repaid", amountRaw: 1n, hfBefore: hf(1.02), hfAfter: hf(1.12) },
      { kind: "sold", sharesRaw: sevenWith(1, 1n), repaidRaw: 1n, hfBefore: hf(1), hfAfter: hf(1.4) },
      { kind: "keep-mix", on: true },
      { kind: "keep-mix", on: false },
      { kind: "rebalance-skipped" },
      { kind: "sale-skipped" },
      { kind: "converted", coin: ENTRY_COINS[3].address, amountInRaw: 1n, usdcOutRaw: 1n },
      { kind: "top-up-invested", amountRaw: 1n, boughtRaw: sevenWith(5, 1n) },
      { kind: "top-ups-set", on: true, keepRaw: 1n },
      { kind: "top-ups-set", on: false, keepRaw: 0n },
    ];
    for (const e of events) {
      const m = describeAgentEvent(e, at)!;
      const all = [m.line, ...m.details.map((d) => d.value)].map(text).join(" ");
      expect(all, e.kind).not.toMatch(/borrow|lock|saving|heads-up/i);
      if (e.kind === "repaid" || e.kind === "sold" || e.kind === "job-on")
        expect(all, e.kind).not.toMatch(/limit|a day/);
      if (e.kind === "saved" || e.kind === "converted") expect(all, e.kind).not.toMatch(/agent|save|receive|limit/i);
    }
  });
});
