"use client";

import { useDisconnect } from "wagmi";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { Line, TabHeader, WhiteCard } from "@/components/gg/Screen";
import { CASH } from "@/config/risk";
import { useAccountName } from "@/hooks/useAccountName";
import { usePosition } from "@/hooks/usePosition";
import { addressUrl } from "@/lib/chain";
import { formatUsd, shortAddress } from "@/lib/formatting";

export default function SettingsPage() {
  return <RequireAccount>{(address) => <Settings address={address} />}</RequireAccount>;
}

/**
 * Settings: the account, its name first and the address under it (ruling 36); the fuel tank, the cash kept back for
 * network fees (rulings 7, 37); the network and the passkey; what GreedyGoose is; Sign out.
 */
function Settings({ address }: { address: `0x${string}` }) {
  const { disconnect } = useDisconnect();
  const { data: name } = useAccountName(address);
  const { data } = usePosition(address);
  const tank = CASH.feeBufferUsd;
  // In whole cents, rounded down: a tank a fraction of a cent short never reads "full".
  const fuel = data ? Math.min(Math.floor(data.cashUsd * 100 + 1e-6), Math.round(tank * 100)) / 100 : null;
  const link = (
    <a className="underline" href={addressUrl(address)} target="_blank" rel="noreferrer">
      {shortAddress(address)}
    </a>
  );
  return (
    <div className="flex min-h-dvh flex-col gap-3.5 px-5 pb-[34px] pt-[calc(env(safe-area-inset-top)+8px)]">
      <TabHeader title="Settings" back="/home" />
      <WhiteCard className="px-4 py-0.5">
        <Line
          first
          label="Account"
          value={
            name ? (
              <span className="flex flex-col items-end gap-0.5">
                <span>{name}</span>
                <span className="text-xs font-normal text-subtle">{link}</span>
              </span>
            ) : (
              link
            )
          }
        />
        <Line label="Network" value="Base" />
        <Line label="Security" value="Passkey" />
      </WhiteCard>
      <WhiteCard className="flex flex-col px-4 pb-3.5 pt-0.5">
        <Line
          first
          label="Fuel tank"
          value={
            fuel === null
              ? "…"
              : fuel >= tank
                ? `${formatUsd(tank)} · full`
                : `${formatUsd(fuel)} of ${formatUsd(tank)}`
          }
        />
        <p className="m-0 text-[13px] leading-snug text-ink-mid">
          {formatUsd(tank)} of your cash stays here for network fees. Whatever you spend from your cash leaves it in
          place.
        </p>
      </WhiteCard>
      <WhiteCard className="p-4 text-[13px] leading-snug text-ink-mid">
        GreedyGoose is a non-custodial interface. Your stocks and USDC stay in your own smart account. Credit comes from
        the Aave protocol; if the stocks backing it fall too far in value, Aave can sell part of them. Not available to
        US persons.
      </WhiteCard>
      <button
        type="button"
        onClick={() => disconnect()}
        className="h-[52px] rounded-[26px] bg-chip text-[15px] font-semibold"
      >
        Sign out
      </button>
    </div>
  );
}
