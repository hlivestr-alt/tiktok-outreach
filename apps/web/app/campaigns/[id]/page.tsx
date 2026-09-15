"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check, Clock, Copy, Pause, Play, RefreshCw, ShieldAlert, UserCheck } from "lucide-react";
import { api, formatIdr, formatMoney, formatNumber } from "../../../lib/api";
import { retryCampaignDiscovery } from "../../../lib/campaign-discovery";
import { cloneCampaignFromPreview, LOCAL_CLONE_EXPLANATION } from "../../../lib/campaign-clone";
import { campaignSendAvailability } from "../../../lib/campaign-ui-state";

type DeliveryAttempt = { attemptNumber: number; outcome: string; providerCode?: string; providerHttpStatus?: number; providerRequestId?: string; startedAt: string; completedAt?: string };
type Recipient = { id: string; selected: boolean; eligibility: string; skipReason?: string; skipDetail?: string; state: string; frozenMessage?: string; creatorOpenIdSnapshot?: string; delivery?: { state: string; externalMessageId?: string; providerRequestId?: string; attemptCount: number; lastAttemptedAt?: string; sentAt?: string; lastErrorCode?: string; lastErrorDetail?: string; attempts?: DeliveryAttempt[] }; creator: { creatorOpenId: string; username?: string; nickname?: string }; snapshot?: { followerCount: number; gmvAmount: string | null; gmvCurrency: string | null; unitsSold: number } };
type Discovery = { state: string; candidateLimit: number; candidatesFetched: number; pagesFetched: number; nextAttemptAt?: string; failureCategory?: string };
type Campaign = { id: string; name: string; productName: string; messageTemplate: string; targetCount: number; cooldownDays: number; state: string; version: number; summary: any; dispatchCount: number; safetyPauseReason?: string; outboundMode: string; outboundEnabled: boolean; outboundCapability?: { mode: string; mutationCapability: boolean; available: boolean; workerState: string; reason: string | null }; cooldownCapability: { appOriginated: string; historical: string }; discoveryWorkerState: "RUNNING" | "STALE" | "STOPPED"; shop: any; recipients: Recipient[]; discovery?: Discovery; progress: { frozen: number; completed: number; remaining: number; states: Record<string, number> }; recipientPage: { shown: number; total: number; limit: number }; outboundPacing: { sendMessageMaxPerSecond: number; sendMessageMinIntervalMs: number; idealMinimumDurationSeconds: number } };

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [campaign, setCampaign] = useState<Campaign>();
  const [error, setError] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [sending, setSending] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneKey, setCloneKey] = useState("");
  const [cloneForm, setCloneForm] = useState({ targetCount: 1, messageTemplate: "" });
  const load = () => api<Campaign>(`/outreach/campaigns/${id}`).then(setCampaign).catch((e) => setError(e.message));
  useEffect(() => {
    load(); const timer = setInterval(load, 5000); return () => clearInterval(timer);
  }, [id]);
  async function action(name: string, body: unknown = {}) {
    setError("");
    try { await api(`/outreach/campaigns/${id}/${name}`, { method: "POST", body: JSON.stringify(body) }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
  }
  async function sendCampaign() {
    if (!campaign || sending) return;
    setSending(true); setError("");
    try {
      await api(`/outreach/campaigns/${id}/send`, { method: "POST", body: JSON.stringify({ version: campaign.version }) });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Send failed"); }
    finally { setSending(false); }
  }
  async function retryDiscovery() {
    setDiscovering(true); setError("");
    try { await retryCampaignDiscovery(id); await load(); }
    catch (e) { setError(e instanceof Error ? `Creator discovery failed: ${e.message}` : "Creator discovery failed"); }
    finally { setDiscovering(false); }
  }
  function openClone() {
    setCloneForm({ targetCount: campaign!.targetCount, messageTemplate: campaign!.messageTemplate });
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
  const eligibleCount = Number(summary.eligible ?? 0);
  const selectedCount = Number(summary.selected ?? campaign.recipients.filter((r) => r.selected).length);
  const realData = campaign.shop?.connectionMode === "READ_ONLY";
  const outboundUnavailable = !campaign.outboundEnabled;
  const sendAvailability = campaignSendAvailability({
    eligibleCount, selectedCount, outboundEnabled: campaign.outboundEnabled,
    outboundReason: campaign.outboundCapability?.reason
  });
  const sendReason = sendAvailability.reason;
  const sendDisabled = sending || !sendAvailability.canSend;
  const deliveryCounts = campaign.progress.states;
  const idealSeconds = campaign.outboundPacing.idealMinimumDurationSeconds;
  const idealDuration = `${Math.floor(idealSeconds / 60)}m ${idealSeconds % 60}s`;
  const sample = campaign.recipients.find((recipient) => recipient.selected);
  const messagePreview = sample?.frozenMessage ?? campaign.messageTemplate
    .replace(/{{\s*creator_display_name\s*}}/g, sample?.creator.nickname ?? sample?.creator.username ?? "Creator")
    .replace(/{{\s*product_name\s*}}/g, campaign.productName)
    .replace(/{{\s*campaign_name\s*}}/g, campaign.name);
  const currencies = Object.entries(summary.gmvCurrencyCounts ?? {}).map(([currency, count]) => `${currency}: ${count}`).join(" · ");
  const discovery = campaign.discovery;
  const cooldownActive = discovery?.state === "BACKING_OFF" && Boolean(discovery.nextAttemptAt && new Date(discovery.nextAttemptAt) > new Date());
  const excludedCount = Math.max(0, Number(summary.fetchedOccurrences ?? 0) - eligibleCount);
  const dataNotes = [
    {
      label: "Dedupe protection", status: "Healthy", tone: "healthy",
      detail: `Exact Creator Open IDs protect app-originated cooldown and dedupe. ${campaign.cooldownCapability.historical === "HISTORICAL_COOLDOWN_COVERAGE_INCOMPLETE" ? "Historical identity coverage remains incomplete." : "Historical coverage is complete."}`
    },
    ...(discovery ? [{
      label: "Discovery", status: discovery.state === "COMPLETE" ? "Complete" : discovery.state.replaceAll("_", " "),
      tone: discovery.state === "COMPLETE" ? "healthy" : "info",
      detail: `${formatNumber(discovery.candidatesFetched)} of ${formatNumber(discovery.candidateLimit)} candidate records considered.`
    }] : []),
    {
      label: "Internal exclusions", status: excludedCount > 0 ? `${formatNumber(excludedCount)} excluded` : "None", tone: excludedCount > 0 ? "info" : "healthy",
      detail: `Filter mismatch ${formatNumber(summary.excludedByFilter)} · duplicates ${formatNumber(summary.skippedDuplicates)} · cooldown/history ${formatNumber(summary.skippedCooldown)} · unknown delivery ${formatNumber(summary.skippedUnknownDelivery)}.`
    },
    ...(summary.shortfall > 0 ? [{ label: "Target shortfall", status: formatNumber(summary.shortfall), tone: "warning", detail: `Only ${formatNumber(selectedCount)} creators met every filter and safety rule; filters were not weakened.` }] : []),
    ...(summary.truncated ? [{ label: "Candidate pool", status: "Capped", tone: "info", detail: "More Marketplace pages existed; ranking applied only to the fetched pool." }] : []),
    ...(summary.historyIdentityCoverageIncomplete ? [{ label: "Historical identity coverage", status: "Incomplete", tone: "warning", detail: `${formatNumber(summary.unresolvedHistoricalOutboundContacts)} contacts belong to ${formatNumber(summary.unresolvedHistoricalCreators)} IM-only identities. App-originated dedupe remains authoritative.` }] : []),
    ...(summary.gmvMixedCurrency ? [{ label: "GMV currencies", status: "Mixed", tone: "warning", detail: `${currencies}. Values were not compared across currencies and no FX conversion occurred.` }] : []),
    ...(summary.gmvExcludedCurrencyMismatch > 0 ? [{ label: "GMV currency exclusions", status: formatNumber(summary.gmvExcludedCurrencyMismatch), tone: "info", detail: `Candidate values that did not match ${summary.expectedGmvCurrency} were excluded.` }] : []),
    ...(summary.freezeAdjustment > 0 ? [{ label: "Freeze adjustment", status: formatNumber(summary.freezeAdjustment), tone: "warning", detail: "Creators that became ineligible after preview were removed before messages were frozen." }] : []),
    ...(campaign.progress.frozen > 0 ? [{ label: "Production pacing", status: "1 message/sec", tone: "info", detail: `Ideal minimum duration is approximately ${idealDuration}, before retries or provider delays.` }] : [])
  ];
  const formatTimestamp = (value?: string) => value ? new Date(value).toLocaleString() : "—";
  return <div className="page"><Link className="back-link" href="/campaigns"><ArrowLeft size={16}/>Campaigns</Link>
    <header className="page-header"><div>{campaign.productName && <span className="eyebrow">{campaign.productName}</span>}<h1>{campaign.name}</h1><p>{campaign.cooldownDays}-day cooldown · {realData ? `Real Marketplace · GMV context ${summary.expectedGmvCurrency ?? "provider-returned currencies"}` : "Mock Indonesian marketplace · IDR performance"}</p><p className={`outbound-status ${campaign.outboundEnabled ? "live" : "unavailable"}`}>Outbound: {campaign.outboundEnabled ? "LIVE" : "UNAVAILABLE"} · Rate limit: 1 message/sec{!campaign.outboundEnabled && campaign.outboundCapability?.reason ? ` · ${campaign.outboundCapability.reason}` : ""}</p></div><div className="header-actions">{["QUEUED", "RUNNING"].includes(campaign.state) && <button className="button secondary" onClick={() => action("pause")}><Pause size={16}/>Pause</button>}{(["PAUSED", "PAUSE_REQUESTED"].includes(campaign.state) || (campaign.state === "SAFETY_PAUSED" && campaign.safetyPauseReason?.includes("IM quota"))) && <button className="button primary" onClick={() => action("resume")}><Play size={16}/>Resume</button>}{["FROZEN", "QUEUED", "RUNNING", "PAUSED", "PAUSE_REQUESTED", "SAFETY_PAUSED"].includes(campaign.state) && <button className="button secondary" onClick={() => action("cancel")}>Cancel unsent</button>}<span className={`status large ${campaign.state.toLowerCase()}`}>{campaign.state.replaceAll("_", " ")}</span></div></header>
    <section className="metric-strip campaign-metrics"><div><span>Requested</span><strong>{formatNumber(summary.requested ?? campaign.targetCount)}</strong></div><div><span>Eligible</span><strong>{formatNumber(summary.eligible)}</strong></div><div className="accent"><span>Selected</span><strong>{formatNumber(summary.selected)}</strong></div><div><span>Dispatched</span><strong>{formatNumber(campaign.dispatchCount)}</strong></div></section>
    {outboundUnavailable && ["PREVIEW_READY", "FROZEN"].includes(campaign.state) && <div className="alert error"><AlertTriangle/><div><strong>Outbound unavailable</strong><span>{campaign.outboundCapability?.reason ?? "Outbound capability is unavailable."}</span></div></div>}
    {eligibleCount <= 0 && campaign.state === "PREVIEW_READY" && <div className="alert error"><AlertTriangle/><div><strong>No eligible creators are available</strong><span>Review the selected filters or required creator data before sending.</span></div></div>}
    {discovery && ["QUEUED", "RUNNING", "BACKING_OFF"].includes(discovery.state) && campaign.discoveryWorkerState !== "RUNNING" && <div className="alert error"><AlertTriangle/><div><strong>Discovery worker is {campaign.discoveryWorkerState.toLowerCase()}</strong><span>Progress is safely persisted, but automatic Marketplace work will resume only when the production discovery service is running.</span></div></div>}
    {discovery && ["QUEUED", "RUNNING", "BACKING_OFF"].includes(discovery.state) && <div className="workflow-status"><Clock size={15}/><span><strong>{discovery.state === "BACKING_OFF" ? "Marketplace temporarily throttled" : "Building preview"}</strong> · {formatNumber(discovery.candidatesFetched)} / {formatNumber(discovery.candidateLimit)} candidates{discovery.nextAttemptAt ? ` · resumes ${new Date(discovery.nextAttemptAt).toLocaleString()}` : ""}</span></div>}
    {discovery?.state === "FAILED" && <div className="alert error"><AlertTriangle/><div><strong>Discovery failed — operator action required</strong><span>The failure was sanitized as {discovery.failureCategory ?? "provider failure"}.</span></div><button disabled={discovering} className="button secondary" onClick={retryDiscovery}>Retry discovery</button></div>}
    {campaign.state === "DRAFT" && !discovery && <div className="alert error"><AlertTriangle/><div><strong>Creator discovery has not started</strong><span>This legacy campaign has no persisted discovery run.</span></div><button disabled={discovering || cooldownActive} className="button secondary" onClick={retryDiscovery}>{discovering ? "Queueing…" : "Start discovery"}</button></div>}
    {campaign.state === "PREVIEW_EXPIRED" && <div className="alert warning"><Clock/><div><strong>Frozen preview expired</strong><span>Creator reservations were released.</span></div><button className="button secondary" onClick={() => action("discovery-runs")}>Rediscover</button></div>}
    {campaign.state === "SAFETY_PAUSED" && <div className="alert error"><ShieldAlert/><div><strong>Campaign stopped by a provider safety condition</strong><span>{campaign.safetyPauseReason}</span></div></div>}
    {error && <div className="alert error">{error}</div>}
    <details className="data-notes"><summary><span>Data notes · {dataNotes.length}</span><span>Details</span></summary><div className="data-note-list">{dataNotes.map((note) => <div className="data-note" key={note.label}><div><span className={`status ${note.tone}`}>{note.label}</span><strong>{note.status}</strong></div><p>{note.detail}</p></div>)}</div></details>
    {campaign.state === "PREVIEW_READY" && <section className="send-card"><div><h2>Preview ready</h2><p>Press once to freeze exactly {formatNumber(selectedCount)} selected creators, materialize their immutable messages and deliveries, and queue the campaign.</p>{sendReason && <small className="send-reason">Cannot send: {sendReason}</small>}</div><div className="header-actions"><button className="button secondary" onClick={openClone}><Copy size={17}/>Clone campaign</button><button className="button primary" disabled={sendDisabled} onClick={sendCampaign}><Check size={17}/>{sending ? "Starting…" : `Send to ${formatNumber(selectedCount)} affiliates`}</button></div></section>}
    {cloneOpen && <section className="panel clone-panel"><div className="panel-heading"><div><h2>Clone campaign</h2><p>{LOCAL_CLONE_EXPLANATION} The campaign name is generated automatically.</p></div></div><form className="clone-form" onSubmit={submitClone}><div className="form-grid"><label>Target count<input required type="number" min="1" step="1" value={cloneForm.targetCount} onChange={(e) => setCloneForm({ ...cloneForm, targetCount: Number(e.target.value) })}/></label></div><label>Message template<textarea required rows={4} value={cloneForm.messageTemplate} onChange={(e) => setCloneForm({ ...cloneForm, messageTemplate: e.target.value })}/></label><div className="form-actions"><button type="button" className="button secondary" onClick={() => setCloneOpen(false)} disabled={cloning}>Cancel</button><button type="submit" className="button primary" disabled={cloning}>{cloning ? "Cloning…" : "Create PREVIEW_READY clone"}</button></div></form></section>}
    {["PREVIEW_READY", "FROZEN"].includes(campaign.state) && <section className="panel"><div className="panel-heading"><div><h2>Message preview</h2><p>Previewed for {sample?.creator.nickname ?? sample?.creator.username ?? "the first selected creator"}; frozen messages are immutable.</p></div></div><p style={{whiteSpace: "pre-wrap"}}>{messagePreview}</p></section>}
    {campaign.state === "FROZEN" && <section className="panel frozen-send-card"><div><h2>Frozen and ready</h2><p>The recipient set and rendered messages are already frozen. Press once to materialize deliveries and queue the campaign.</p>{sendReason && <small className="send-reason">Cannot send: {sendReason}</small>}</div><button className="button primary" disabled={sendDisabled} onClick={sendCampaign}><Check size={17}/>{sending ? "Starting…" : `Send to ${formatNumber(selectedCount)} affiliates`}</button></section>}
    {campaign.progress.frozen > 0 && <section className="metric-strip"><div><span>Frozen</span><strong>{formatNumber(campaign.progress.frozen)}</strong></div><div className="accent"><span>Completed</span><strong>{formatNumber(campaign.progress.completed)}</strong></div><div><span>Remaining</span><strong>{formatNumber(campaign.progress.remaining)}</strong></div><div><span>Sent</span><strong>{formatNumber(deliveryCounts.SENT)}</strong></div><div><span>Restricted</span><strong>{formatNumber(deliveryCounts.RESTRICTED)}</strong></div><div><span>Failed / unknown</span><strong>{formatNumber((deliveryCounts.FAILED ?? 0) + (deliveryCounts.DELIVERY_UNKNOWN ?? 0) + (deliveryCounts.DELIVERY_UNKNOWN_UNRESOLVED ?? 0))}</strong></div></section>}
    <section className="panel"><div className="panel-heading"><div><h2>Recipients and results</h2><p>Showing {formatNumber(campaign.recipientPage.shown)} of {formatNumber(campaign.recipientPage.total)} recipient rows. The progress totals above always cover the complete frozen campaign.</p></div><button className="icon-button" onClick={load} aria-label="Refresh"><RefreshCw size={17}/></button></div><div className="table-wrap"><table><thead><tr><th>Creator</th><th>Followers</th><th>30-day GMV</th><th>Eligibility</th><th>Delivery status</th><th>Evidence / outcome</th></tr></thead><tbody>{campaign.recipients.map((recipient) => { const attempt = recipient.delivery?.attempts?.[0]; return <tr key={recipient.id}><td><div className="creator"><div className="avatar">{(recipient.creator.nickname ?? recipient.creator.username ?? "?")[0]}</div><div><strong>{recipient.creator.nickname ?? recipient.creator.username ?? "Unknown creator"}</strong><small>{recipient.creator.username ? `@${recipient.creator.username}` : recipient.creator.creatorOpenId}</small></div></div></td><td>{formatNumber(recipient.snapshot?.followerCount)}</td><td>{realData ? formatMoney(recipient.snapshot?.gmvAmount, recipient.snapshot?.gmvCurrency) : formatIdr(recipient.snapshot?.gmvAmount)}</td><td>{recipient.selected ? <span className="pill good"><UserCheck size={14}/>Selected</span> : recipient.eligibility === "ELIGIBLE" ? <span className="pill">Eligible</span> : <span className="pill bad">{recipient.skipReason?.replaceAll("_", " ")}</span>}</td><td><span className={`status ${recipient.state.toLowerCase()}`}>{recipient.state.replaceAll("_", " ")}</span></td><td><small>{recipient.delivery?.externalMessageId ? `Message ${recipient.delivery.externalMessageId}` : recipient.delivery?.lastErrorCode?.replaceAll("_", " ") ?? recipient.skipDetail ?? "—"}</small>{attempt && <><small>Attempt {attempt.attemptNumber} · {formatTimestamp(attempt.startedAt)}</small><small>{attempt.providerHttpStatus != null ? `HTTP ${attempt.providerHttpStatus}` : "HTTP —"}{attempt.providerCode ? ` · TikTok code ${attempt.providerCode}` : ""}</small>{recipient.delivery?.lastErrorDetail && <small>{recipient.delivery.lastErrorDetail}</small>}</>}</td></tr>; })}</tbody></table></div></section>
  </div>;
}
