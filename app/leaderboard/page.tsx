import { notFound } from "next/navigation";
import { LEADERBOARD_ENABLED } from "@/lib/features";
import { Leaderboard } from "./Leaderboard";

/** The Leaderboard tab (D16, formerly Friends), behind NEXT_PUBLIC_LEADERBOARD. A 404 when it's off. */
export default function LeaderboardPage() {
  if (!LEADERBOARD_ENABLED) notFound();
  return <Leaderboard />;
}
