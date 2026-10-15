"use client";

import { toast } from "sonner";
import { SendDone, SendHeader } from "@/components/gg/Send";
import { TabBar } from "@/components/gg/TabBar";
import { SEND_COPY } from "@/lib/send";

/**
 * Send's done state with a fixture: what the tab shows once the batch lands. Nothing here reads the chain, so there is
 * no transaction and no "View on Base explorer" link, which the real state has.
 */
export function SendDoneDemo() {
  return (
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 pt-[calc(env(safe-area-inset-top)+8px)] leading-[normal]">
      <SendHeader />
      <SendDone
        title={SEND_COPY.sent("$25.00", "extenso.justan.id")}
        onDone={() => toast("Dev gallery: back to a fresh Send")}
      />
      <TabBar />
    </div>
  );
}
