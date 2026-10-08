import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "RD Compatibility Lab — Watch Party",
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};
export default function RdCompatLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
