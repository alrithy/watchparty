import type { MetadataRoute } from "next";

/** Lets iPhone (Add to Home Screen) and other browsers open Watch Party as its own app, without browser bars. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Watch Party",
    short_name: "Watch Party",
    description: "Private synchronized video playback.",
    start_url: "/",
    display: "standalone",
    background_color: "#050506",
    theme_color: "#050506",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
