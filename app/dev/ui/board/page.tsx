import { Suspense } from "react";
import { notFound } from "next/navigation";
import { BoardGallery } from "./BoardGallery";

/** Dev-only: the Leaderboard tab in each of its states, with fixtures (see BoardGallery). A 404 in production builds. */
export default function DevBoardPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <BoardGallery />
    </Suspense>
  );
}
