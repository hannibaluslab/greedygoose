import { Suspense } from "react";
import { notFound } from "next/navigation";
import { RebalanceCards } from "./RebalanceCards";

/** Dev-only: every state of Rebalance's overview card, with fixtures (see RebalanceCards). A 404 in production builds. */
export default function DevRebalanceCardsPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <RebalanceCards />
    </Suspense>
  );
}
