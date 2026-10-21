"use client";

import type { ReactNode } from "react";
import { toast } from "sonner";
import { GooseMark } from "../kit/GooseMark";
import { MenuButton, type MenuExtra } from "../MenuButton";
import { useAccountName } from "@/hooks/useAccountName";
import { firstName } from "@/lib/jaw/name";
import { shortAddress } from "@/lib/formatting";

/**
 * "Hi, Sam / sam.justan.id" header from the design (HomeUpliftRail), with the account's JAW name. Without a name
 * it says "Hi there" over the short address; while the name loads, two quiet bars hold its place. The round mark
 * is the GreedyGoo logo on ink (Adrian, 2026-10-14), not the name's initial. A tap on the name copies it
 * ("sam.justan.id"), or the address when there's no name, and a toast says so.
 */
export function Header({ address, aside, menu }: { address: `0x${string}`; aside?: ReactNode; menu?: MenuExtra }) {
  const { data: name, isPending } = useAccountName(address);
  return (
    <header className="flex items-center justify-between px-5 pt-[calc(env(safe-area-inset-top)+4px)]">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex size-9 items-center justify-center rounded-[18px] bg-ink">
          <GooseMark className="h-[28px] w-auto" />
        </span>
        {isPending ? (
          <div aria-busy className="flex flex-col gap-1.5">
            <span className="h-[15px] w-16 animate-pulse rounded bg-chip" />
            <span className="h-3 w-24 animate-pulse rounded bg-chip" />
          </div>
        ) : (
          <button
            type="button"
            aria-label={`Copy ${name ?? "your address"}`}
            onClick={() => void copy(name ?? address, name ? "Name copied" : "Address copied")}
            className="flex flex-col text-left leading-[1.3] touch:active:opacity-60"
          >
            <span className="text-[15px] font-medium">{name ? `Hi, ${firstName(name)}` : "Hi there"}</span>
            <span className="num text-xs text-subtle">{name ?? shortAddress(address)}</span>
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {aside}
        <MenuButton extra={menu} />
      </div>
    </header>
  );
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast("Couldn’t copy right now.");
  }
}
