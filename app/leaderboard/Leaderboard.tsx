"use client";

import { RequireAccount } from "@/components/wallet/RequireAccount";
import { LeaderboardScreen } from "@/components/gg/leaderboard/LeaderboardScreen";

export function Leaderboard() {
  return <RequireAccount>{(address) => <LeaderboardScreen address={address} />}</RequireAccount>;
}
