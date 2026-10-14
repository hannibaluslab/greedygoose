import { MenuButton } from "./MenuButton";
import { shortAddress } from "@/lib/formatting";

/** "Hi, Sam / sam.justan.id" header from the design. Name shows once JAW subname lookup is wired. */
export function Header({ address, name }: { address: `0x${string}`; name?: string }) {
  const initial = (name ?? "").slice(0, 1).toUpperCase() || "G";
  return (
    <header className="flex items-center justify-between px-5 pt-[54px]">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex size-9 items-center justify-center rounded-[18px] bg-ink text-sm font-semibold text-on-ink">
          {initial}
        </span>
        <div className="flex flex-col leading-[1.3]">
          <span className="text-[15px] font-medium">{name ? `Hi, ${name.split(".")[0]}` : "Hi there"}</span>
          <span className="num text-xs text-subtle">{name ?? shortAddress(address)}</span>
        </div>
      </div>
      <MenuButton />
    </header>
  );
}
