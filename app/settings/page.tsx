"use client";

import { isAddressEqual } from "viem";
import { useAccount, useDisconnect } from "wagmi";
import { RequireAccount } from "@/components/wallet/RequireAccount";
import { Line, TabHeader, WhiteCard } from "@/components/gg/Screen";
import { CASH } from "@/config/risk";
import { TxButton, TxError } from "@/components/gg/TxUi";
import { useFillTank } from "@/hooks/useFillTank";
import { tankLevelUsd } from "@/lib/fuelTank";
import { useAccountName } from "@/hooks/useAccountName";
import { usePosition } from "@/hooks/usePosition";
import { addressUrl } from "@/lib/chain";
import { formatUsd, shortAddress } from "@/lib/formatting";

export default function SettingsPage() {
  return <RequireAccount>{(address) => <Settings address={address} />}</RequireAccount>;
}

/**
 * Settings: the account, its name first and the address under it (ruling 36); the fuel tank, the wallet cash network
 * fees are paid from (rulings 7, 37), and "Fill up" from savings while it isn't full (Adrian, 2026-10-20); the network
 * and the passkey; what GreedyGoose is; Sign out.
 */
function Settings({ address }: { address: `0x${string}` }) {
  const { disconnect } = useDisconnect();
  const { address: signer } = useAccount();
  const { data: name } = useAccountName(address);
  const { data } = usePosition(address);
  const tank = CASH.feeBufferUsd;
  const fuel = data ? tankLevelUsd(data.cash.walletRaw) : null;
  const fill = useFillTank(address, data?.cash, true);
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
          {formatUsd(tank)} of your cash stays here for network fees. Spending from your cash leaves it full.
        </p>
        {fill.canFill && (
          <div className="mt-3 flex flex-col gap-2">
            <TxError error={fill.error} />
            <TxButton
              label="Fill up"
              size="md"
              phase={fill.phase}
              checking={fill.checking}
              disabled={fill.blocked}
              preview={!signer || !isAddressEqual(signer, address)}
              onClick={fill.fill}
            />
          </div>
        )}
      </WhiteCard>
      <WhiteCard className="p-4 text-[13px] leading-snug text-ink-mid">
        GreedyGoose is a non-custodial interface. Your stocks and cash stay in your own smart account. Credit comes from
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
