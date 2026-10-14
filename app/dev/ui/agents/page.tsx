import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AgentsGallery } from "./AgentsGallery";

/** Dev-only: the Agents tab in each of its states, with fixtures (see AgentsGallery). A 404 in production builds. */
export default function DevAgentsPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <AgentsGallery />
    </Suspense>
  );
}
