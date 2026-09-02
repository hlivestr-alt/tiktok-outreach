"use client";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock, Database, Pause, Play, RefreshCw } from "lucide-react";
import { api, ApiError, formatNumber } from "../lib/api";

type SyncEvent = {
  stage: string; pageNumber?: number | null; httpStatus?: number | null; tiktokCode?: string | null;
  googleApiCode?: string | null; retryable?: boolean | null;
  safeMessage?: string | null; creatorsReturned?: number | null; creatorsAdded?: number | null;
  duplicates?: number | null; nextAttemptAt?: string | null; occurredAt: string; partitionKey?: string | null; partitionLabel?: string | null;
};

type SyncStatus = {
  status: "IDLE" | "RUNNING" | "PAUSING" | "PAUSED" | "WAITING" | "EXHAUSTED" | "ALL_PARTITIONS_COMPLETE" | "ERROR";
  currentStage?: string; pagesCompleted: number; creatorsFetched: number; creatorsFetchedThisRun: number; totalCreatorsStored: number;
  startedAt?: string | null; lastPageAt?: string | null; lastSuccessAt?: string | null; lastError?: string | null; nextAttemptAt?: string | null;
  lastAttemptAt?: string | null; lastResponseAt?: string | null; lastAttemptPage?: number | null; lastHttpStatus?: number | null;
  lastTikTokCode?: string | null; lastSafeError?: string | null; lastCreatorsReturned?: number | null;
  lastCreatorsAdded?: number | null; lastDuplicates?: number | null; recentActivity: SyncEvent[];
  marketplaceRetryDelaySeconds: number;
  business16032001RetryCount: number;
  sheetsRetryCount: number; sheetsRetryPage?: number | null; sheetsNextAttemptAt?: string | null;
  sheetsHttpStatus?: number | null; sheetsApiCode?: string | null; sheetsRetryable?: boolean | null; sheetsError?: string | null;
  currentPage: number; databaseStillPopulating: boolean;
  partitionsRemaining: number;
  categoryMetadataReady: boolean;
  categoryCatalog: { loaded: boolean; count: number; lastRefreshedAt?: string | null };
  crawlerGeneration: number;
  schedulerStrategy?: { primaryDiscovery: string; high: string; veryHigh: string };
  currentPartition?: { key: string; category: string; childCategory?: string | null; followers: string; gmv: string; page: number; status: string;
    type: "Base" | "Adaptive"; partitionType: string; depth: number; observedSaturated: boolean; observedSaturationState: string;
    branchClassification: string; schedulerClass?: "HIGH" | "MEDIUM" | "EXPLORATION" | "LOW" | "EXPERIMENT_ONLY" | null;
    priority: number; priorityReason?: string | null; marketplaceRequests: number; throttleAttempts: number;
    rowsReturned: number; uniqueCreatorsAdded: number; duplicates: number; originalYield?: number | null;
    incrementalYield?: number | null; combinedChildIncrementalYield?: number | null;
    newCreatorsPerRequest?: number | null; duplicateRate?: number | null } | null;
};

const label: Record<SyncStatus["status"], string> = {
  IDLE: "Idle", RUNNING: "Fetching", PAUSING: "Pausing safely", PAUSED: "Paused",
  WAITING: "Waiting", EXHAUSTED: "Complete", ALL_PARTITIONS_COMPLETE: "All partitions complete", ERROR: "Error"
};
export const CREATOR_RETRY_SECONDS = 5;
export const DEFAULT_MARKETPLACE_RETRY_SECONDS = 3;

function time(value?: string | null) {
  return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}

