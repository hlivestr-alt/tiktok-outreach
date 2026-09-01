"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Database, History, Megaphone, Monitor, Moon, Plus, Settings, ShieldCheck, Sun } from "lucide-react";
import { api } from "../lib/api";
import { DesktopTitlebar } from "./desktop-titlebar";

type Appearance = "system" | "light" | "dark";
const nav = [
  { href: "/", label: "Creator Database", icon: Database },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/campaigns/new", label: "New campaign", icon: Plus }
];
const secondary = [
  { href: "/contact-history", label: "Activity", icon: History },
  { href: "/settings", label: "Settings & diagnostics", icon: Settings }
];

function applyAppearance(appearance: Appearance) {
  const resolved = appearance === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : appearance;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.appearance = appearance;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mode, setMode] = useState("MOCK");
  const [outboundMode, setOutboundMode] = useState("MOCK");
  const [appearance, setAppearance] = useState<Appearance>("system");
  useEffect(() => {
    const saved = localStorage.getItem("outreach-appearance");
    const initial: Appearance = saved === "light" || saved === "dark" ? saved : "system";
    setAppearance(initial); applyAppearance(initial);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => { if ((localStorage.getItem("outreach-appearance") ?? "system") === "system") applyAppearance("system"); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => { api<any>("/integrations/tiktok").then((value) => {
    setMode(value.mode ?? "MOCK"); setOutboundMode(value.outboundMode ?? (value.mode === "MOCK" ? "MOCK" : "READ_ONLY"));
  }).catch(() => undefined); }, []);
  const changeAppearance = (value: Appearance) => {
    setAppearance(value); localStorage.setItem("outreach-appearance", value); applyAppearance(value);
  };
  const readOnly = mode === "READ_ONLY";
  const active = (href: string) => href === "/" ? pathname === "/" : href === "/campaigns" ? pathname === "/campaigns" || /^\/campaigns\/[^/]+$/.test(pathname) : pathname === href;
  return <div className="app-shell">
    <DesktopTitlebar/>
    <div className="shell-body">
      <aside className="sidebar">
        <Link className="brand" href="/"><span className="app-mark" aria-hidden="true">TO</span><span><strong>TikTok Outreach</strong><small>Creator operations</small></span></Link>
        <nav aria-label="Primary navigation">{nav.map(({ href, label, icon: Icon }) => <Link className={active(href) ? "active" : ""} href={href} key={href}><Icon size={17}/><span>{label}</span></Link>)}</nav>
        <div className="sidebar-secondary"><nav aria-label="Secondary navigation">{secondary.map(({ href, label, icon: Icon }) => <Link className={active(href) ? "active" : ""} href={href} key={href}><Icon size={17}/><span>{label}</span></Link>)}</nav></div>
        <div className="appearance" aria-label="Appearance"><span>Appearance</span><div role="group">{(["system", "light", "dark"] as const).map((value) => { const Icon = value === "system" ? Monitor : value === "light" ? Sun : Moon; return <button type="button" key={value} className={appearance === value ? "active" : ""} aria-pressed={appearance === value} aria-label={`${value} appearance`} onClick={() => changeAppearance(value)}><Icon size={14}/></button>; })}</div></div>
        <div className="sidebar-safety"><ShieldCheck size={16}/><div><strong>{outboundMode === "LIVE" ? "Outbound live" : readOnly ? "Outbound unavailable" : "Mock outbound"}</strong><span>{outboundMode === "LIVE" ? "One-click sending enabled" : readOnly ? "Real reads only" : "Local test data"}</span></div></div>
      </aside>
      <main className="main"><div className={`mock-banner ${readOnly ? "real-read-only" : ""}`}><span className="pulse"/>{outboundMode === "LIVE" ? "Production TikTok · Outbound live · One-click send" : readOnly ? "Production TikTok · Outbound read only" : "Mock mode · No real messages"}</div><div className="content-scroller" data-testid="content-scroller">{children}</div></main>
    </div>
  </div>;
}
