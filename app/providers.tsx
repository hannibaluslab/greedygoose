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
          // One at a time: a new toast replaces the one showing. Sonner's stack slid the dark pills under each other,
          // with the older one's words showing through.
          visibleToasts={1}
          // On a phone sonner makes the toaster 100% wide from the left offset, so it runs past the right edge and a
          // toast centred in it sits off to the right: auto width keeps it between the two offsets.
          className="max-[600px]:!w-auto"
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
              // font-sans: sonner puts a system font on its toaster; the boards' toast is in Geist. As wide as its words
              // (Adrian, 2026-10-21: a short one sat in a mostly empty pill), centred, up to the full width.
              toast:
                "gg-toast-beam inset-x-0 mx-auto flex !w-fit max-w-full min-h-[42px] items-center gap-2.5 rounded-[21px] bg-ink px-4 py-2 font-sans text-[14px] font-semibold text-on-ink shadow-toast has-[[data-icon]]:pl-2.5",
              icon: "shrink-0",
              description: "text-[12.5px] font-normal text-ink-on-dark-dim",
            },
          }}
        />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
