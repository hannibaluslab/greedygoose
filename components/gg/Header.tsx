"use client";

import { MenuButton } from "./MenuButton";
import { useAccountName } from "@/hooks/useAccountName";
import { firstName } from "@/lib/jaw/name";
import { shortAddress } from "@/lib/formatting";

/**
 * "Hi, Sam / sam.justan.id" header from the design (HomeUpliftRail), with the account's JAW name. Without a name
 * it says "Hi there" over the short address; while the name loads, two quiet bars hold its place.
 */
export function Header({ address }: { address: `0x${string}` }) {
  const { data: name, isPending } = useAccountName(address);
  const initial = name ? name.charAt(0).toUpperCase() : "G";
  return (
    <header className="flex items-center justify-between px-5 pt-[54px]">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex size-9 items-center justify-center rounded-[18px] bg-ink text-sm font-semibold text-on-ink">
          {isPending ? "" : initial}
        </span>
        {isPending ? (
          <div aria-busy className="flex flex-col gap-1.5">
            <span className="h-[15px] w-16 animate-pulse rounded bg-chip" />
            <span className="h-3 w-24 animate-pulse rounded bg-chip" />
          </div>
        ) : (
          <div className="flex flex-col leading-[1.3]">
            <span className="text-[15px] font-medium">{name ? `Hi, ${firstName(name)}` : "Hi there"}</span>
            <span className="num text-xs text-subtle">{name ?? shortAddress(address)}</span>
          </div>
        )}
      </div>
      <MenuButton />
    </header>
  );
}
