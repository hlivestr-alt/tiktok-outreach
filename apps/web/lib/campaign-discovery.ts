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

export type CampaignDiscoveryResult = { campaignId: string; discoveryError?: string };

const discoveryPath = (campaignId: string, validationMode: boolean) => `/outreach/campaigns/${campaignId}/discovery-runs${validationMode ? "?validationMode=true" : ""}`;

export async function createCampaignAndDiscover(payload: CampaignCreatePayload, validationMode = false, request: Requester = api): Promise<CampaignDiscoveryResult> {
  const campaign = await request<{ id: string }>("/outreach/campaigns", { method: "POST", body: JSON.stringify(payload) });
  try {
    await request(discoveryPath(campaign.id, validationMode), { method: "POST" });
    return { campaignId: campaign.id };
  } catch (error) {
    return { campaignId: campaign.id, discoveryError: error instanceof Error ? error.message : "Creator discovery failed" };
  }
}

export function campaignDetailUrl(result: CampaignDiscoveryResult): string {
  const base = `/campaigns/${result.campaignId}`;
  return result.discoveryError ? `${base}?discoveryError=${encodeURIComponent(result.discoveryError)}` : base;
}

export async function retryCampaignDiscovery(campaignId: string, validationMode = false, request: Requester = api): Promise<void> {
  await request(discoveryPath(campaignId, validationMode), { method: "POST" });
}
