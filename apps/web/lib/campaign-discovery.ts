import { api } from "./api";

type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;

export type CampaignCreatePayload = {
  name: string;
  productName: string;
  targetCount: number;
  candidateLimit: number;
  cooldownDays: number;
  messageTemplate: string;
  filters: Record<string, unknown>;
  rankingMetric: string;
  rankingDirection: "ASC" | "DESC";
};

export type CampaignDiscoveryResult = { campaignId: string };

const discoveryPath = (campaignId: string) => `/outreach/campaigns/${campaignId}/discovery-runs`;

export async function createCampaignAndDiscover(payload: CampaignCreatePayload, _validationMode = false, request: Requester = api): Promise<CampaignDiscoveryResult> {
  const campaign = await request<{ id: string }>("/outreach/campaigns", { method: "POST", body: JSON.stringify(payload) });
  await request(discoveryPath(campaign.id), { method: "POST" });
  return { campaignId: campaign.id };
}

export function campaignDetailUrl(result: CampaignDiscoveryResult): string {
  const base = `/campaigns/${result.campaignId}`;
  return base;
}

export async function retryCampaignDiscovery(campaignId: string, _validationMode = false, request: Requester = api): Promise<void> {
  await request(discoveryPath(campaignId), { method: "POST" });
}
