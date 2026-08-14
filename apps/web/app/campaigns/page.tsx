"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Clock3, Megaphone, Plus, ShieldCheck, Users } from "lucide-react";
import { api, formatNumber } from "../../lib/api";
import { CreatorDatabaseSync } from "../../components/creator-database-sync";

type Campaign = { id: string; name: string; productName: string; targetCount: number; state: string; summary: any; createdAt: string; dispatchCount: number };

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { api<Campaign[]>("/outreach/campaigns").then(setCampaigns).catch((e) => setError(e.message)); }, []);
  return <div className="page">
    <header className="page-header"><div><span className="eyebrow">TikTok Affiliate Outreach</span><h1>Campaign control center</h1><p>Build a qualified creator pool, verify contact safety, then simulate a controlled outreach queue.</p></div><Link className="button primary" href="/campaigns/new"><Plus size={17}/>New campaign</Link></header>
    <section className="stats-grid">
      <div className="stat-card"><Megaphone/><span>Total campaigns</span><strong>{formatNumber(campaigns.length)}</strong></div>
      <div className="stat-card"><Users/><span>Selected creators</span><strong>{formatNumber(campaigns.reduce((s, c) => s + Number(c.summary?.selected ?? 0), 0))}</strong></div>
      <div className="stat-card"><Clock3/><span>Dispatch attempts</span><strong>{formatNumber(campaigns.reduce((s, c) => s + c.dispatchCount, 0))}</strong></div>
      <div className="stat-card safe"><ShieldCheck/><span>Production sends</span><strong>0</strong></div>
    </section>
    <CreatorDatabaseSync/>
    <section className="panel"><div className="panel-heading"><div><h2>Outreach campaigns</h2><p>Every campaign begins with discovery and a frozen preview.</p></div></div>
      {error && <div className="alert error">{error}. Start PostgreSQL, Redis, and the API to load campaigns.</div>}
      {!error && campaigns.length === 0 ? <div className="empty"><div className="empty-icon"><Megaphone/></div><h3>No campaigns yet</h3><p>Create a mock campaign to test discovery, exclusions, confirmation, and queue safety.</p><Link className="button primary" href="/campaigns/new">Create first campaign</Link></div> :
      <div className="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th>Requested</th><th>Eligible</th><th>Selected</th><th>Dispatches</th><th/></tr></thead><tbody>{campaigns.map((campaign) => <tr key={campaign.id}><td><strong>{campaign.name}</strong><small>{campaign.productName}</small></td><td><span className={`status ${campaign.state.toLowerCase()}`}>{campaign.state.replaceAll("_", " ")}</span></td><td>{formatNumber(campaign.targetCount)}</td><td>{formatNumber(campaign.summary?.eligible)}</td><td>{formatNumber(campaign.summary?.selected)}</td><td>{formatNumber(campaign.dispatchCount)}</td><td><Link className="icon-button" href={`/campaigns/${campaign.id}`} aria-label={`Open ${campaign.name}`}><ArrowRight size={18}/></Link></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}
