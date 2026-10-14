import { notFound } from "next/navigation";
import { Gallery } from "./Gallery";

/** Dev-only gallery of the shared UI pieces. Linked from nowhere, and a 404 in production builds. */
export default function DevUiPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Gallery />;
}
