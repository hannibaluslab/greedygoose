import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AgentsBoard } from "./AgentsBoard";

/** Dev-only: the Agents screen with the board's own figures, `?headsup=1` with a pending sale. A 404 in production builds. */
export default function DevAgentsPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <AgentsBoard />
    </Suspense>
  );
}
