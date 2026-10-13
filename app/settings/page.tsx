"use client";

import { useDisconnect } from "wagmi";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { TabBar } from "@/components/gg/TabBar";
import { Line, WhiteCard } from "@/components/gg/Screen";
import { addressUrl } from "@/lib/chain";
import { shortAddress } from "@/lib/formatting";

export default function SettingsPage() {
  return <RequireAccount>{(address) => <Settings address={address} />}</RequireAccount>;
}

function Settings({ address }: { address: `0x${string}` }) {
  const { disconnect } = useDisconnect();
  return (
    <div className="relative flex min-h-dvh flex-col gap-3.5 px-5 pt-[54px]">
      <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.03em]">Settings</h1>
      <WhiteCard className="px-4 py-0.5">
        <Line first label="Account" value={<a className="underline" href={addressUrl(address)} target="_blank" rel="noreferrer">{shortAddress(address)}</a>} />
        <Line label="Network" value="Base" />
        <Line label="Security" value="Passkey (JAW)" />
        <Line label="Guardian" value={<a href="/guardian" className="underline">Manage</a>} />
      </WhiteCard>
      <WhiteCard className="p-4 text-[13px] leading-snug text-muted">
        GreedyGoose is a non-custodial interface. Your stocks and USDC stay in your own smart account. Loans come from the Aave
        protocol; if your collateral value falls too far, Aave can sell part of it. Tokenized stocks track the share price; they
        are not company shares and carry no voting rights. Not available to US persons.
      </WhiteCard>
      <button type="button" onClick={() => disconnect()} className="h-[52px] rounded-[26px] bg-chip text-[15px] font-semibold">
        Sign out
      </button>
      <TabBar />
    </div>
  );
}
