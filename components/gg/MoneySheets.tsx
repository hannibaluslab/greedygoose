"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { TopUpSheet } from "./AddMoney";
import { RepaySheet } from "./RepaySheet";
import { useSheetSubject } from "@/hooks/useSheetSubject";

/** The two money sheets every signed-in page can open over itself (Adrian: "top up and repay should open a sheet"). */
export type MoneySheet = "top-up" | "repay";

/** The query that opens each sheet as a page loads: `/receive` and `/repay` redirect to it (next.config.ts). */
const PARAM: Record<MoneySheet, string> = { "top-up": "topup", repay: "repay" };
/** Where each sheet's old page was, for a component drawn outside the host (the dev gallery): it redirects back here. */
const ROUTE: Record<MoneySheet, string> = { "top-up": "/receive", repay: "/repay" };

const OpenSheet = createContext<((sheet: MoneySheet) => void) | null>(null);

/**
 * Opens Top up or Repay over the page. Called from inside another sheet, close that one first: one sheet slides out
 * as the next slides in, as the stock sheets do. Outside the host it goes to the old route, which redirects to Home with
 * the sheet open.
 */
export function useMoneySheets() {
  const open = useContext(OpenSheet);
  const router = useRouter();
  const go = (sheet: MoneySheet) => (open ? open(sheet) : router.push(ROUTE[sheet]));
  return {
    topUp: () => go("top-up"),
    repay: () => go("repay"),
  };
}

/** The sheet a link asked for (`?topup`, `?repay`). */
function linked(): MoneySheet | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  return q.has(PARAM["top-up"]) ? "top-up" : q.has(PARAM.repay) ? "repay" : null;
}

/**
 * The host for Top up and Repay on a signed-in page (RequireAccount mounts it). Each sheet mounts only while it's open
 * or sliding away (useSheetSubject), so a page reads nothing for them until one opens, and Repay prepares its batch
 * only while its sheet is open.
 */
export function MoneySheets({ address, children }: { address: `0x${string}`; children: ReactNode }) {
  const [initial] = useState(linked);
  const topUp = useSheetSubject<true>(initial === "top-up" ? true : null);
  const repay = useSheetSubject<true>(initial === "repay" ? true : null);

  // The query that opened a sheet goes once it has: a reload or Back doesn't open it again. The rest of the query stays.
  useEffect(() => {
    const url = new URL(window.location.href);
    const params = Object.values(PARAM).filter((p) => url.searchParams.has(p));
    if (params.length === 0) return;
    for (const p of params) url.searchParams.delete(p);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const open = (sheet: MoneySheet) => {
    if (sheet === "top-up") {
      repay.close();
      topUp.show(true);
    } else {
      topUp.close();
      repay.show(true);
    }
  };

  return (
    <OpenSheet.Provider value={open}>
      {children}
      {topUp.subject && <TopUpSheet key={`topUp${topUp.key}`} open={topUp.open} address={address} onClose={topUp.close} />}
      {repay.subject && (
        <RepaySheet
          key={`repay${repay.key}`}
          open={repay.open}
          address={address}
          onClose={repay.close}
          onTopUp={() => open("top-up")}
        />
      )}
    </OpenSheet.Provider>
  );
}
