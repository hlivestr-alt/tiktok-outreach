"use client";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, Filter, MessageSquareText, Search, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { api } from "../../../lib/api";
import { campaignDetailUrl, createCampaignAndDiscover } from "../../../lib/campaign-discovery";

const fields = [
  ["Minimum followers", "minFollowers", "1000"], ["Maximum followers", "maxFollowers", "500000"],
  ["Minimum GMV", "minGmv", "0"], ["Maximum GMV", "maxGmv", "250000000"],
  ["Minimum units sold", "minUnitsSold", "0"], ["Minimum avg. video views", "minAvgVideoViews", "0"],
  ["Minimum avg. live viewers", "minAvgLiveViewers", "0"], ["Minimum engagement rate", "minEngagementRate", "0.05"]
];

export default function NewCampaignPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => { api<any>("/integrations/tiktok").then((value) => { const real = value.mode === "READ_ONLY"; setReadOnly(real); if (real) setForm((current) => ({ ...current, category: "", rankingMetric: "FOLLOWERS", minGmv: "", maxGmv: "" })); }).catch(() => undefined); }, []);
  const [form, setForm] = useState<Record<string, string>>({
    name: "Indonesia Beauty Creator Launch", productName: "Glow Serum", targetCount: "1000", cooldownDays: "30",
    candidateLimit: "2000", category: "beauty", rankingMetric: "GMV",
    messageTemplate: "Hi {{creator_display_name}}, we'd love to invite you to collaborate on {{product_name}} for our {{campaign_name}} campaign."
  });
  const set = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const filters: Record<string, unknown> = { categoryIds: form.category ? [form.category] : undefined };
      for (const [, key] of fields) if (form[key] !== "" && form[key] != null) filters[key] = Number(form[key]);
      if (form.gmvCurrency) filters.gmvCurrency = form.gmvCurrency.toUpperCase();
      const result = await createCampaignAndDiscover({
        name: form.name, productName: form.productName, targetCount: Number(form.targetCount), candidateLimit: Number(form.candidateLimit),
        cooldownDays: Number(form.cooldownDays), messageTemplate: form.messageTemplate, filters,
        rankingMetric: form.rankingMetric, rankingDirection: "DESC"
      }, readOnly);
      router.push(campaignDetailUrl(result));
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to create campaign"); setBusy(false); }
  }
  return <div className="page narrow"><Link className="back-link" href="/campaigns"><ArrowLeft size={16}/>Campaigns</Link>
    <header className="page-header"><div><span className="eyebrow">{readOnly ? "New real read-only preview" : "New mock campaign"}</span><h1>Define the creator pool</h1><p>Discovery applies provider and local filters, historical cooldowns, and duplicate checks. {readOnly && "Real mode cannot freeze or dispatch."}</p></div></header>
    <form onSubmit={submit} className="form-stack">
      <section className="panel form-section"><div className="section-icon"><Search/></div><div className="section-content"><h2>Campaign objective</h2><p>Name the campaign and set the maximum creator target.</p><div className="form-grid"><label>Campaign name<input required value={form.name} onChange={(e) => set("name", e.target.value)}/></label><label>Product name<input required value={form.productName} onChange={(e) => set("productName", e.target.value)}/></label><label>Requested creators<input min="1" max="1000" type="number" required value={form.targetCount} onChange={(e) => set("targetCount", e.target.value)}/><small>Hard ceiling: 1,000 per campaign</small></label><label>Candidate pool cap<input min="1" max="10000" type="number" required value={form.candidateLimit} onChange={(e) => set("candidateLimit", e.target.value)}/></label><label>Cooldown days<input min="0" type="number" required value={form.cooldownDays} onChange={(e) => set("cooldownDays", e.target.value)}/></label>{readOnly ? <label>TikTok category ID<input value={form.category} onChange={(e) => set("category", e.target.value)} placeholder="Official numeric category ID"/><small>Use the exact ID from TikTok Shop category data; leave blank for all categories.</small></label> : <label>Creator category<select value={form.category} onChange={(e) => set("category", e.target.value)}><option value="beauty">Beauty</option><option value="fashion">Fashion</option><option value="home">Home & living</option><option value="health">Health</option><option value="food">Food</option></select></label>}</div></div></section>
      <section className="panel form-section"><div className="section-icon"><Filter/></div><div className="section-content"><h2>Performance filters</h2><p>{readOnly ? "TikTok returns currency with each GMV value. Numeric GMV filtering and ranking require an explicit matching currency and never perform FX conversion." : "Exact local filters use deterministic IDR mock data."}</p><div className="form-grid">{fields.map(([label, key, placeholder]) => <label key={key}>{label}{!readOnly && key.toLowerCase().includes("gmv") ? " (IDR)" : ""}<input type="number" min="0" step="any" placeholder={placeholder} value={form[key] ?? ""} onChange={(e) => set(key, e.target.value)}/></label>)}{readOnly && <label>Expected GMV currency<input maxLength={3} placeholder="e.g. IDR or USD" value={form.gmvCurrency ?? ""} onChange={(e) => set("gmvCurrency", e.target.value.toUpperCase())}/><small>Required when using a GMV boundary or GMV ranking.</small></label>}<label>Ranking<select value={form.rankingMetric} onChange={(e) => set("rankingMetric", e.target.value)}><option value="GMV">GMV</option><option value="UNITS_SOLD">Units sold</option><option value="FOLLOWERS">Followers</option><option value="AVG_VIDEO_VIEWS">Average video views</option><option value="AVG_LIVE_VIEWERS">Average live viewers</option><option value="ENGAGEMENT_RATE">Engagement rate</option></select></label></div></div></section>
      <section className="panel form-section"><div className="section-icon"><MessageSquareText/></div><div className="section-content"><h2>Outreach message</h2><p>The exact rendered text is frozen in PostgreSQL for each selected creator.</p><label>Plain-text template<textarea rows={5} required value={form.messageTemplate} onChange={(e) => set("messageTemplate", e.target.value)}/><small>Allowed: {"{{creator_display_name}} · {{product_name}} · {{campaign_name}}"}</small></label></div></section>
      <div className="safety-note"><ShieldCheck/><div><strong>Filters are never weakened</strong><span>If only 873 of 1,000 requested creators are eligible, the preview will select and allow confirmation of those 873.</span></div></div>
      {error && <div className="alert error">{error}</div>}
      <div className="form-actions"><Link className="button secondary" href="/campaigns">Cancel</Link><button disabled={busy} className="button primary" type="submit">{busy ? "Queueing discovery…" : "Create & discover"}<ArrowRight size={17}/></button></div>
    </form>
  </div>;
}
