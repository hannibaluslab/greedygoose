import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CashGallery } from "./CashGallery";

/** Dev-only: earning and other dollars becoming cash in each state, with fixtures (see CashGallery). A 404 in production builds. */
export default function DevCashPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <CashGallery />
    </Suspense>
  );
}