export function currentActivity(data: SyncStatus, retrySeconds: number) {
  const page = data.sheetsRetryPage ?? data.lastAttemptPage ?? data.currentPage;
  switch (data.currentStage ?? data.status) {
    case "REQUESTING_TIKTOK": return `Fetching page ${page} from TikTok…`;
    case "STARTING_MARKETPLACE_SEARCH": return "Starting Marketplace search…";
    case "STARTING_PARTITION": case "CLAIMING_PARTITION": return "Pagination exhausted — starting next partition";
    case "PARTITION_SPLIT": return "Dense partition subdivided — starting first child";
    case "DEEPLY_SATURATED": return "Deepest documented partition remains saturated — continuing to the next partition";
    case "PARTITION_COMPLETE": return "Partition complete — starting next partition";
    case "TIKTOK_SUCCESS": return `TikTok returned ${formatNumber(data.lastCreatorsReturned ?? 0)} creators for page ${page} — preparing to save…`;
    case "STAGING_PAGE": return `Durably staging page ${page} before creator reconciliation…`;
    case "SAVING_DATABASE": return `Saving page ${page} to PostgreSQL…`;
    case "SAVING_SHEET": return `Saving page ${page} to Google Sheets…`;
    case "RECONCILING_SHEET": return `Resuming Google Sheets reconciliation for page ${page}…`;
    case "COMMITTING_PAGE": return `Committing page ${page} and validating the cursor…`;
    case "PAGE_COMMITTED": return `Page ${page} committed — moving to page ${data.currentPage}…`;
    case "WAITING_RETRY": return `TikTok throttled — 36009002 — retrying in ${retrySeconds}s`;
    case "WAITING_BUSINESS_RETRY": return `TikTok business error — 16032001 — transient retry ${data.business16032001RetryCount}/10 in ${retrySeconds}s`;
    case "TIKTOK_BUSINESS_RETRY_LIMIT": return `TikTok business error — 16032001 — retry limit reached (${data.business16032001RetryCount}/10). Manual Continue required.`;
    case "WAITING_SHEET_RETRY": return `Google Sheets save failed — retry ${Math.min(10, data.sheetsRetryCount + 1)}/10 in ${retrySeconds}s`;
    case "SHEET_RETRY_LIMIT": return `Google Sheets save failed — retry limit reached (${data.sheetsRetryCount}/10). Manual Continue required.`;
    case "PAUSING": return "Finishing the in-flight page, then pausing…";
    case "PAUSED": return `Paused at page ${data.currentPage} — no retry is scheduled.`;
    case "GMV_ALL_DISABLED_BY_STRATEGY": return "Paused — the historical GMV-All continuation is disabled by the new search strategy.";
    case "TIKTOK_ERROR": return `TikTok request for page ${page} failed.`;
    case "PARTITION_CONFIG_ERROR": return `Partition configuration is invalid — no TikTok request was sent.`;
    case "DATABASE_ERROR": return data.lastSafeError ?? `PostgreSQL failed while saving page ${page}. Page remains uncommitted.`;
    case "SHEET_ERROR": return data.lastSafeError ?? `Google Sheets failed while saving page ${page}.`;
    case "CURSOR_ERROR": return `Page ${page} was not committed because the cursor could not advance safely.`;
    case "ALL_PARTITIONS_COMPLETE": return "All Marketplace partitions are complete.";
    case "EXHAUSTED": return "All Marketplace partitions are complete.";
    case "ERROR": case "SYNC_ERROR": return `Page ${page} needs attention.`;
    default: return `Preparing to fetch page ${data.currentPage}…`;
  }
}

