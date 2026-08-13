"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { History, LayoutDashboard, Megaphone, Settings, ShieldCheck, Sparkles } from "lucide-react";
import { api } from "../lib/api";

const nav = [
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/campaigns/new", label: "New campaign", icon: Sparkles },
  { href: "/contact-history", label: "History readiness", icon: History },
  { href: "/settings", label: "Integration & safety", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mode, setMode] = useState("MOCK");
  const [outboundMode, setOutboundMode] = useState("MOCK");
  useEffect(() => { api<any>("/integrations/tiktok").then((value) => { setMode(value.mode ?? "MOCK"); setOutboundMode(value.outboundMode ?? (value.mode === "MOCK" ? "MOCK" : "READ_ONLY")); }).catch(() => undefined); }, []);
  const readOnly = mode === "READ_ONLY";
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><LayoutDashboard size={20}/></div><div><strong>Affiliate Ops</strong><span>Operations console</span></div></div>
      <nav>{nav.map(({ href, label, icon: Icon }) => <Link className={pathname === href || (href === "/campaigns" && pathname.startsWith("/campaigns/")) ? "active" : ""} href={href} key={href}><Icon size={18}/>{label}</Link>)}</nav>
      <div className="sidebar-safety"><ShieldCheck size={18}/><div><strong>{outboundMode === "LIVE" ? "Live outbound enabled" : readOnly ? "Outbound disabled" : "Mock outbound only"}</strong><span>{outboundMode === "LIVE" ? "Dedicated worker only" : readOnly ? "Real reads only" : "No TikTok API calls"}</span></div></div>
    </aside>
    <main className="main"><div className={`mock-banner ${readOnly ? "real-read-only" : ""}`}><span className="pulse"/>{outboundMode === "LIVE" ? "PRODUCTION TIKTOK — OUTBOUND LIVE — CONFIRMATION STILL REQUIRED" : readOnly ? "PRODUCTION TIKTOK — OUTBOUND READ ONLY" : "MOCK MODE — No TikTok API calls or real messages can occur"}</div>{children}</main>
  </div>;
}
