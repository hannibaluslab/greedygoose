"use client";

import { RequireAccount } from "@/components/wallet/RequireAccount";
import { AgentsFeed } from "@/components/gg/Agents";
import { TabBar } from "@/components/gg/TabBar";
import { TabHeader } from "@/components/gg/Screen";
import { useAccountFeed } from "@/hooks/useAccountFeed";
import { useAgentFeed } from "@/hooks/useAgentFeed";
import { useNowSec } from "@/hooks/useNowSec";

export default function ActivityPage() {
  return <RequireAccount>{(address) => <Activity address={address} />}</RequireAccount>;
}

/**
 * Everything that happened in the account, by day, as the Agents board draws its activity: the user's own moves, the
 * agents', and the cash's own events (D20: "$40 added to your cash", "120 USDT arrived as $119.83 cash"), each with its
 * details and its transaction on Base.
 */
function Activity({ address }: { address: `0x${string}` }) {
  const all = useAccountFeed(address, useAgentFeed(address));
  const nowSec = useNowSec();
  return (
    <div className="relative flex min-h-dvh flex-col gap-4 px-5 pt-[54px]">
      <TabHeader title="Activity" />
      <AgentsFeed
        title={null}
        empty="Nothing yet. Buys, backing, credit and repayments made in GreedyGoose show up here, and so does money arriving in your cash."
        nowMs={nowSec * 1000}
        {...all}
      />
      <TabBar />
    </div>
  );
}
