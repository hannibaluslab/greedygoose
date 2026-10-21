import { describe, expect, it } from "vitest";
import { guideContent, type GuideFlags } from "@/lib/guide/content";

const TODAY: GuideFlags = {
  agentsLive: false,
  boardShown: true,
  boardOpen: false,
  fuelTankUsd: 0.1,
  coins: ["USDT", "USDe", "USDS", "DAI", "EURC"],
};

const allText = (flags: GuideFlags) => {
  const g = guideContent(flags);
  return [
    ...g.intro.flatMap((r) => [r.term, r.text]),
    g.approve,
    ...g.places.flatMap((p) => [p.name, p.text, p.tag ?? ""]),
    ...g.groups.flatMap((gr) => [
      gr.title,
      ...gr.tasks.flatMap((t) => [
        t.title,
        ...t.where,
        ...t.steps,
        ...(t.statuses ?? []).map((s) => s.text),
        t.note ?? "",
        t.link.label,
      ]),
    ]),
    ...g.words.flatMap((w) => [w.term, w.text]),
  ].join(" ");
};

const task = (flags: GuideFlags, id: string) =>
  guideContent(flags)
    .groups.flatMap((g) => g.tasks)
    .find((t) => t.id === id);

describe("guideContent", () => {
  it("never uses the words the app avoids", () => {
    for (const flags of [TODAY, { ...TODAY, agentsLive: true, boardOpen: true }]) {
      expect(allText(flags)).not.toMatch(
        /borrow|loan|\block|unlock|collateral|\broom\b|aave|jaw|cooked|goosed|golden/i,
      );
      expect(allText(flags)).not.toMatch(/—|savings|add money/i);
    }
  });

  it("tags agents and the leaderboard until they open", () => {
    expect(task(TODAY, "agents")?.tag).toBe("Coming soon");
    expect(task(TODAY, "leaderboard")?.tag).toBe("Opens soon");
    const open = { ...TODAY, agentsLive: true, boardOpen: true };
    expect(task(open, "agents")?.tag).toBeUndefined();
    expect(task(open, "leaderboard")?.tag).toBeUndefined();
    expect(guideContent(open).places.every((p) => !p.tag)).toBe(true);
  });

  it("names Protector in Act only once agents are live", () => {
    const act = (flags: GuideFlags) => task(flags, "status")?.statuses?.find((s) => s.status === "act")?.text;
    expect(act(TODAY)).not.toMatch(/Protector/);
    expect(act({ ...TODAY, agentsLive: true })).toMatch(/^Protector steps in/);
  });

  it("says the leaderboard is proportional, and Greedy Fatalities opens soon", () => {
    const board = task(TODAY, "leaderboard");
    expect(board?.steps[0]).toMatch(/own money, in percent/);
    expect(board?.steps.join(" ")).toMatch(
      /\$100 account can beat a \$100,000 one, and joining early gives no head start/,
    );
    expect(task({ ...TODAY, boardOpen: true }, "fatalities")?.tag).toBe("Opens soon");
    // Once its tab ships (WALL_OPEN), the card opens with the board.
    expect(task({ ...TODAY, boardOpen: true, wallOpen: true }, "fatalities")?.tag).toBeUndefined();
    expect(task(TODAY, "fatalities")?.steps.join(" ")).toMatch(/can’t opt out/);
  });

  it("leaves the leaderboard out when its tab is hidden", () => {
    const hidden = { ...TODAY, boardShown: false };
    expect(task(hidden, "leaderboard")).toBeUndefined();
    expect(task(hidden, "fatalities")).toBeUndefined();
    expect(guideContent(hidden).places.map((p) => p.name)).not.toContain("Leaderboard");
  });

  it("takes the coins and the fuel tank from config", () => {
    expect(task(TODAY, "top-up")?.note).toMatch(/^USDT, USDe, USDS, DAI and EURC work too\./);
    expect(guideContent(TODAY).words.find((w) => w.term === "Fuel tank")?.text).toBe(
      "$0.10 of your cash, kept for network fees.",
    );
  });

  it("keeps every task to at most three steps, each a sentence", () => {
    for (const t of guideContent(TODAY).groups.flatMap((g) => g.tasks)) {
      expect(t.steps.length).toBeLessThanOrEqual(3);
      for (const s of t.steps) expect(s).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("links only to routes the app has", () => {
    const routes = /^\/(home(\?topup|\?repay)?|portfolio(\?market)?|send|agents|activity|leaderboard|settings)$/;
    for (const t of guideContent(TODAY).groups.flatMap((g) => g.tasks)) expect(t.link.href).toMatch(routes);
  });
});
