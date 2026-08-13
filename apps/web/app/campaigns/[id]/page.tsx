"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check, Clock, Copy, Pause, Play, RefreshCw, ShieldAlert, UserCheck, Users, XCircle } from "lucide-react";
import { api, formatIdr, formatMoney, formatNumber } from "../../../lib/api";
import { retryCampaignDiscovery } from "../../../lib/campaign-discovery";
import { cloneCampaignFromPreview, LOCAL_CLONE_EXPLANATION } from "../../../lib/campaign-clone";

type Recipient = { id: string; selected: boolean; eligibility: string; skipReason?: string; skipDetail?: string; state: string; frozenMessage?: string; creatorOpenIdSnapshot?: string; delivery?: { state: string; externalMessageId?: string; attemptCount: number; lastErrorCode?: string }; creator: { creatorOpenId: string; username?: string; nickname?: string }; snapshot?: { followerCount: number; gmvAmount: string | null; gmvCurrency: string | null; unitsSold: number } };
type Discovery = { state: string; candidateLimit: number; candidatesFetched: number; pagesFetched: number; nextAttemptAt?: string; failureCategory?: string };
type Campaign = { id: string; name: string; productName: string; messageTemplate: string; targetCount: number; cooldownDays: number; state: string; version: number; summary: any; dispatchCount: number; safetyPauseReason?: string; outboundMode: string; outboundEnabled: boolean; cooldownCapability: { appOriginated: string; historical: string }; discoveryWorkerState: "RUNNING" | "STALE" | "STOPPED"; shop: any; recipients: Recipient[]; discovery?: Discovery };

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [campaign, setCampaign] = useState<Campaign>();
  const [error, setError] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [confirmCount, setConfirmCount] = useState("");
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneKey, setCloneKey] = useState("");
  const [cloneForm, setCloneForm] = useState({ name: "", productName: "", targetCount: 1, messageTemplate: "" });
  const load = () => api<Campaign>(`/outreach/campaigns/${id}`).then(setCampaign).catch((e) => setError(e.message));
  useEffect(() => {
    load(); const timer = setInterval(load, 5000); return () => clearInterval(timer);
  }, [id]);
  async function action(name: string, body: unknown = {}) {
    setError("");
    try { await api(`/outreach/campaigns/${id}/${name}`, { method: "POST", body: JSON.stringify(body) }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
  }
  async function retryDiscovery() {
    setDiscovering(true); setError("");
    try { await retryCampaignDiscovery(id, readOnly); await load(); }
    catch (e) { setError(e instanceof Error ? `Creator discovery failed: ${e.message}` : "Creator discovery failed"); }
    finally { setDiscovering(false); }
  }
  function openClone() {
    setCloneForm({ name: `${campaign!.name} - Copy`, productName: campaign!.productName, targetCount: campaign!.targetCount, messageTemplate: campaign!.messageTemplate });
    setCloneKey(crypto.randomUUID());
    setCloneOpen(true);
  }
  async function submitClone(event: React.FormEvent) {
    event.preventDefault(); setCloning(true); setError("");
    try {
      const result = await cloneCampaignFromPreview(id, cloneForm, cloneKey);
      if (result.state !== "PREVIEW_READY") throw new Error("Cloned campaign did not reach PREVIEW_READY");
      router.push(`/campaigns/${result.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Campaign clone failed"); setCloning(false); }
  }
  if (!campaign) return <div className="page"><div className="loading">Loading campaign…</div>{error && <div className="alert error">{error}</div>}</div>;
  const summary = campaign.summary ?? {};
  const selectedCount = Number(summary.selected ?? campaign.recipients.filter((r) => r.selected).length);
  const realData = campaign.shop?.connectionMode === "READ_ONLY";
  const readOnly = !campaign.outboundEnabled;
  const deliveryCounts = campaign.recipients.reduce<Record<string, number>>((counts, recipient) => { counts[recipient.state] = (counts[recipient.state] ?? 0) + 1; return counts; }, {});
  const sample = campaign.recipients.find((recipient) => recipient.selected);
  const messagePreview = sample?.frozenMessage ?? campaign.messageTemplate
    .replace(/{{\s*creator_display_name\s*}}/g, sample?.creator.nickname ?? sample?.creator.username ?? "Creator")
    .replace(/{{\s*product_name\s*}}/g, campaign.productName)
    .replace(/{{\s*campaign_name\s*}}/g, campaign.name);
  const currencies = Object.entries(summary.gmvCurrencyCounts ?? {}).map(([currency, count]) => `${currency}: ${count}`).join(" · ");
  const discovery = campaign.discovery;
  const cooldownActive = discovery?.state === "BACKING_OFF" && Boolean(discovery.nextAttemptAt && new Date(discovery.nextAttemptAt) > new Date());
  return <div className="page"><Link className="back-link" href="/campaigns"><ArrowLeft size={16}/>Campaigns</Link>
    <header className="page-header"><div><span className="eyebrow">{campaign.productName}</span><h1>{campaign.name}</h1><p>{campaign.cooldownDays}-day cooldown · {realData ? `Real Marketplace · GMV context ${summary.expectedGmvCurrency ?? "provider-returned currencies"}` : "Mock Indonesian marketplace · IDR performance"} · outbound {campaign.outboundMode.toLowerCase()}</p></div><div className="header-actions">{["QUEUED", "RUNNING"].includes(campaign.state) && <button className="button secondary" onClick={() => action("pause")}><Pause size={16}/>Pause</button>}{["PAUSED", "PAUSE_REQUESTED"].includes(campaign.state) && <button className="button primary" onClick={() => action("resume")}><Play size={16}/>Resume</button>}{["FROZEN", "QUEUED", "RUNNING", "PAUSED", "PAUSE_REQUESTED", "SAFETY_PAUSED"].includes(campaign.state) && <button className="button secondary" onClick={() => action("cancel")}>Cancel unsent</button>}<span className={`status large ${campaign.state.toLowerCase()}`}>{campaign.state.replaceAll("_", " ")}</span></div></header>
    <section className="metric-strip"><div><span>Requested</span><strong>{formatNumber(summary.requested ?? campaign.targetCount)}</strong></div><div><span>Fetched</span><strong>{formatNumber(summary.fetchedOccurrences)}</strong></div><div><span>Excluded</span><strong>{formatNumber((summary.fetchedOccurrences ?? 0) - (summary.eligible ?? 0))}</strong></div><div><span>Eligible</span><strong>{formatNumber(summary.eligible)}</strong></div><div className="accent"><span>Selected</span><strong>{formatNumber(summary.selected)}</strong></div><div><span>Dispatched</span><strong>{formatNumber(campaign.dispatchCount)}</strong></div></section>
    {summary.shortfall > 0 && <div className="alert warning"><AlertTriangle/><div><strong>Target shortfall: {formatNumber(summary.shortfall)}</strong><span>Only {formatNumber(summary.selected)} creators meet every filter and safety rule. Filters were not weakened.</span></div></div>}
    {summary.truncated && <div className="alert neutral"><Clock/><div><strong>Candidate pool was capped</strong><span>More Marketplace pages exist. Ranking applies only to the fetched pool.</span></div></div>}
    {summary.historyIdentityCoverageIncomplete && <div className="alert warning"><ShieldAlert/><div><strong>HISTORY IDENTITY COVERAGE INCOMPLETE</strong><span>{formatNumber(summary.unresolvedHistoricalOutboundContacts)} historical outbound contacts belong to {formatNumber(summary.unresolvedHistoricalCreators)} IM-only identities. This preview is usable for analysis, but cooldown/dedupe coverage is not future outbound-safe.</span></div></div>}
    <div className="alert neutral"><ShieldAlert/><div><strong>APP-ORIGINATED DEDUPE SAFE</strong><span>Exact Creator Open IDs make cooldown and dedupe trustworthy for positive sends through this app. {campaign.cooldownCapability.historical === "HISTORICAL_COOLDOWN_COVERAGE_INCOMPLETE" ? "Historical cooldown coverage remains incomplete and is not heuristically matched." : "Historical cooldown coverage is complete."}</span></div></div>
    {summary.gmvMixedCurrency && <div className="alert warning"><AlertTriangle/><div><strong>Mixed Marketplace GMV currencies observed</strong><span>{currencies}. Values were not compared across currencies and no FX conversion was performed.</span></div></div>}
    {summary.gmvExcludedCurrencyMismatch > 0 && <div className="alert neutral"><AlertTriangle/><div><strong>Unexpected GMV currency excluded</strong><span>{formatNumber(summary.gmvExcludedCurrencyMismatch)} candidate values did not match {summary.expectedGmvCurrency}.</span></div></div>}
    {summary.freezeAdjustment > 0 && <div className="alert warning"><ShieldAlert/><div><strong>Frozen recipient count changed</strong><span>{formatNumber(summary.freezeAdjustment)} creator(s) became ineligible after preview.</span></div></div>}
    {discovery && ["QUEUED", "RUNNING", "BACKING_OFF"].includes(discovery.state) && campaign.discoveryWorkerState !== "RUNNING" && <div className="alert error"><AlertTriangle/><div><strong>Discovery worker is {campaign.discoveryWorkerState.toLowerCase()}</strong><span>Progress is safely persisted, but automatic Marketplace work will resume only when the production discovery service is running.</span></div></div>}
    {discovery && ["QUEUED", "RUNNING", "BACKING_OFF"].includes(discovery.state) && <div className={`alert ${discovery.state === "BACKING_OFF" ? "warning" : "neutral"}`}><Clock/><div><strong>{discovery.state === "BACKING_OFF" ? "TikTok Marketplace temporarily throttled" : "Searching Marketplace..."}</strong><span>{formatNumber(discovery.candidatesFetched)} / {formatNumber(discovery.candidateLimit)} candidates fetched. Progress is saved.{discovery.nextAttemptAt ? ` Next automatic attempt: ${new Date(discovery.nextAttemptAt).toLocaleString()}.` : ""}</span></div></div>}
    {discovery?.state === "COMPLETE" && <div className="alert neutral"><Check/><div><strong>Discovery complete</strong><span>{formatNumber(discovery.candidatesFetched)} provider candidates were considered.</span></div></div>}
    {discovery?.state === "FAILED" && <div className="alert error"><AlertTriangle/><div><strong>Discovery failed — operator action required</strong><span>The failure was sanitized as {discovery.failureCategory ?? "provider failure"}.</span></div><button disabled={discovering} className="button secondary" onClick={retryDiscovery}>Retry discovery</button></div>}
    {campaign.state === "DRAFT" && !discovery && <div className="alert error"><AlertTriangle/><div><strong>Creator discovery has not started</strong><span>This legacy campaign has no persisted discovery run.</span></div><button disabled={discovering || cooldownActive} className="button secondary" onClick={retryDiscovery}>{discovering ? "Queueing…" : "Start discovery"}</button></div>}
    {campaign.state === "PREVIEW_EXPIRED" && <div className="alert warning"><Clock/><div><strong>Frozen preview expired</strong><span>Creator reservations were released.</span></div><button className="button secondary" onClick={() => action("discovery-runs")}>Rediscover</button></div>}
    {campaign.state === "SAFETY_PAUSED" && <div className="alert error"><ShieldAlert/><div><strong>Campaign stopped at its dispatch-attempt safety limit</strong><span>{campaign.safetyPauseReason}</span></div></div>}
    {error && <div className="alert error">{error}</div>}
    {campaign.state === "PREVIEW_READY" && <section className="confirmation-card"><div><h2>{readOnly ? "Read-only preview is ready" : "Review recipients"}</h2><p>{readOnly ? "Outbound is physically unavailable in the current configuration." : `Freeze exactly ${formatNumber(selectedCount)} selected creators and their rendered messages. Freeze makes no TikTok request.`}</p></div><div className="header-actions"><button className="button secondary" onClick={openClone}><Copy size={17}/>Clone campaign</button>{!readOnly && <button className="button primary" onClick={() => action("freeze", { version: campaign.version })}><Check size={17}/>Freeze recipients</button>}</div></section>}
    {cloneOpen && <section className="panel clone-panel"><div className="panel-heading"><div><h2>Clone campaign</h2><p>{LOCAL_CLONE_EXPLANATION}</p></div></div><form className="clone-form" onSubmit={submitClone}><div className="form-grid"><label>New campaign name<input required value={cloneForm.name} onChange={(e) => setCloneForm({ ...cloneForm, name: e.target.value })}/></label><label>Product<input required value={cloneForm.productName} onChange={(e) => setCloneForm({ ...cloneForm, productName: e.target.value })}/></label><label>Target count<input required type="number" min="1" step="1" value={cloneForm.targetCount} onChange={(e) => setCloneForm({ ...cloneForm, targetCount: Number(e.target.value) })}/></label></div><label>Message template<textarea required rows={4} value={cloneForm.messageTemplate} onChange={(e) => setCloneForm({ ...cloneForm, messageTemplate: e.target.value })}/></label><div className="form-actions"><button type="button" className="button secondary" onClick={() => setCloneOpen(false)} disabled={cloning}>Cancel</button><button type="submit" className="button primary" disabled={cloning}>{cloning ? "Cloning…" : "Create PREVIEW_READY clone"}</button></div></form></section>}
    {["PREVIEW_READY", "FROZEN"].includes(campaign.state) && <section className="panel"><div className="panel-heading"><div><h2>Message preview</h2><p>Previewed for {sample?.creator.nickname ?? sample?.creator.username ?? "the first selected creator"}; frozen messages are immutable.</p></div></div><p style={{whiteSpace: "pre-wrap"}}>{messagePreview}</p></section>}
    {campaign.state === "FROZEN" && <section className="panel confirmation"><div><h2>Explicit confirmation required</h2><p>You are about to queue {formatNumber(selectedCount)} TikTok Affiliate messages. Visiting or refreshing this page never sends.</p></div><div className="confirmation-inputs"><label>Campaign name<input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={campaign.name}/></label><label>Selected count<input value={confirmCount} onChange={(e) => setConfirmCount(e.target.value)} placeholder={String(selectedCount)}/></label><button className="button primary" onClick={() => action("start", { version: campaign.version, confirmationName: confirmName, confirmationCount: Number(confirmCount) })}>Confirm & queue {formatNumber(selectedCount)} messages</button></div></section>}
    {campaign.dispatchCount > 0 && <section className="metric-strip"><div><span>Queued</span><strong>{formatNumber(deliveryCounts.QUEUED)}</strong></div><div><span>Sending</span><strong>{formatNumber(deliveryCounts.PROCESSING)}</strong></div><div className="accent"><span>Sent</span><strong>{formatNumber(deliveryCounts.SENT)}</strong></div><div><span>Restricted</span><strong>{formatNumber(deliveryCounts.RESTRICTED)}</strong></div><div><span>Failed</span><strong>{formatNumber(deliveryCounts.FAILED)}</strong></div><div><span>Unknown</span><strong>{formatNumber((deliveryCounts.DELIVERY_UNKNOWN ?? 0) + (deliveryCounts.DELIVERY_UNKNOWN_UNRESOLVED ?? 0))}</strong></div></section>}
    <section className="reason-grid"><div><XCircle/><span>Filter mismatch</span><strong>{formatNumber(summary.excludedByFilter)}</strong></div><div><Users/><span>Duplicates</span><strong>{formatNumber(summary.skippedDuplicates)}</strong></div><div><Clock/><span>Cooldown/history</span><strong>{formatNumber(summary.skippedCooldown)}</strong></div><div><ShieldAlert/><span>Unknown delivery</span><strong>{formatNumber(summary.skippedUnknownDelivery)}</strong></div></section>
    <section className="panel"><div className="panel-heading"><div><h2>Recipients and results</h2><p>Top 250 recipients are shown with durable delivery evidence and sanitized outcomes.</p></div><button className="icon-button" onClick={load} aria-label="Refresh"><RefreshCw size={17}/></button></div><div className="table-wrap"><table><thead><tr><th>Creator</th><th>Followers</th><th>30-day GMV</th><th>Eligibility</th><th>Delivery status</th><th>Evidence / outcome</th></tr></thead><tbody>{campaign.recipients.map((recipient) => <tr key={recipient.id}><td><div className="creator"><div className="avatar">{(recipient.creator.nickname ?? recipient.creator.username ?? "?")[0]}</div><div><strong>{recipient.creator.nickname ?? recipient.creator.username ?? "Unknown creator"}</strong><small>{recipient.creatorOpenIdSnapshot ?? recipient.creator.creatorOpenId}</small></div></div></td><td>{formatNumber(recipient.snapshot?.followerCount)}</td><td>{realData ? formatMoney(recipient.snapshot?.gmvAmount, recipient.snapshot?.gmvCurrency) : formatIdr(recipient.snapshot?.gmvAmount)}</td><td>{recipient.selected ? <span className="pill good"><UserCheck size={14}/>Selected</span> : recipient.eligibility === "ELIGIBLE" ? <span className="pill">Eligible</span> : <span className="pill bad">{recipient.skipReason?.replaceAll("_", " ")}</span>}</td><td><span className={`status ${recipient.state.toLowerCase()}`}>{recipient.state.replaceAll("_", " ")}</span></td><td><small>{recipient.delivery?.externalMessageId ? `Message ${recipient.delivery.externalMessageId}` : recipient.delivery?.lastErrorCode?.replaceAll("_", " ") ?? recipient.skipDetail ?? "—"}</small></td></tr>)}</tbody></table></div></section>
  </div>;
}
