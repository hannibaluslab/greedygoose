import { CASH } from "@/config/risk";
import { AGENTS_LIVE } from "@/lib/agents/config";
import { GOOSE_BOARD } from "@/lib/board/config";
import { LEADERBOARD_ENABLED } from "@/lib/features";
import { formatUsd, inWords } from "@/lib/formatting";
import type { Status } from "@/lib/risk/status";
import { CASH_COINS } from "@/lib/tokens/stables";

/**
 * The Guide (Menu › Guide): what you can do, where, and how, in the app's own button words. Task first: each row is
 * something a person wants to do, then where it is (the path in labels), at most three steps and one line to know.
 * It says only what is true today: agents and the leaderboard carry their tag from the same flags the app reads, so
 * the Guide changes with them. The leaderboard is proportional (lib/board/score.ts: gain ÷ own money), so the copy says
 * size and joining early don't help.
 */

export type GuideIcon =
  | "topup"
  | "earn"
  | "market"
  | "sell"
  | "trade"
  | "credit"
  | "repay"
  | "status"
  | "earnStocks"
  | "send"
  | "agents"
  | "activity"
  | "board"
  | "fatalities"
  | "settings";

export type GuideTag = "Coming soon" | "Opens soon";

export type GuideTask = {
  id: string;
  title: string;
  /** The path in the app's own labels: Home › Top up. */
  where: readonly string[];
  steps: readonly string[];
  /** Check my credit: the three words of the pill, each with what it means. */
  statuses?: readonly { status: Exclude<Status, "none">; text: string }[];
  note?: string;
  tag?: GuideTag;
  link: { label: string; href: string };
  icon: GuideIcon;
};

type GuidePlace = { name: string; text: string; tag?: GuideTag };

export type Guide = {
  intro: readonly { term: string; text: string }[];
  approve: string;
  places: readonly GuidePlace[];
  groups: readonly { title: string; tasks: readonly GuideTask[] }[];
  words: readonly { term: string; text: string }[];
};

export type GuideFlags = {
  /** The agents can be switched on (AGENTS_LIVE). */
  agentsLive: boolean;
  /** The Leaderboard tab is in the tab bar (LEADERBOARD_ENABLED). */
  boardShown: boolean;
  /** Its members contract is set, so it ranks people rather than saying it opens soon (GOOSE_BOARD). */
  boardOpen: boolean;
  /** The cash kept back for network fees. */
  fuelTankUsd: number;
  /** Dollar coins Turn into cash takes, besides USDC. */
  coins: readonly string[];
};

const FLAGS: GuideFlags = {
  agentsLive: AGENTS_LIVE,
  boardShown: LEADERBOARD_ENABLED,
  boardOpen: !!GOOSE_BOARD,
  fuelTankUsd: CASH.feeBufferUsd,
  coins: CASH_COINS.map((c) => c.symbol),
};

