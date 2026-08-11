"use client";
import { ChangeEvent, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, FileUp, History, RefreshCw, ShieldX } from "lucide-react";
import { api, formatNumber } from "../../lib/api";

export default function HistoryPage() {
  const [data, setData] = useState<any>();
  const [contacts, setContacts] = useState<any[]>([]);
  const [csv, setCsv] = useState("");
  const [sourceName, setSourceName] = useState("historical-outreach.csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => Promise.all([api("/contact-history/readiness"), api<any[]>("/contact-history")])
    .then(([readiness, ledger]) => { setData(readiness); setContacts(ledger); })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  async function sync() {
    setBusy(true); setError("");
    try { await api("/contact-history/sync-runs", { method: "POST", body: "{}" }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Sync failed"); }
    setBusy(false);
  }
  function file(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0]; if (!selected) return;
    setSourceName(selected.name); selected.text().then(setCsv);
  }
  async function upload() {
    setBusy(true); setError("");
    try { await api("/contact-history/imports", { method: "POST", body: JSON.stringify({ sourceName, csv }) }); setCsv(""); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Import failed"); }
    setBusy(false);
  }
  const real = data?.mode === "READ_ONLY";
  const coverage = data?.identityCoverage ?? {};
  return <div className="page">
    <header className="page-header"><div><span className="eyebrow">History integrity</span><h1>Historical-contact readiness</h1><p>Pagination completeness and identity coverage are evaluated separately.</p></div><button className="button primary" disabled={busy} onClick={sync}><RefreshCw size={17}/>{busy ? "Synchronizing…" : `Run ${real ? "real read-only" : "mock"} TikTok sync`}</button></header>
    {data?.warning && <div className="alert warning"><AlertTriangle/><div><strong>{data.warning}</strong><span>Some TikTok conversation-history identities cannot yet be safely linked to Creator Marketplace identities. These records are preserved and will not be guessed or discarded.</span></div></div>}
    <div className="readiness-grid">
      <section className={`readiness-card ${data?.futureOutboundSafe ? "ready" : "blocked"}`}>{data?.futureOutboundSafe ? <CheckCircle2/> : <ShieldX/>}<div><span>Cooldown / dedupe coverage</span><h2>{data?.futureOutboundSafe ? "Complete" : "Incomplete"}</h2><p>{real ? "Analysis preview may remain usable; real outbound is disabled." : "Mock dispatch remains fail-closed on incomplete coverage."}</p></div></section>
      <section className="readiness-card"><Database/><div><span>Conversations scanned</span><h2>{formatNumber(data?.latestSync?.conversationsScanned)}</h2><p>{formatNumber(data?.latestSync?.messagesImported)} messages imported; pagination {data?.historyPaginationComplete ? "complete" : "incomplete"}.</p></div></section>
      <section className="readiness-card"><History/><div><span>Identity coverage</span><h2>{formatNumber(coverage.fullyLinkedHistoricalCreators)} / {formatNumber(coverage.totalHistoricalCreators)}</h2><p>{coverage.percent ?? 0}% of historical creators linked to Marketplace identity.</p></div></section>
    </div>
    <section className="panel"><div className="panel-heading"><div><h2>Identity coverage details</h2><p>Provider namespaces remain separate until exact evidence supports a link.</p></div><ShieldX/></div><div className="setting-rows"><div><span>Historical creators</span><strong>{formatNumber(coverage.totalHistoricalCreators)}</strong></div><div><span>Linked creator identities</span><strong>{formatNumber(coverage.fullyLinkedHistoricalCreators)}</strong></div><div><span>Unresolved IM-only identities</span><strong>{formatNumber(coverage.imOnlyHistoricalCreators)}</strong></div><div><span>Unresolved provider identities</span><strong>{formatNumber(coverage.unresolvedCreatorIdentities)}</strong></div><div><span>Outbound contacts on unresolved identities</span><strong>{formatNumber(coverage.outboundContactsOnUnresolvedIdentities)}</strong></div><div><span>Discovery usable for analysis</span><strong>{data?.discoveryUsableForAnalysis ? "YES" : "NO"}</strong></div><div><span>Future outbound-safe</span><strong>{data?.futureOutboundSafe ? "YES" : "NO"}</strong></div></div></section>
    {error && <div className="alert error">{error}</div>}
    <section className="content-grid"><div className="panel"><div className="panel-heading"><div><h2>Import existing outreach CSV</h2><p>Requires contacted_at plus creator_open_id or conversation_id.</p></div><FileUp/></div><label className="file-drop"><input type="file" accept=".csv,text/csv" onChange={file}/><FileUp/><strong>Choose a CSV file</strong><span>The file is processed only by this localhost application.</span></label>{csv && <><div className="code-preview">{csv.split("\n").slice(0, 6).join("\n")}</div><button disabled={busy} className="button primary" onClick={upload}>Import {sourceName}</button></>}</div>
      <div className="panel"><div className="panel-heading"><div><h2>Readiness blockers</h2><p>Every condition remains fail-closed.</p></div><AlertTriangle/></div><ul className="blocker-list">{(data?.blockers ?? ["Load readiness to inspect blockers"]).map((blocker: string) => <li key={blocker}><span/><div>{blocker}</div></li>)}</ul></div></section>
    <section className="panel"><div className="panel-heading"><div><h2>Recent imports</h2><p>Idempotent source hashes prevent duplicate contact counts.</p></div></div>{!data?.imports?.length ? <div className="empty small"><p>No CSV imports yet.</p></div> : <div className="table-wrap"><table><thead><tr><th>Source</th><th>Status</th><th>Rows</th><th>Imported</th><th>Unmatched</th><th>Conflicts</th></tr></thead><tbody>{data.imports.map((item: any) => <tr key={item.id}><td><strong>{item.sourceName}</strong></td><td><span className={`status ${item.state.toLowerCase()}`}>{item.state}</span></td><td>{item.rowCount}</td><td>{item.importedCount}</td><td>{item.unmatchedCount}</td><td>{item.conflictCount}</td></tr>)}</tbody></table></div>}</section>
    <section className="panel"><div className="panel-heading"><div><h2>Creator contact ledger</h2><p>IM-only records remain visible without being mislabeled as Marketplace creators.</p></div><History/></div>{!contacts.length ? <div className="empty small"><p>No creator contacts yet.</p></div> : <div className="table-wrap"><table><thead><tr><th>Creator</th><th>Identity coverage</th><th>First contacted</th><th>Last contacted</th><th>Count</th><th>Send state</th><th>Reply</th></tr></thead><tbody>{contacts.map((item: any) => <tr key={item.id}><td><strong>{item.nickname ?? item.username ?? "Unknown creator"}</strong><small>{item.creatorOpenId ? "Marketplace identity present" : "Conversation-history identity only"}</small></td><td><span className={`pill ${item.identityCoverage === "LINKED_TO_MARKETPLACE" ? "good" : "bad"}`}>{item.identityCoverage.replaceAll("_", " ")}</span></td><td>{item.firstContactedAt ? new Date(item.firstContactedAt).toLocaleString() : "—"}</td><td>{item.lastContactedAt ? new Date(item.lastContactedAt).toLocaleString() : "—"}</td><td>{formatNumber(item.contactCount)}</td><td><strong>{item.lastCampaign ?? "Historical import"}</strong><small>{item.unresolvedDelivery ? "DELIVERY UNKNOWN — REVIEW" : item.sendStatus}</small></td><td><span className={`status ${String(item.replyStatus).toLowerCase()}`}>{item.replyStatus}</span></td></tr>)}</tbody></table></div>}</section>
  </div>;
}
