import { CreatorDatabaseSync } from "../components/creator-database-sync";

export default function CreatorDatabasePage() {
  return <div className="page"><header className="page-header"><div><span className="eyebrow">Creator workflow</span><h1>Creator Database</h1><p>Monitor the stored creator pool and its independent Marketplace continuation job. Campaign filtering reads this database without making discovery requests.</p></div></header><CreatorDatabaseSync/></div>;
}
