/**
 * Friends (D16 tab) is a placeholder until rankings come from chain data (plan M8): no data and no
 * sample leaderboard. NEXT_PUBLIC_FRIENDS=off hides the tab and makes /friends a 404.
 */
export const FRIENDS_ENABLED = process.env.NEXT_PUBLIC_FRIENDS !== "off";
