"use client";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Filter, MessageSquareText, Search, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { api } from "../../../lib/api";
import { campaignDetailUrl, createCampaignAndDiscover } from "../../../lib/campaign-discovery";
import { CAMPAIGN_FOLLOWER_OPTIONS, CAMPAIGN_GMV_OPTIONS, followerFilters, gmvFilters } from "../../../lib/campaign-options";
import { CreatorDatabaseSync } from "../../../components/creator-database-sync";

const numericFields = [
  ["Minimum units sold", "minUnitsSold", "0"],
  ["Minimum average video views", "minAvgVideoViews", "0"],
  ["Minimum average live viewers", "minAvgLiveViewers", "0"],
  ["Minimum engagement rate", "minEngagementRate", "0.05"]
] as const;

export default function NewCampaignPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [outboundEnabled, setOutboundEnabled] = useState(false);
  const [outboundReason, setOutboundReason] = useState("");
  const [maxRecipientsPerCampaign, setMaxRecipientsPerCampaign] = useState<number | null>(null);
  const [form, setForm] = useState<Record<string, string>>({
    name: "Indonesia Beauty Creator Launch", productName: "Glow Serum", targetCount: "1000", cooldownDays: "30",
    category: "beauty", followerBucket: "F10", gmvBucket: "G2", rankingMetric: "GMV",
    messageTemplate: "Hi {{creator_display_name}}, we'd love to invite you to collaborate on {{product_name}} for our {{campaign_name}} campaign."
  });

  useEffect(() => { api<any>("/integrations/tiktok").then((value) => {
    const real = value.mode === "READ_ONLY";
    const recipientCeiling = Number(value.selectedShop?.maxRecipientsPerCampaign);
    setReadOnly(real); setOutboundEnabled(value.outboundEnabled === true); setOutboundReason(value.outboundCapability?.reason ?? "");
    if (Number.isInteger(recipientCeiling) && recipientCeiling > 0) {
      setMaxRecipientsPerCampaign(recipientCeiling);
      setForm((current) => Number(current.targetCount) > recipientCeiling ? { ...current, targetCount: String(recipientCeiling) } : current);
    }
    if (real) setForm((current) => ({ ...current, category: "", rankingMetric: "FOLLOWERS", gmvBucket: "" }));
  }).catch(() => undefined); }, []);

  const set = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const filters: Record<string, unknown> = {
        categoryIds: form.category ? [form.category] : undefined,
        ...followerFilters(form.followerBucket),
        ...gmvFilters(form.gmvBucket)
      };
      for (const [, key] of numericFields) if (form[key] !== "" && form[key] != null) filters[key] = Number(form[key]);
      if (form.gmvCurrency) filters.gmvCurrency = form.gmvCurrency.toUpperCase();
      const result = await createCampaignAndDiscover({
        name: form.name, productName: form.productName, targetCount: Number(form.targetCount), candidateLimit: Number(form.targetCount),
        cooldownDays: Number(form.cooldownDays), messageTemplate: form.messageTemplate, filters,
        rankingMetric: form.rankingMetric, rankingDirection: "DESC"
      }, readOnly);
      router.push(campaignDetailUrl(result));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create campaign"); setBusy(false); }
  }

  return <div className="page narrow"><Link className="back-link" href="/campaigns"><ArrowLeft size={16}/>Campaigns</Link>
    <header className="page-header"><div><span className="eyebrow">{readOnly ? (outboundEnabled ? "New real outbound campaign" : "New real read-only preview") : "New mock campaign"}</span><h1>Define the creator pool</h1><p>Choose supported creator segments, preview the eligible database records, then use the existing one-click Send flow. No Marketplace request is made while filtering.</p></div></header>
    <CreatorDatabaseSync compact/>
    <form onSubmit={submit} className="form-stack">
      <section className="form-section"><div className="section-heading"><Search/><div><h2>Campaign objective</h2><p>Name the campaign and set the maximum recipient target.</p></div></div><div className="form-rows">
        <label className="form-row"><span>Campaign name</span><input required value={form.name} onChange={(event) => set("name", event.target.value)}/><small>Shown throughout campaign operations.</small></label>
        <label className="form-row"><span>Product</span><input required value={form.productName} onChange={(event) => set("productName", event.target.value)}/><small>The product named in creator outreach.</small></label>
        <label className="form-row"><span>Target</span><input min="1" max={maxRecipientsPerCampaign ?? undefined} type="number" required value={form.targetCount} onChange={(event) => set("targetCount", event.target.value)}/><small>{maxRecipientsPerCampaign ? `Maximum ${maxRecipientsPerCampaign.toLocaleString()} recipients per campaign.` : "Campaign ceiling is loading…"}</small></label>
        <label className="form-row"><span>Cooldown</span><input min="0" type="number" required value={form.cooldownDays} onChange={(event) => set("cooldownDays", event.target.value)}/><small>Days since the creator was last contacted.</small></label>
        {readOnly ? <label className="form-row"><span>Category ID</span><input value={form.category} onChange={(event) => set("category", event.target.value)} placeholder="All categories"/><small>Optional exact TikTok category ID stored in the database.</small></label> : <label className="form-row"><span>Category</span><select value={form.category} onChange={(event) => set("category", event.target.value)}><option value="beauty">Beauty</option><option value="fashion">Fashion</option><option value="home">Home &amp; living</option><option value="health">Health</option><option value="food">Food</option></select><small>Creator category.</small></label>}
      </div></section>
      <section className="form-section"><div className="section-heading"><Filter/><div><h2>Performance filters</h2><p>Follower and GMV segments use the project&apos;s canonical supported ranges.</p></div></div><div className="form-rows">
        <label className="form-row"><span>Followers</span><select data-testid="follower-range" value={form.followerBucket} onChange={(event) => set("followerBucket", event.target.value)}><option value="">Any follower count</option>{CAMPAIGN_FOLLOWER_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select><small>Inclusive Creator Database follower range.</small></label>
        <label className="form-row"><span>GMV</span><select data-testid="gmv-range" value={form.gmvBucket} onChange={(event) => set("gmvBucket", event.target.value)}><option value="">Any GMV</option>{CAMPAIGN_GMV_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select><small>{form.gmvBucket ? `${CAMPAIGN_GMV_OPTIONS.find((option) => option.code === form.gmvBucket)?.description} in the selected currency.` : "No GMV boundary."}</small></label>
        {readOnly && <label className="form-row"><span>GMV currency</span><input maxLength={3} placeholder="e.g. IDR or USD" value={form.gmvCurrency ?? ""} onChange={(event) => set("gmvCurrency", event.target.value.toUpperCase())}/><small>Required for a GMV segment or GMV ranking; no FX conversion occurs.</small></label>}
        {numericFields.map(([label, key, placeholder]) => <label className="form-row" key={key}><span>{label}</span><input type="number" min="0" step="any" placeholder={placeholder} value={form[key] ?? ""} onChange={(event) => set(key, event.target.value)}/><small>Optional minimum; leave blank for no boundary.</small></label>)}
        <label className="form-row"><span>Ranking</span><select value={form.rankingMetric} onChange={(event) => set("rankingMetric", event.target.value)}><option value="GMV">GMV</option><option value="UNITS_SOLD">Units sold</option><option value="FOLLOWERS">Followers</option><option value="AVG_VIDEO_VIEWS">Average video views</option><option value="AVG_LIVE_VIEWERS">Average live viewers</option><option value="ENGAGEMENT_RATE">Engagement rate</option></select><small>Eligible creators are ranked descending.</small></label>
      </div></section>
      <section className="form-section"><div className="section-heading"><MessageSquareText/><div><h2>Outreach message</h2><p>The exact rendered text remains frozen in PostgreSQL for each selected creator.</p></div></div><label className="form-row form-row-textarea"><span>Template</span><textarea rows={5} required value={form.messageTemplate} onChange={(event) => set("messageTemplate", event.target.value)}/><small>Allowed: {"{{creator_display_name}} · {{product_name}} · {{campaign_name}}"}</small></label></section>
      <div className="safety-note"><ShieldCheck/><div><strong>Eligibility rules remain unchanged</strong><span>The selected segments map to the existing numeric filters. Cooldown, dedupe, reservations, DELIVERY_UNKNOWN, freeze, and delivery safeguards are unchanged. {readOnly && !outboundEnabled && `Outbound unavailable: ${outboundReason || "status is loading"}.`}</span></div></div>
      {error && <div className="alert error">{error}</div>}
      <div className="form-actions"><Link className="button secondary" href="/campaigns">Cancel</Link><button disabled={busy} className="button primary" type="submit">{busy ? "Filtering database…" : "Create preview"}<ArrowRight size={17}/></button></div>
    </form>
  </div>;
}