export function eventText(event: SyncEvent, marketplaceRetrySeconds = DEFAULT_MARKETPLACE_RETRY_SECONDS) {
  const page = event.pageNumber == null ? "" : `Page ${event.pageNumber} `;
  const code = event.tiktokCode ? ` — ${event.tiktokCode}` : "";
  const prefix = event.partitionLabel ? `${event.partitionLabel} — ` : "";
  switch (event.stage) {
    case "PARTITION_STARTED": return `${prefix}${event.safeMessage ?? "starting Marketplace search"}`;
    case "PARTITION_EXHAUSTED": return `${prefix}page ${event.pageNumber} exhausted`;
    case "PARTITION_SATURATED": case "OBSERVED_SATURATED": return `${prefix}${event.safeMessage ?? "empirically observed saturated"}`;
    case "FOLLOWER_CHILDREN_CREATED": case "ADAPTIVE_SPLIT_CREATED": return `${prefix}${event.safeMessage ?? "adaptive split created"}`;
    case "GMV_CHILDREN_CREATED": case "ADAPTIVE_GMV_CREATED": return `${prefix}${event.safeMessage ?? "documented GMV children queued"}`;
    case "ADAPTIVE_BRANCH_LOW_VALUE": return `${prefix}${event.safeMessage ?? "branch low-value — follower recursion stopped"}`;
    case "DEEPLY_SATURATED": return `${prefix}marked deeply saturated`;
    case "REQUESTING_TIKTOK": case "STARTING_MARKETPLACE_SEARCH": return `${prefix}${page}requested from TikTok`;
    case "TIKTOK_THROTTLED": return `${page}TikTok throttled — ${event.tiktokCode ?? "36009002"} — retrying in ${marketplaceRetrySeconds}s`;
    case "TIKTOK_BUSINESS_RETRY": case "TIKTOK_BUSINESS_RETRY_LIMIT": return `${page}${event.safeMessage ?? `TikTok business error${code}`}`;
    case "TIKTOK_ERROR": return `${page}TikTok error${code}`;
    case "TIKTOK_SUCCESS": return `${page}TikTok success — ${formatNumber(event.creatorsReturned ?? 0)} returned`;
    case "STAGING_PAGE": return `${page}durably staging successful response`;
    case "SAVING_DATABASE": return `${page}saving to PostgreSQL`;
    case "SAVING_SHEET": return `${page}saving to Google Sheets`;
    case "COMMITTING_PAGE": return `${page}committing cursor and progress`;
    case "PAGE_COMMITTED": return `${page}committed — ${formatNumber(event.creatorsReturned ?? 0)} returned, ${formatNumber(event.creatorsAdded ?? 0)} new, ${formatNumber(event.duplicates ?? 0)} duplicate`;
    case "CURSOR_ADVANCED": return event.safeMessage ?? `Continuing to page ${event.pageNumber}`;
    case "DATABASE_ERROR": return `${page}${event.safeMessage ?? "PostgreSQL save failed; Page remains uncommitted"}`;
    case "SHEET_RETRY": case "SHEET_ERROR": case "SHEET_RETRY_LIMIT": return event.safeMessage ?? `${page}Google Sheets save failed`;
    case "SHEET_RECOVERED": return `${page}Google Sheets save recovered`;
    case "CURSOR_ERROR": return `${page}cursor did not advance`;
    case "PAUSE_REQUESTED": return "Pause requested";
    case "PAUSED": return `${page}sync paused`;
    case "GMV_ALL_DISABLED_BY_STRATEGY": return `${prefix}${event.safeMessage ?? "historical GMV-All work disabled by strategy; cursor and history preserved"}`;
    case "GMV_STRATEGY_MIGRATED": return event.safeMessage ?? "Creator Database migrated to specific-GMV partitions";
    case "SYNC_RESUMED": return `${page}sync resumed`;
    case "SYNC_STARTED": return `${page}sync started`;
    case "EXHAUSTED": return "Pagination exhausted";
    case "CATEGORY_REFRESH_STARTED": return "Category metadata refresh started";
    case "CATEGORY_REFRESH_SUCCESS": return event.safeMessage ?? "Category metadata refreshed";
    case "CATEGORY_REFRESH_FAILED": return `${event.safeMessage ?? "Category metadata refresh failed"}${code}`;
    default: return event.safeMessage ?? event.stage.replaceAll("_", " ").toLowerCase();
  }
}

