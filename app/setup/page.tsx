"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { FinishSetupStep } from "@/components/gg/CashSetup";
import { useCashSetup } from "@/hooks/useCashSetup";
import { usePosition } from "@/hooks/usePosition";
import { aprToApy } from "@/lib/aave/math";
import { finishSetupShown, rateText } from "@/lib/cashSetup";

export default function SetupPage() {
  return <RequireAccount>{(address) => <Setup address={address} />}</RequireAccount>;
}

/**
 * The sign-up's last step (D20), right after a new account connects: "Finish setting up", your cash starts earning at
 * the live rate, one Face ID (the Save grant on JAW's own screen), or "Later" and Home shows a small card instead. An
 * account that already earns, or an app with no executor configured, goes straight Home.
 */
function Setup({ address }: { address: `0x${string}` }) {
  const router = useRouter();
  const setup = useCashSetup(address);
  const { data } = usePosition(address);
  const rate = data ? rateText(aprToApy(data.savingsApr)) : null;
  const settled = setup.save !== "loading";
  const needed = finishSetupShown(setup.save);

  // Home asks again with its small card once the registry can be read, so a read that fails doesn't hold sign-up here.
  const leave = (settled && !needed && !setup.earning.busy) || (!settled && setup.unreadable);
  useEffect(() => {
    if (leave) router.replace("/home");
  }, [leave, router]);

  if (!needed) return <div aria-busy className="min-h-dvh" />;
  return (
    <FinishSetupStep
      rate={rate}
      grant={setup.earning}
      onStart={() =>
        setup.startEarning(() => {
          if (rate) toast.success(`Your cash is earning ${rate}`);
          router.replace("/home");
        })
      }
      onLater={() => router.replace("/home")}
    />
  );
}
