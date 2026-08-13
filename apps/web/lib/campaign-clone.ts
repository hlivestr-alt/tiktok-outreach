import { api } from "./api";

type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;

export const LOCAL_CLONE_EXPLANATION = "Uses already-fetched creator candidates. No new TikTok discovery request will be made.";

export type CampaignClonePayload = {
  name: string;
  productName: string;
  targetCount: number;
  messageTemplate: string;
};

export async function cloneCampaignFromPreview(
  sourceCampaignId: string,
  payload: CampaignClonePayload,
  idempotencyKey: string,
  request: Requester = api
) {
  return request<{ id: string; state: string; fetched: number; eligible: number; selected: number; warnings: string[] }>(
    `/outreach/campaigns/${sourceCampaignId}/clone-from-preview`,
    { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) }
  );
}
