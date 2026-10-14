"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Toaster } from "sonner";
import { REHEARSAL, wagmiConfig } from "@/lib/jaw/config";

/** The canvas toast: a dark pill under the status bar, success marked by a lime tick. */
const TOAST_OFFSET = { top: "calc(env(safe-area-inset-top) + 6px)", left: 20, right: 20 };

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
        {REHEARSAL && <REHEARSAL.Badge />}
        <Toaster
          position="top-center"
          offset={TOAST_OFFSET}
          mobileOffset={TOAST_OFFSET}
          icons={{
            success: (
              <span className="grid size-[26px] place-items-center rounded-full bg-brand text-ink">
                <Check size={14} strokeWidth={3} />
              </span>
            ),
          }}
          toastOptions={{
            unstyled: true,
            classNames: {
              // font-sans: sonner puts a system font on its toaster; the boards' toast is in Geist.
              toast:
                "flex min-h-[42px] w-full items-center gap-2.5 rounded-[21px] bg-ink px-4 py-2 font-sans text-[14px] font-semibold text-on-ink shadow-toast has-[[data-icon]]:pl-2.5",
              icon: "shrink-0",
              description: "text-[12.5px] font-normal text-ink-on-dark-dim",
            },
          }}
        />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
