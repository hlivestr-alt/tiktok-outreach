"use client";
import { useEffect, useState } from "react";
import { Activity, Ban, Check, Gauge, KeyRound, LockKeyhole, Server, ShieldCheck } from "lucide-react";
import { api, formatNumber } from "../../lib/api";

export default function SettingsPage() {
  const [data, setData] = useState<any>(); const [error, setError] = useState("");
  useEffect(() => { api("/integrations/tiktok").then(setData).catch((e) => setError(e.message)); }, []);
  const shop = data?.shop;
  return <div className="page"><header className="page-header"><div><span className="eyebrow">Integration boundary</span><h1>TikTok mock & safety settings</h1><p>The production adapter, credentials, and outbound activation controls do not exist in this phase-one build.</p></div><span className="status large mock">MOCK ONLY</span></header>
    {error && <div className="alert error">{error}</div>}
    <section className="settings-hero"><div className="settings-icon"><ShieldCheck/></div><div><h2>Outbound network boundary is locked</h2><p>All discovery, conversations, messages, quotas, and replies come from deterministic local fixtures.</p></div><div className="gate-list"><span><Check/>No app secret</span><span><Check/>No seller tokens</span><span><Check/>No production HTTP client</span></div></section>
    <div className="settings-grid"><section className="panel"><div className="panel-heading"><div><h2>Application ceilings</h2><p>Absolute database-enforced limits; TikTok adaptation may only go slower.</p></div><Gauge/></div><div className="setting-rows"><div><span>Maximum per campaign</span><strong>{formatNumber(shop?.maxSendsPerCampaign)}</strong></div><div><span>Maximum per shop day</span><strong>{formatNumber(shop?.maxSendsPerDay)}</strong></div><div><span>Maximum dispatch rate</span><strong>{formatNumber(shop?.maxDispatchesPerMinute)} / minute</strong></div><div><span>Shop day timezone</span><strong>{shop?.timezone ?? "Asia/Jakarta"}</strong></div></div></section>
      <section className="panel"><div className="panel-heading"><div><h2>Mock marketplace</h2><p>Capabilities are exposed by the adapter, not hard-coded into campaign logic.</p></div><Server/></div><div className="setting-rows"><div><span>Market</span><strong>{data?.capabilities?.market ?? "ID"}</strong></div><div><span>Currency</span><strong>{data?.capabilities?.currency ?? "IDR"}</strong></div><div><span>Message types</span><strong>Plain text</strong></div><div><span>Page sizes</span><strong>{data?.capabilities?.pageSizes?.join(", ") ?? "12, 20"}</strong></div></div></section></div>
    <section className="panel"><div className="panel-heading"><div><h2>Production activation gates</h2><p>These prerequisites are documented but intentionally unavailable.</p></div><LockKeyhole/></div><div className="gate-cards"><div><KeyRound/><strong>Authentication & roles</strong><span>Admin/operator access is required before live mode.</span></div><div><Activity/><strong>History readiness</strong><span>Complete and fresh conversation coverage is mandatory.</span></div><div><ShieldCheck/><strong>Shop allowlist</strong><span>Exact shop ID and expiring activation must match.</span></div><div><Ban/><strong>Global kill switch</strong><span>Workers must check it before every dispatch claim.</span></div></div></section>
  </div>;
}
