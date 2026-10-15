/**
 * The Leaderboard tab (D16's fourth tab; it was Friends until 2026-10-15). NEXT_PUBLIC_LEADERBOARD=off hides the tab
 * and makes /leaderboard a 404; the old NEXT_PUBLIC_FRIENDS=off does the same, so existing configs keep working.
 */
export const LEADERBOARD_ENABLED = process.env.NEXT_PUBLIC_LEADERBOARD !== "off" && process.env.NEXT_PUBLIC_FRIENDS !== "off";