export function CreatorDatabaseSync({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<SyncStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryDelayInput, setRetryDelayInput] = useState<string>();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const load = useCallback(() => api<SyncStatus>("/outreach/creator-database").then((value) => { setData(value); setError(""); }).catch((reason) => setError(reason.message)), []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { const timer = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(timer); }, []);
  async function action(name: "pause" | "resume" | "categories/refresh") {
    setBusy(true); setError("");
    try { setData(await api<SyncStatus>(`/outreach/creator-database/${name}`, { method: "POST" })); }
    catch (reason) {
      if (reason instanceof ApiError && name === "categories/refresh") {
        const code = reason.details.providerCode == null ? "—" : String(reason.details.providerCode);
        setError(`Category refresh failed — HTTP ${reason.status}, TikTok code ${code}: ${reason.message}`);
      } else setError(reason instanceof Error ? reason.message : "Creator sync action failed");
    }
    finally { setBusy(false); }
  }
  async function saveRetryDelay() {
    if (!data) return;
    const value = Number(retryDelayInput ?? data.marketplaceRetryDelaySeconds);
    if (!Number.isInteger(value) || value < 1) {
      setError("Marketplace retry delay must be an integer of at least 1 second");
      return;
    }
    setBusy(true); setError("");
    try {
      const updated = await api<SyncStatus>("/outreach/creator-database/retry-delay", {
        method: "POST", body: JSON.stringify({ marketplaceRetryDelaySeconds: value })
      });
      setData(updated); setRetryDelayInput(String(updated.marketplaceRetryDelaySeconds));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Marketplace retry delay could not be saved");
    } finally { setBusy(false); }
  }
  if (!data && !error) return <section className="panel creator-db-card"><div className="loading">Loading creator database…</div></section>;
  if (!data) return <div className="alert error"><AlertTriangle/><div><strong>Creator database unavailable</strong><span>{error}</span></div></div>;
  const retrySeconds = data.nextAttemptAt ? Math.max(0, Math.ceil((new Date(data.nextAttemptAt).getTime() - nowMs) / 1000)) : CREATOR_RETRY_SECONDS;
  const retryDelayValue = Number(retryDelayInput ?? data.marketplaceRetryDelaySeconds);
  const sheetsStage = data.currentStage?.includes("SHEET") || data.currentStage === "WAITING_SHEET_RETRY" || data.sheetsRetryPage != null;
  if (compact) return <div className="creator-db-compact"><Database/><div><strong>Creator database: {formatNumber(data.totalCreatorsStored)} creators</strong><span>Last updated: {data.lastSuccessAt ? new Date(data.lastSuccessAt).toLocaleString() : "existing Sheet import pending"} · Sync: {label[data.status]}{data.databaseStillPopulating ? " · still being populated" : ""}</span></div></div>;
  const lastOutcome = data.lastSafeError
    ? sheetsStage ? `Google Sheets ${data.sheetsRetryable === false ? "non-retryable failure" : "failure"}`
      : data.lastTikTokCode === "36009002" ? "Throttled by TikTok (36009002)"
      : data.lastTikTokCode === "16032001" && data.status === "WAITING" ? `Transient business error (16032001), retry ${data.business16032001RetryCount}/10`
      : "Failed"
    : data.lastResponseAt ? "Success" : data.lastAttemptAt ? "Request in progress" : "No recorded attempt";
  return <section className="panel creator-db-card">
    <div className="panel-heading"><div><span className="eyebrow">Creator database</span><h2>{label[data.status]}</h2><p>Outreach filters the stored database while this independent continuation job adds more creators.</p></div><div className="header-actions"><span className={`status large ${data.status.toLowerCase()}`}>{label[data.status]}</span>{["RUNNING", "PAUSING", "WAITING"].includes(data.status) ? <button disabled={busy || data.status === "PAUSING"} className="button secondary" onClick={() => action("pause")}><Pause size={16}/>Pause</button> : !data.categoryMetadataReady ? <button disabled={busy || data.status !== "PAUSED"} className="button primary" onClick={() => action("categories/refresh")}><RefreshCw size={16}/>Refresh categories</button> : !["EXHAUSTED", "ALL_PARTITIONS_COMPLETE"].includes(data.status) ? <button disabled={busy} className="button primary" onClick={() => action("resume")}><Play size={16}/>Continue</button> : null}<button className="icon-button" onClick={load} aria-label="Refresh creator database"><RefreshCw size={16}/></button></div></div>
    <div className="creator-db-metrics"><div><span>Unique creators stored</span><strong>{formatNumber(data.totalCreatorsStored)}</strong></div><div><span>Pages completed</span><strong>{formatNumber(data.pagesCompleted)}</strong></div><div><span>Fetched this run</span><strong>{formatNumber(data.creatorsFetchedThisRun)}</strong></div><div><span>Partition page</span><strong>{formatNumber(data.currentPage)}</strong></div><div><span>Partitions remaining</span><strong>{formatNumber(data.partitionsRemaining)}</strong></div><div><span>Last successful fetch</span><strong>{data.lastSuccessAt ? new Date(data.lastSuccessAt).toLocaleString() : "—"}</strong></div></div>
    <div className="creator-db-retry-setting"><label htmlFor="marketplace-retry-delay">Marketplace retry delay:<span className="creator-db-retry-controls"><input id="marketplace-retry-delay" type="number" min={1} step={1} inputMode="numeric" value={retryDelayInput ?? data.marketplaceRetryDelaySeconds} onChange={(event) => setRetryDelayInput(event.target.value)} /><span>seconds</span><button type="button" className="button secondary" disabled={busy || !Number.isInteger(retryDelayValue) || retryDelayValue < 1} onClick={saveRetryDelay}>Save</button></span></label></div>
    {data.schedulerStrategy && <div className="creator-db-attempt-grid"><div><span>Primary discovery</span><strong>{data.schedulerStrategy.primaryDiscovery}</strong></div><div><span>High</span><strong>{data.schedulerStrategy.high}</strong></div><div><span>Very High</span><strong>{data.schedulerStrategy.veryHigh}</strong></div></div>}
    <div className="creator-db-attempt-grid"><div><span>Category catalog</span><strong>{data.categoryCatalog.loaded ? "Loaded" : "Not loaded"}</strong></div><div><span>Categories</span><strong>{formatNumber(data.categoryCatalog.count)}</strong></div><div><span>Last refreshed</span><strong>{data.categoryCatalog.lastRefreshedAt ? new Date(data.categoryCatalog.lastRefreshedAt).toLocaleString() : "—"}</strong></div></div>
    {data.currentPartition && <div className="creator-db-attempt-grid"><div><span>Category</span><strong>{data.currentPartition.category}{data.currentPartition.childCategory ? ` → ${data.currentPartition.childCategory}` : ""}</strong></div><div><span>Followers</span><strong>{data.currentPartition.followers}</strong></div><div><span>GMV</span><strong>{data.currentPartition.gmv}</strong></div><div><span>Partition</span><strong>{data.currentPartition.type} · depth {data.currentPartition.depth}</strong></div><div><span>Page</span><strong>{data.currentPartition.page}</strong></div><div><span>Observed saturated</span><strong>{data.currentPartition.observedSaturationState === "UNKNOWN" ? "—" : data.currentPartition.observedSaturated ? "Yes" : "No"}</strong></div><div><span>Incremental yield</span><strong>{data.currentPartition.incrementalYield == null ? "—" : `${(data.currentPartition.incrementalYield * 100).toFixed(1)}%`}</strong></div><div><span>New / actual attempt</span><strong>{data.currentPartition.newCreatorsPerRequest == null ? "—" : data.currentPartition.newCreatorsPerRequest.toFixed(2)}</strong></div><div><span>Scheduler</span><strong>{data.currentPartition.schedulerClass ?? "Legacy claim"}</strong></div><div><span>Priority</span><strong>{data.currentPartition.priority.toFixed(1)}</strong></div><div><span>Reason</span><strong>{data.currentPartition.priorityReason ?? "—"}</strong></div><div><span>Branch</span><strong>{data.currentPartition.branchClassification.replaceAll("_", " ")}</strong></div></div>}
    <div className="creator-db-observability">
      <div className="creator-db-live">
        <span className="eyebrow">Current activity</span>
        <h3>{currentActivity(data, retrySeconds)}</h3>
        <div className="creator-db-attempt-grid">
          <div><span>Last attempt</span><strong>{time(data.lastAttemptAt)} — {lastOutcome}</strong></div>
          <div><span>Page attempted</span><strong>{data.lastAttemptPage ?? "—"}</strong></div>
          <div><span>Last request sent</span><strong>{time(data.lastAttemptAt)}</strong></div>
          <div><span>Last response received</span><strong>{time(data.lastResponseAt)}</strong></div>
          <div><span>Next attempt</span><strong>{data.nextAttemptAt ? `${time(data.nextAttemptAt)} (${retrySeconds}s)` : "Not scheduled"}</strong></div>
          <div><span>Last page result</span><strong>{data.lastCreatorsReturned == null ? "—" : `${data.lastCreatorsReturned} returned / ${data.lastCreatorsAdded ?? 0} added / ${data.lastDuplicates ?? 0} duplicate`}</strong></div>
        </div>
        {data.lastSafeError && <div className="creator-db-error"><strong>{sheetsStage ? "Google Sheets save failed" : "TikTok Marketplace request failed"}</strong><span>Page: {data.sheetsRetryPage ?? data.lastAttemptPage ?? data.currentPage}</span>{sheetsStage ? <><span>HTTP: {data.sheetsHttpStatus ?? "—"}</span><span>Google API code: {data.sheetsApiCode ?? "—"}</span><span>Classification: {data.sheetsRetryable == null ? "—" : data.sheetsRetryable ? "retryable" : "non-retryable"}</span></> : <><span>HTTP: {data.lastHttpStatus ?? "—"}</span><span>TikTok code: {data.lastTikTokCode ?? "—"}</span></>}<span>Message: {data.lastSafeError}</span><span>Attempt: {time(data.lastAttemptAt)}</span>{data.nextAttemptAt && <span>Retrying in: {retrySeconds}s</span>}</div>}
      </div>
      <div className="creator-db-activity">
        <span className="eyebrow">Recent activity</span>
        {data.recentActivity.length ? <ol>{data.recentActivity.map((event, index) => <li key={`${event.occurredAt}-${index}`}><time>{time(event.occurredAt)}</time><span>{eventText(event, data.marketplaceRetryDelaySeconds)}</span></li>)}</ol> : <p>No durable activity events recorded yet.</p>}
      </div>
    </div>
    {data.status === "WAITING" && data.currentStage === "WAITING_SHEET_RETRY" && <div className="alert warning"><Clock/><div><strong>Google Sheets save failed — retry {Math.min(10, data.sheetsRetryCount + 1)}/10 in {retrySeconds}s</strong><span>The successful TikTok page remains durably staged. No new TikTok request will be made until Google Sheets succeeds.</span></div></div>}
    {data.status === "WAITING" && data.currentStage !== "WAITING_SHEET_RETRY" && <div className="alert warning"><Clock/><div><strong>{data.lastTikTokCode === "16032001" ? `TikTok business error — 16032001 — transient retry ${data.business16032001RetryCount}/10 in ${retrySeconds}s` : `TikTok throttled — 36009002 — retrying in ${retrySeconds}s`}</strong><span>The partition filters and continuation cursor are preserved. The exact same page will retry automatically while sync remains active.</span></div></div>}
    {data.currentStage === "TIKTOK_BUSINESS_RETRY_LIMIT" && <div className="alert error"><AlertTriangle/><div><strong>TikTok business error retry limit reached (10/10)</strong><span>The crawler is paused with its partition, filters, and cursor preserved. Manual Continue starts a new retry window for this same page.</span></div></div>}
    {data.currentStage === "SHEET_RETRY_LIMIT" && <div className="alert error"><AlertTriangle/><div><strong>Google Sheets retry limit reached ({data.sheetsRetryCount}/10)</strong><span>The crawler is paused with the staged page and cursor preserved. Manual Continue retries Sheets from that staged page; TikTok will not be requested first.</span></div></div>}
    {data.currentStage === "SHEET_ERROR" && data.status === "PAUSED" && <div className="alert error"><AlertTriangle/><div><strong>Google Sheets failure paused the crawler</strong><span>The staged page is preserved. Fix the spreadsheet configuration or permission, then use Continue to retry Sheets only.</span></div></div>}
    {!data.categoryMetadataReady && <div className="alert warning"><AlertTriangle/><div><strong>Marketplace category metadata is required</strong><span>Configure the separate category-metadata TikTok credentials, then refresh categories. Creator searches will continue using the Outreach app.</span></div></div>}
    {["EXHAUSTED", "ALL_PARTITIONS_COMPLETE"].includes(data.status) && <div className="alert neutral"><Database/><div><strong>All Marketplace partitions complete</strong><span>No queued or active partition remains.</span></div></div>}
    {data.status === "ERROR" && <div className="alert error"><AlertTriangle/><div><strong>Creator sync needs attention</strong><span>{data.lastError ?? "Unknown safe error"}</span></div></div>}
    {error && <div className="alert error">{error}</div>}
  </section>;
}
