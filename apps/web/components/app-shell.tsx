"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { History, LayoutDashboard, Megaphone, Settings, ShieldCheck, Sparkles } from "lucide-react";

const nav = [
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/campaigns/new", label: "New campaign", icon: Sparkles },
  { href: "/contact-history", label: "History readiness", icon: History },
  { href: "/settings", label: "Integration & safety", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><LayoutDashboard size={20}/></div><div><strong>Affiliate Ops</strong><span>Operations console</span></div></div>
      <nav>{nav.map(({ href, label, icon: Icon }) => <Link className={pathname === href || (href === "/campaigns" && pathname.startsWith("/campaigns/")) ? "active" : ""} href={href} key={href}><Icon size={18}/>{label}</Link>)}</nav>
      <div className="sidebar-safety"><ShieldCheck size={18}/><div><strong>Outbound locked</strong><span>Mock adapter only</span></div></div>
    </aside>
    <main className="main"><div className="mock-banner"><span className="pulse"/>MOCK MODE — No TikTok API calls or real messages can occur</div>{children}</main>
  </div>;
}

