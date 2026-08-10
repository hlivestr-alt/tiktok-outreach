import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "../components/app-shell";

export const metadata: Metadata = {
  title: "Affiliate Outreach Operations",
  description: "Mock-first TikTok Shop affiliate outreach operations"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AppShell>{children}</AppShell></body></html>;
}

