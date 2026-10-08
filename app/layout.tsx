import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Watch Party",
  description: "Private synchronized video playback.",
  robots: { index: false, follow: false },
};

// "cover" lets the iPhone fullscreen player reach the screen edges; pages keep to the safe area (globals.css).
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
