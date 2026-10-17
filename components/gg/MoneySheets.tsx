"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { TopUpSheet } from "./AddMoney";
import { RepaySheet } from "@/components/repay/RepaySheet";
import { useSheetSubject } from "@/hooks/useSheetSubject";

/** The two money sheets every signed-in page can open over itself (Adrian: "top up and repay should open a sheet"). */
type MoneySheet = "top-up" | "repay";

/** The query that opens each sheet as a page loads: `/receive` and `/repay` redirect to it (next.config.ts). */
const PARAM: Record<MoneySheet, string> = { "top-up": "topup", repay: "repay" };
/** Where each sheet's old page was, for a component drawn outside the host (the dev gallery): it redirects back here. */
const ROUTE: Record<MoneySheet, string> = { "top-up": "/receive", repay: "/repay" };

const OpenSheet = createContext<((sheet: MoneySheet, free?: string) => void) | null>(null);

/**
 * Opens Top up or Repay over the page. Called from inside another sheet, close that one first: one sheet slides out
 * as the next slides in, as the stock sheets do. Outside the host it goes to the old route, which redirects to Home with
 * the sheet open.
 */
export function useMoneySheets() {
  const open = useContext(OpenSheet);
  const router = useRouter();
  const go = (sheet: MoneySheet, free?: string) =>
    open ? open(sheet, free) : router.push(free ? `/home?repay=${encodeURIComponent(free)}` : ROUTE[sheet]);
  return {
    topUp: () => go("top-up"),
    /** The Repay sheet; with a stock, open on "free up" with that stock ticked (its stock sheet's Free up shares). */
    repay: (free?: string) => go("repay", typeof free === "string" ? free : undefined),
  };
}

/** The sheet a link asked for (`?topup`, `?repay`). */
function linked(): { sheet: MoneySheet; free?: string } | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  if (q.has(PARAM["top-up"])) return { sheet: "top-up" };
  return q.has(PARAM.repay) ? { sheet: "repay", free: q.get(PARAM.repay) || undefined } : null;
}

/**
 * The host for Top up and Repay on a signed-in page (RequireAccount mounts it). Each sheet mounts only while it's open
 * or sliding away (useSheetSubject), so a page reads nothing for them until one opens, and Repay prepares its batch
 * only while its sheet is open.
 */
export function MoneySheets({ address, children }: { address: `0x${string}`; children: ReactNode }) {
  const [initial] = useState(linked);
  const topUp = useSheetSubject<true>(initial?.sheet === "top-up" ? true : null);
  const repay = useSheetSubject<{ free?: string }>(initial?.sheet === "repay" ? { free: initial.free } : null);

  // The query that opened a sheet goes once it has: a reload or Back doesn't open it again. The rest of the query stays.
  useEffect(() => {
    const url = new URL(window.location.href);
    const params = Object.values(PARAM).filter((p) => url.searchParams.has(p));
    if (params.length === 0) return;
    for (const p of params) url.searchParams.delete(p);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const open = (sheet: MoneySheet, free?: string) => {
    if (sheet === "top-up") {
      repay.close();
      topUp.show(true);
    } else {
      topUp.close();
      repay.show({ free });
    }
  };

  return (
    <OpenSheet.Provider value={open}>
      {children}
      {topUp.subject && (
        <TopUpSheet key={`topUp${topUp.key}`} open={topUp.open} address={address} onClose={topUp.close} />
      )}
      {repay.subject && (
        <RepaySheet
          key={`repay${repay.key}`}
          open={repay.open}
          address={address}
          onClose={repay.close}
          onTopUp={() => open("top-up")}
          freeUp={repay.subject.free}
        />
      )}
    </OpenSheet.Provider>
  );
}
