"use client";

import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { TabHeader, WhiteCard } from "@/components/gg/Screen";
import { FriendsIcon } from "@/components/gg/icons";

/** Placeholder until friends are ranked from chain data (plan M8). No sample leaderboard. */
export function Friends() {
  return (
    <RequireAccount>
      {() => (
        <div className="relative flex min-h-dvh flex-col gap-4 px-5 pt-[54px]">
          <TabHeader title="Friends" />
          <WhiteCard className="flex flex-col gap-3 p-[18px]">
            <div className="flex items-center gap-3">
              <span aria-hidden className="flex size-[42px] shrink-0 items-center justify-center rounded-[21px] bg-chip text-ink">
                <FriendsIcon />
              </span>
              <span className="flex-1 text-[17px] font-semibold">See how you rank</span>
              <span className="inline-flex h-6 shrink-0 items-center rounded-[12px] bg-chip px-2.5 text-xs font-bold text-ink-mid">Coming soon</span>
            </div>
            <p className="m-0 text-[14px] leading-snug text-ink-mid">
              Compare returns with the friends you follow, in percent only, never dollars.
            </p>
          </WhiteCard>
          <TabBar />
        </div>
      )}
    </RequireAccount>
  );
}
