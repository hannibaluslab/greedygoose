import { TabHeader, WhiteCard } from "@/components/gg/Screen";
import { ComingSoon } from "@/components/gg/Agents";

/** The Guide, from the menu: how GreedyGoose works, step by step. A placeholder until its content is written. */
export default function GuidePage() {
  return (
    <div className="flex min-h-dvh flex-col gap-3.5 px-5 pb-[34px] pt-[calc(env(safe-area-inset-top)+8px)]">
      <TabHeader title="Guide" back="/home" />
      <WhiteCard className="flex flex-col items-start gap-2 px-4 py-4 leading-[normal]">
        <ComingSoon />
        <p className="m-0 text-[15px] leading-[1.4] text-ink-2">
          How cash, stocks and credit work in GreedyGoose, step by step.
        </p>
      </WhiteCard>
    </div>
  );
}
