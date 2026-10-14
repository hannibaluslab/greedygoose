"use client";

import { useState } from "react";
import { toast } from "sonner";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { AddMoneyView } from "@/components/gg/AddMoney";
import { ArrivedCard, ConvertSheet } from "@/components/gg/CashSetup";
import { useAccountName } from "@/hooks/useAccountName";
import { useCashSetup } from "@/hooks/useCashSetup";
import { useEntryBalances } from "@/hooks/useEntryBalances";
import { usePosition } from "@/hooks/usePosition";
import { aprToApy } from "@/lib/aave/math";
import { arrivedCoins, arrivedView, rateText, type Arrived } from "@/lib/cashSetup";

export default function ReceivePage() {
  return <RequireAccount>{(address) => <AddMoney address={address} />}</RequireAccount>;
}

/** The Pay tab (AddMoneyView), with "Turn into cash" for other dollars nothing converts on its own, as on Home (D20). */
function AddMoney({ address }: { address: `0x${string}` }) {
  const { data } = usePosition(address);
  const { data: name } = useAccountName(address);
  const setup = useCashSetup(address);
  const arrived = arrivedView(arrivedCoins(useEntryBalances(address)), setup.entry);
  const [converting, setConverting] = useState<{ coins: Arrived[]; open: boolean; key: number } | null>(null);
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
    <>
      <AddMoneyView
        address={address}
        name={name ?? null}
        rate={earning && data ? rateText(aprToApy(data.savingsApr)) : null}
        arrived={arrived.kind === "ask" && <ArrivedCard text={arrived.text} onConvert={() => setConverting({ coins: arrived.coins, open: true, key: Date.now() })} />}
        onCopy={() => void copy()}
      />
      {converting && (
        <ConvertSheet
          key={converting.key}
          open={converting.open}
          onClose={() => setConverting({ ...converting, open: false })}
          user={address}
          coins={converting.coins}
          setup={setup}
        />
      )}
    </>
  );
}
