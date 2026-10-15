"use client";

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { AddMoneyView } from "@/components/gg/AddMoney";
import { TurnIntoCash } from "@/components/gg/CashSetup";
import { useAccountName } from "@/hooks/useAccountName";
import { useCashSetup } from "@/hooks/useCashSetup";
import { useEntryBalances } from "@/hooks/useEntryBalances";
import { usePosition } from "@/hooks/usePosition";
import { aprToApy } from "@/lib/aave/math";
import { arrivedCoins, arrivedView, rateText } from "@/lib/cashSetup";

const noopSubscribe = () => () => {};
/** Back goes to Send when Receive opened from there (`?from=send`), else Home, as before. */
const backTo = () => (new URLSearchParams(window.location.search).get("from") === "send" ? "/send" : "/home");

export default function ReceivePage() {
  return <RequireAccount>{(address) => <AddMoney address={address} />}</RequireAccount>;
}

/**
 * Receive (AddMoneyView), with "Turn into cash" for other dollars nothing converts on its own, as on Home (D20). It was
 * the Pay tab; since Send replaced Pay (2026-10-15) it opens from Send's header and from Home's Top up.
 */
function AddMoney({ address }: { address: `0x${string}` }) {
  const back = useSyncExternalStore(noopSubscribe, backTo, () => "/home");
  const { data } = usePosition(address);
  const { data: name } = useAccountName(address);
  const setup = useCashSetup(address);
  const arrived = arrivedView(arrivedCoins(useEntryBalances(address)), setup.entry);
  const earning = setup.save === "on" || setup.save === "starting";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      toast("Address copied");
    } catch {
      toast("Couldn’t copy. Press and hold the address instead.");
    }
  };

  return (
    <AddMoneyView
      address={address}
      name={name ?? null}
      rate={earning && data ? rateText(aprToApy(data.savingsApr)) : null}
      arrived={<TurnIntoCash user={address} view={arrived} setup={setup} />}
      onCopy={() => void copy()}
      back={back}
    />
  );
}
