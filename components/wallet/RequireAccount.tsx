"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { isAddress } from "viem";
import { useAccount, useSwitchChain } from "wagmi";
import { MoneySheets } from "@/components/gg/cash/MoneySheets";
import { CHAIN } from "@/lib/chain";

const noopSubscribe = () => () => {};

/**
 * Dev-only read-only preview: `?as=0x…` renders any address's real on-chain
 * position without signing in. Compiled out of production builds; never signs.
 */
function devPreviewAddress(): `0x${string}` | null {
  if (process.env.NODE_ENV === "production") return null;
  const as = new URLSearchParams(window.location.search).get("as");
  if (as && isAddress(as)) {
    try {
      sessionStorage.setItem("gg.dev.as", as);
    } catch {}
    return as;
  }
  try {
    const saved = sessionStorage.getItem("gg.dev.as");
    return saved && isAddress(saved) ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Gate for signed-in screens: handles disconnected, reconnecting and wrong-chain states. A signed-in screen gets the
 * Top up and Repay sheets (MoneySheets).
 */
export function RequireAccount({ children }: { children: (address: `0x${string}`) => ReactNode }) {
  const preview = useSyncExternalStore(noopSubscribe, devPreviewAddress, () => null);
  // Wallet state only exists in the browser; render nothing until hydrated so server and client match.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const { address, status, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const router = useRouter();

  useEffect(() => {
    // Read the preview directly: on the first client render the store still returns the server snapshot.
    if (status === "disconnected" && !devPreviewAddress()) router.replace("/");
  }, [status, router]);

  if (!hydrated) return <ShellSkeleton />;
  if (preview) return <SignedIn address={preview}>{children}</SignedIn>;

  if (status === "connecting" || status === "reconnecting") return <ShellSkeleton label="Signing you in…" />;
  if (!address) return <ShellSkeleton />;
  if (chainId !== CHAIN.id) {
    return (
      <div className="flex flex-col gap-4 px-5 pt-[calc(env(safe-area-inset-top)+8px)]">
        <p className="m-0 text-[15px]">GreedyGoo runs on Base.</p>
        <button
          type="button"
          onClick={() => switchChain({ chainId: CHAIN.id })}
          disabled={isPending}
          className="h-14 rounded-[28px] bg-ink font-semibold text-on-ink disabled:opacity-60"
        >
          {isPending ? "Switching…" : "Switch to Base"}
        </button>
      </div>
    );
  }
  return <SignedIn address={address}>{children}</SignedIn>;
}

/** A signed-in page, with Top up and Repay ready to open over it from anywhere on it (MoneySheets). */
function SignedIn({ address, children }: { address: `0x${string}`; children: (address: `0x${string}`) => ReactNode }) {
  return (
    <div className="gg-page">
      <MoneySheets address={address}>{children(address)}</MoneySheets>
    </div>
  );
}

/** Shown while the wallet state loads, so screens never flash blank. */
function ShellSkeleton({ label = "Loading…" }: { label?: string }) {
  return (
    <div aria-busy className="flex flex-col gap-4 px-5 pt-[calc(env(safe-area-inset-top)+8px)]">
      <span className="sr-only" role="status">
        {label}
      </span>
      <div className="flex items-center gap-2.5">
        <div className="size-9 animate-pulse rounded-full bg-chip" />
        <div className="h-4 w-28 animate-pulse rounded bg-chip" />
      </div>
      <div className="h-[92px] animate-pulse rounded-[22px] bg-chip" />
      <div className="grid grid-cols-2 gap-2.5">
        <div className="h-[108px] animate-pulse rounded-[22px] bg-chip" />
        <div className="h-[108px] animate-pulse rounded-[22px] bg-chip" />
      </div>
      <div className="h-[170px] animate-pulse rounded-[22px] bg-chip" />
    </div>
  );
}