export function guideContent(flags: GuideFlags = FLAGS): Guide {
  const agentsTag: GuideTag | undefined = flags.agentsLive ? undefined : "Coming soon";
  const boardTag: GuideTag | undefined = flags.boardOpen ? undefined : "Opens soon";

  const places: GuidePlace[] = [
    { name: "Home", text: "Your total, cash and credit. Top up, Trade, Credit Buy and Repay are here." },
    { name: "Invest", text: "Your stocks. Buy them from Market." },
    { name: "Agents", text: "The round lime button. Helpers for your credit and your mix.", tag: agentsTag },
    ...(flags.boardShown
      ? [
          {
            name: "Leaderboard",
            text: "Who grew their own money most, in percent. Greedy Fatalities lives here too.",
            tag: boardTag,
          },
        ]
      : []),
    { name: "Send", text: "Send cash or a stock to a name." },
    { name: "Menu", text: "Top right on every page. Activity, this Guide and Settings." },
  ];

  const money: GuideTask[] = [
    {
      id: "top-up",
      title: "Top up my cash",
      where: ["Home", "Top up"],
      steps: [
        "Copy your name, or show your QR code.",
        "Send USDC to it on Base, from an exchange or another wallet.",
        "It arrives as cash.",
      ],
      note: `${inWords(flags.coins)} work too. When they arrive, tap Turn into cash on Home. Send on Base only, or it can be lost.`,
      link: { label: "Open Top up", href: "/home?topup" },
      icon: "topup",
    },
    {
      id: "earn",
      title: "Make my cash earn",
      where: ["Home", "Start earning"],
      steps: ["When money arrives, Home shows a Start earning card.", "Tap Start earning and approve."],
      note: "The rate is variable. Your cash stays ready to spend. The Yield card shows what it has earned.",
      link: { label: "Open Home", href: "/home" },
      icon: "earn",
    },
  ];

  const stocks: GuideTask[] = [
    {
      id: "buy",
      title: "Buy a stock",
      where: ["Invest", "Market"],
      steps: ["Pick a stock and tap Buy.", "Type the amount in dollars.", "Tap Buy and approve."],
      note: "Stocks follow the share price. They are not company shares. Markets close at the weekend, so prices can jump when they reopen.",
      link: { label: "Open Market", href: "/portfolio?market" },
      icon: "market",
    },
    {
      id: "sell",
      title: "Sell a stock",
      where: ["Invest", "your stock", "Sell"],
      steps: ["Tap a stock you hold, then Sell.", "Type the amount, or tap MAX.", "Tap Sell and approve."],
      note: "The money goes to your cash and starts earning. You can sell free shares only.",
      link: { label: "Open Invest", href: "/portfolio" },
      icon: "sell",
    },
    {
      id: "trade",
      title: "Trade one for another",
      where: ["Home", "Trade"],
      steps: ["Pick what you give and what you get.", "Type the amount.", "Tap the button and approve."],
      note: "Trade cash for a stock, a stock for cash, or one stock for another.",
      link: { label: "Open Home", href: "/home" },
      icon: "trade",
    },
  ];

  const credit: GuideTask[] = [
    {
      id: "credit-buy",
      title: "Buy with credit",
      where: ["Home", "Credit Buy"],
      steps: [
        "Pick the stock that backs it.",
        "Pick the stock to buy.",
        "Type the amount, tap Credit Buy and approve.",
      ],
      note: "You see what it costs a month before you buy. The rate is variable. If your stocks fall too far, part of them can be sold to pay what you owe.",
      link: { label: "Open Home", href: "/home" },
      icon: "credit",
    },
    {
      id: "repay",
      title: "Repay and get my stocks back",
      where: ["Home", "Repay"],
      steps: [
        "Pick what to pay with, cash or a stock.",
        "Type the amount, or tap All.",
        "Tick the stocks to free up, tap the button and approve.",
      ],
      note: "Repay all gives back every stock in the same step.",
      link: { label: "Open Repay", href: "/home?repay" },
      icon: "repay",
    },
    {
      id: "status",
      title: "Check my credit",
      where: ["Home", "the pill under Credit"],
      steps: [],
      statuses: [
        { status: "safe", text: "Nothing to do." },
        { status: "watch", text: "Nothing is sold. You can take less new credit." },
        {
          status: "act",
          text: flags.agentsLive
            ? "Protector steps in at 1.03 if it’s on. You can also repay some yourself."
            : "Repay some. If prices keep falling, part of your stocks can be sold.",
        },
      ],
      note: "Tap ⓘ next to Credit to see how far your stocks can fall.",
      link: { label: "Open Home", href: "/home" },
      icon: "status",
    },
    {
      id: "earn-with-stocks",
      title: "Earn with my stocks",
      where: ["Home", "Cash", "Earn with stocks"],
      steps: [
        "Tap the Cash card, then Earn with stocks.",
        "Pick the stocks that back it and the amount.",
        "Tap Earn with stocks and approve.",
      ],
      note: "It adds credit to your cash, where it earns. It pays off while your cash earns more than the credit costs, and both rates move. To end it, tap Stop earning with stocks.",
      link: { label: "Open Home", href: "/home" },
      icon: "earnStocks",
    },
  ];

  const more: GuideTask[] = [
    {
      id: "send",
      title: "Send cash or a stock",
      where: ["Send"],
      steps: [
        "Pick cash or a stock, and the amount.",
        "Type their name, like sam, or an address.",
        "Tap Send and approve.",
      ],
      note: "A send can’t be undone. You can send free shares only.",
      link: { label: "Open Send", href: "/send" },
      icon: "send",
    },
    {
      id: "agents",
      title: "Let agents watch for me",
      where: ["Agents"],
      steps: [
        "Protector steps in if your credit falls under 1.03. It repays from your cash first, then sells if needed.",
        "Rebalancer keeps your mix on target, once a market day.",
        "You approve each agent. You set Rebalancer’s mix.",
      ],
      note: "You can turn any agent off at any time.",
      tag: agentsTag,
      link: { label: "Open Agents", href: "/agents" },
      icon: "agents",
    },
    {
      id: "activity",
      title: "See what happened",
      where: ["Menu", "Activity"],
      steps: ["Open the menu, top right, and tap Activity.", "Tap a row for the details."],
      note: "Every buy, sale, repay and arrival shows there, by day.",
      link: { label: "Open Activity", href: "/activity" },
      icon: "activity",
    },
    ...(flags.boardShown
      ? [
          {
            id: "leaderboard",
            title: "Climb the leaderboard",
            where: ["Leaderboard"],
            steps: [
              "It ranks everyone by how much they grew their own money, in percent.",
              "A $100 account can beat a $100,000 one, and joining early gives no head start.",
              "Gains made with credit count, and so do losses.",
            ],
            note: "Money you add or take out doesn’t count as a gain. You join with your first move.",
            tag: boardTag,
            link: { label: "Open Leaderboard", href: "/leaderboard" },
            icon: "board" as const,
          },
          {
            id: "fatalities",
            title: "Stay off Greedy Fatalities",
            where: ["Leaderboard", "Greedy Fatalities"],
            steps: [
              "If your stocks fall too far and part of them is sold to pay what you owe, your name goes on Greedy Fatalities.",
              "The boldest go first, ranked by their leverage when it happened.",
              "Everyone who gets there is named. You can’t opt out.",
            ],
            note: "Repay some while your credit is in Act to stay off it.",
            // Its tab isn't built yet (SPEC, Leaderboard): the tag goes when it ships.
            tag: "Opens soon" as const,
            link: { label: "Open Leaderboard", href: "/leaderboard" },
            icon: "fatalities" as const,
          },
        ]
      : []),
    {
      id: "settings",
      title: "See my settings or sign out",
      where: ["Menu", "Settings"],
      steps: ["Open the menu, top right, and tap Settings.", "See your name, your fuel tank and Sign out."],
      link: { label: "Open Settings", href: "/settings" },
      icon: "settings",
    },
  ];

  return {
    intro: [
      { term: "Cash", text: "Your cash earns while it waits." },
      { term: "Stocks", text: "Own Apple, NVIDIA, Tesla and four more." },
      { term: "Credit", text: "Your stocks can back credit, so you can buy more." },
    ],
    approve: "You approve every action with Face ID.",
    places,
    groups: [
      { title: "Money", tasks: money },
      { title: "Stocks", tasks: stocks },
      { title: "Credit", tasks: credit },
      { title: "More", tasks: more },
    ],
    words: [
      { term: "Cash", text: "Your dollars. They earn while they wait." },
      { term: "Fuel tank", text: `${formatUsd(flags.fuelTankUsd)} of your cash, kept for network fees.` },
      { term: "Free shares", text: "Shares you can sell, trade or send." },
      { term: "Backs credit", text: "Shares that back what you owe. They stay yours." },
      { term: "Free up", text: "Take shares out of backing, often after a repay." },
      { term: "Buying power", text: "Your cash plus the credit one Credit Buy can use." },
      { term: "Leverage", text: "Shows while you owe, like 1.7x. What you hold, divided by your own money." },
      { term: "Safe, Watch, Act", text: "How safe your credit is right now." },
    ],
  };
}
