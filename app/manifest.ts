import type { MetadataRoute } from "next";

/** Installable to the home screen (D5): the v5 goose icon on ink, which is also the welcome's colour. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GreedyGoose",
    short_name: "GreedyGoose",
    description: "Cash that earns, stocks like NVIDIA and Apple, and credit in one tap.",
    start_url: "/",
    display: "standalone",
    background_color: "#0e0d0b",
    theme_color: "#0e0d0b",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
