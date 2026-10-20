import { Suspense } from "react";
import { notFound } from "next/navigation";
import { RebalanceSheets } from "./RebalanceSheets";

/** Dev-only: every state of Rebalance's sheet, with fixtures (see RebalanceSheets). A 404 in production builds. */
export default function DevRebalanceSheetPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <RebalanceSheets />
    </Suspense>
  );
}
