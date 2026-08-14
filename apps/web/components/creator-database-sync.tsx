"use client";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock, Database, Pause, Play, RefreshCw } from "lucide-react";
import { api, formatNumber } from "../lib/api";

type SyncEvent = {
  stage: string; pageNumber?: number | null; httpStatus?: number | null; tiktokCode?: string | null;
  safeMessage?: string | null; creatorsReturned?: number | null; creatorsAdded?: number | null;
  duplicates?: number | null; nextAttemptAt?: string | null; occurredAt: string;
};

type SyncStatus = {
  status: "IDLE" | "RUNNING" | "PAUSING" | "PAUSED" | "WAITING" | "EXHAUSTED" | "ERROR";
  currentStage?: string; pagesCompleted: number; creatorsFetched: number; creatorsFetchedThisRun: number; totalCreatorsStored: number;
  startedAt?: string | null; lastPageAt?: string | null; lastSuccessAt?: string | null; lastError?: string | null; nextAttemptAt?: string | null;
  lastAttemptAt?: string | null; lastResponseAt?: string | null; lastAttemptPage?: number | null; lastHttpStatus?: number | null;
  lastTikTokCode?: string | null; lastSafeError?: string | null; lastCreatorsReturned?: number | null;
  lastCreatorsAdded?: number | null; lastDuplicates?: number | null; recentActivity: SyncEvent[];
  currentPage: number; databaseStillPopulating: boolean;
};

const label: Record<SyncStatus["status"], string> = {
  IDLE: "Idle", RUNNING: "Fetching", PAUSING: "Pausing safely", PAUSED: "Paused",
  WAITING: "Waiting", EXHAUSTED: "Exhausted", ERROR: "Error"
};
export const CREATOR_RETRY_SECONDS = 5;

function time(value?: string | null) {
  return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}

export function currentActivity(data: SyncStatus, retrySeconds: number) {
  const page = data.lastAttemptPage ?? data.currentPage;
  switch (data.currentStage ?? data.status) {
    case "REQUESTING_TIKTOK": return `Fetching page ${page} from TikTok…`;
    case "TIKTOK_SUCCESS": return `TikTok returned ${formatNumber(data.lastCreatorsReturned ?? 0)} creators for page ${page} — preparing to save…`;
    case "SAVING_DATABASE": return `Saving page ${page} to PostgreSQL…`;
    case "SAVING_SHEET": return `Saving page ${page} to Google Sheets…`;
    case "COMMITTING_PAGE": return `Committing page ${page} and validating the cursor…`;
    case "PAGE_COMMITTED": return `Page ${page} committed — moving to page ${data.currentPage}…`;
    case "WAITING_RETRY": return `TikTok throttled page ${page} — retrying in ${retrySeconds}s`;
    case "PAUSING": return "Finishing the in-flight page, then pausing…";
    case "PAUSED": return `Paused at page ${data.currentPage} — no retry is scheduled.`;
    case "TIKTOK_ERROR": return `TikTok request for page ${page} failed.`;
    case "DATABASE_ERROR": return `PostgreSQL failed while saving page ${page}.`;
    case "SHEET_ERROR": return `Google Sheets failed while saving page ${page}.`;
    case "CURSOR_ERROR": return `Page ${page} was not committed because the cursor could not advance safely.`;
    case "EXHAUSTED": return "The current TikTok pagination sequence is exhausted.";
    case "ERROR": case "SYNC_ERROR": return `Page ${page} needs attention.`;
    default: return `Preparing to fetch page ${data.currentPage}…`;
  }
}

export function eventText(event: SyncEvent) {
  const page = event.pageNumber == null ? "" : `Page ${event.pageNumber} `;
  const code = event.tiktokCode ? ` — ${event.tiktokCode}` : "";
  switch (event.stage) {
    case "REQUESTING_TIKTOK": return `${page}requested from TikTok`;
    case "TIKTOK_THROTTLED": return `${page}throttled${code}`;
    case "TIKTOK_ERROR": return `${page}TikTok error${code}`;
    case "TIKTOK_SUCCESS": return `${page}TikTok success — ${formatNumber(event.creatorsReturned ?? 0)} returned`;
    case "SAVING_DATABASE": return `${page}saving to PostgreSQL`;
    case "SAVING_SHEET": return `${page}saving to Google Sheets`;
    case "COMMITTING_PAGE": return `${page}committing cursor and progress`;
    case "PAGE_COMMITTED": return `${page}saved — ${formatNumber(event.creatorsReturned ?? 0)} returned, ${formatNumber(event.creatorsAdded ?? 0)} new, ${formatNumber(event.duplicates ?? 0)} duplicate`;
    case "CURSOR_ADVANCED": return `Cursor advanced to page ${event.pageNumber}`;
    case "DATABASE_ERROR": return `${page}PostgreSQL save failed`;
    case "SHEET_ERROR": return `${page}Google Sheets save failed`;
    case "CURSOR_ERROR": return `${page}cursor did not advance`;
    case "PAUSE_REQUESTED": return "Pause requested";
    case "PAUSED": return `${page}sync paused`;
    case "SYNC_RESUMED": return `${page}sync resumed`;
    case "SYNC_STARTED": return `${page}sync started`;
    case "EXHAUSTED": return "Pagination exhausted";
    default: return event.safeMessage ?? event.stage.replaceAll("_", " ").toLowerCase();
  }
}

