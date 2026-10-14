import type { Viewport } from "next";
import { Welcome } from "./Welcome";

// The welcome is drawn on ink, so the browser's bars and the overscroll match it; signed-in screens keep the ground.
export const viewport: Viewport = { themeColor: "#0e0d0b" };

export default function WelcomePage() {
  return <Welcome />;
}
