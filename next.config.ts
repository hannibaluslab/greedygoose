import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev only: lets the dev server be opened by the VM's public IP.
  allowedDevOrigins: ["141.148.209.77"],
  // The floating dev badge overlaps the tab bar while testing on a phone.
  devIndicators: false,
  cacheComponents: true,
  // Renamed routes (D17: no "borrow", "lock" or "unlock" on screen). Old links keep working, query included.
  // Temporary (307), so browsers don't cache them while route names can still change.
  redirects: async () => [
    { source: "/loan", destination: "/use-credit", permanent: false },
    { source: "/borrow", destination: "/use-credit", permanent: false },
    { source: "/collateral", destination: "/use-credit", permanent: false },
    { source: "/unlock", destination: "/free-up", permanent: false },
    // The Market is a sheet on Invest (F1-3): /buy opens it, and /buy?s=NVDAc opens that stock's Buy step.
    { source: "/buy", destination: "/portfolio?market", permanent: false },
    // Manage is gone: each agent's settings live in its sheet on the Agents tab.
    { source: "/manage", destination: "/agents?agent=rebalance", permanent: false },
    { source: "/manage/credit", destination: "/agents?agent=protect", permanent: false },
    // Sign-up's "Finish setting up" step is gone: Home asks to start earning once money is in.
    { source: "/setup", destination: "/home", permanent: false },
    // Guardian's savings page is gone: Protect repays from the cash, which is one pot on screen (D20).
    { source: "/guardian", destination: "/agents?agent=protect", permanent: false },
    // Friends became the Leaderboard: one board, filtered to All or Contacts.
    { source: "/friends", destination: "/leaderboard?filter=contacts", permanent: false },
    // Pay became Send.
    { source: "/pay", destination: "/send", permanent: false },
    // Top up (Receive) and Repay are sheets over the page they open from (components/gg/MoneySheets.tsx): their old
    // pages open them over Home, or over Send for Send's old Receive link.
    { source: "/receive", has: [{ type: "query", key: "from", value: "send" }], destination: "/send?topup", permanent: false },
    { source: "/receive", destination: "/home?topup", permanent: false },
    { source: "/repay", destination: "/home?repay", permanent: false },
  ],
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