export function CreatorDatabaseSync({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<SyncStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const load = useCallback(() => api<SyncStatus>("/outreach/creator-database").then((value) => { setData(value); setError(""); }).catch((reason) => setError(reason.message)), []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { const timer = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(timer); }, []);
  async function action(name: "pause" | "resume") {
    setBusy(true); setError("");
    try { setData(await api<SyncStatus>(`/outreach/creator-database/${name}`, { method: "POST" })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Creator sync action failed"); }
    finally { setBusy(false); }
  }
  if (!data && !error) return <section className="panel creator-db-card"><div className="loading">Loading creator database…</div></section>;
  if (!data) return <div className="alert error"><AlertTriangle/><div><strong>Creator database unavailable</strong><span>{error}</span></div></div>;
  const retrySeconds = data.nextAttemptAt ? Math.max(0, Math.ceil((new Date(data.nextAttemptAt).getTime() - nowMs) / 1000)) : CREATOR_RETRY_SECONDS;
  if (compact) return <div className="creator-db-compact"><Database/><div><strong>Creator database: {formatNumber(data.totalCreatorsStored)} creators</strong><span>Last updated: {data.lastSuccessAt ? new Date(data.lastSuccessAt).toLocaleString() : "existing Sheet import pending"} · Sync: {label[data.status]}{data.databaseStillPopulating ? " · still being populated" : ""}</span></div></div>;
  const lastOutcome = data.lastSafeError
    ? data.lastTikTokCode === "36009002" || data.status === "WAITING" ? `Throttled by TikTok${data.lastTikTokCode ? ` (${data.lastTikTokCode})` : ""}` : "Failed"
    : data.lastResponseAt ? "Success" : data.lastAttemptAt ? "Request in progress" : "No recorded attempt";
  return <section className="panel creator-db-card">
    <div className="panel-heading"><div><span className="eyebrow">Creator database</span><h2>{label[data.status]}</h2><p>Outreach filters the stored database while this independent continuation job adds more creators.</p></div><div className="header-actions"><span className={`status large ${data.status.toLowerCase()}`}>{label[data.status]}</span>{["RUNNING", "PAUSING", "WAITING"].includes(data.status) ? <button disabled={busy || data.status === "PAUSING"} className="button secondary" onClick={() => action("pause")}><Pause size={16}/>Pause</button> : data.status !== "EXHAUSTED" ? <button disabled={busy} className="button primary" onClick={() => action("resume")}><Play size={16}/>Continue</button> : null}<button className="icon-button" onClick={load} aria-label="Refresh creator database"><RefreshCw size={16}/></button></div></div>
    <div className="creator-db-metrics"><div><span>Unique creators stored</span><strong>{formatNumber(data.totalCreatorsStored)}</strong></div><div><span>Pages completed</span><strong>{formatNumber(data.pagesCompleted)}</strong></div><div><span>Fetched this run</span><strong>{formatNumber(data.creatorsFetchedThisRun)}</strong></div><div><span>Next page</span><strong>{formatNumber(data.currentPage)}</strong></div><div><span>Last page fetched</span><strong>{time(data.lastPageAt)}</strong></div><div><span>Last successful fetch</span><strong>{data.lastSuccessAt ? new Date(data.lastSuccessAt).toLocaleString() : "—"}</strong></div></div>
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
        {data.lastSafeError && <div className="creator-db-error"><strong>TikTok Marketplace request failed</strong><span>Page: {data.lastAttemptPage ?? data.currentPage}</span><span>HTTP: {data.lastHttpStatus ?? "—"}</span><span>TikTok code: {data.lastTikTokCode ?? "—"}</span><span>Message: {data.lastSafeError}</span><span>Attempt: {time(data.lastAttemptAt)}</span>{data.nextAttemptAt && <span>Retrying in: {retrySeconds}s</span>}</div>}
      </div>
      <div className="creator-db-activity">
        <span className="eyebrow">Recent activity</span>
        {data.recentActivity.length ? <ol>{data.recentActivity.map((event, index) => <li key={`${event.occurredAt}-${index}`}><time>{time(event.occurredAt)}</time><span>{eventText(event)}</span></li>)}</ol> : <p>No durable activity events recorded yet.</p>}
      </div>
    </div>
    {data.status === "WAITING" && <div className="alert warning"><Clock/><div><strong>Rate limited — retrying in {retrySeconds}s</strong><span>The continuation cursor is preserved. The exact same page will retry automatically while sync remains active.</span></div></div>}
    {data.status === "EXHAUSTED" && <div className="alert neutral"><Database/><div><strong>Current pagination exhausted</strong><span>No fresh Marketplace search was started.</span></div></div>}
    {data.status === "ERROR" && <div className="alert error"><AlertTriangle/><div><strong>Creator sync needs attention</strong><span>{data.lastError ?? "Unknown safe error"}</span></div></div>}
    {error && <div className="alert error">{error}</div>}
  </section>;
}
