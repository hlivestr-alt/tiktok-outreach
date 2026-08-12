import { describe, expect, it, vi } from "vitest";
import { campaignDetailUrl, createCampaignAndDiscover, retryCampaignDiscovery, type CampaignCreatePayload } from "./campaign-discovery";

const payload: CampaignCreatePayload = {
  name: "Validation", productName: "Product", targetCount: 10, candidateLimit: 20, cooldownDays: 30,
  messageTemplate: "Hi {{creator_display_name}}", filters: {}, rankingMetric: "FOLLOWERS", rankingDirection: "DESC"
};

describe("campaign discovery workflow", () => {
  it("creates the campaign and reaches its normal bodyless discovery endpoint", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ id: "campaign-1" })
      .mockResolvedValueOnce({ state: "PREVIEW_READY" });
    expect(await createCampaignAndDiscover(payload, false, request)).toEqual({ campaignId: "campaign-1" });
    expect(request).toHaveBeenNthCalledWith(2, "/outreach/campaigns/campaign-1/discovery-runs", { method: "POST" });
  });

  it("surfaces a local enqueue failure", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ id: "campaign-2" })
      .mockRejectedValueOnce(new Error("Marketplace unavailable"));
    await expect(createCampaignAndDiscover(payload, false, request)).rejects.toThrow("Marketplace unavailable");
  });

  it("retries a DRAFT through the normal discovery endpoint", async () => {
    const request = vi.fn().mockResolvedValue({ state: "PREVIEW_READY" });
    await retryCampaignDiscovery("campaign-3", false, request);
    expect(request).toHaveBeenCalledWith("/outreach/campaigns/campaign-3/discovery-runs", { method: "POST" });
  });

  it("real READ_ONLY enqueue uses the same local endpoint", async () => {
    const request = vi.fn().mockResolvedValue({ state: "PREVIEW_READY" });
    await retryCampaignDiscovery("campaign-4", true, request);
    expect(request).toHaveBeenCalledWith("/outreach/campaigns/campaign-4/discovery-runs", { method: "POST" });
  });
});
