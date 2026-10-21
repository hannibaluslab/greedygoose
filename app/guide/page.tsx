import { TabHeader } from "@/components/gg/Screen";
import { GuideView } from "@/components/gg/guide/Guide";
import { guideContent } from "@/lib/guide/content";

/**
 * The Guide, from the menu: what you can do in GreedyGoo, where it is, and how. Readable signed in or out. No tab
 * bar, and the header stays on top while it scrolls, so the way back is always one tap away.
 */
export default function GuidePage() {
  return (
    <div className="flex min-h-dvh flex-col gap-3.5 px-5 pb-[34px]">
      <TabHeader title="Guide" back="/home" />
      <GuideView guide={guideContent()} />
    </div>
  );
}
