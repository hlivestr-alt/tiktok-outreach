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

  it("retains created campaign context when discovery fails", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ id: "campaign-2" })
      .mockRejectedValueOnce(new Error("Marketplace unavailable"));
    const result = await createCampaignAndDiscover(payload, false, request);
    expect(result).toEqual({ campaignId: "campaign-2", discoveryError: "Marketplace unavailable" });
    expect(campaignDetailUrl(result)).toBe("/campaigns/campaign-2?discoveryError=Marketplace%20unavailable");
  });

  it("retries a DRAFT through the normal discovery endpoint", async () => {
    const request = vi.fn().mockResolvedValue({ state: "PREVIEW_READY" });
    await retryCampaignDiscovery("campaign-3", false, request);
    expect(request).toHaveBeenCalledWith("/outreach/campaigns/campaign-3/discovery-runs", { method: "POST" });
  });

  it("uses controlled validation mode for real READ_ONLY discovery", async () => {
    const request = vi.fn().mockResolvedValue({ state: "PREVIEW_READY" });
    await retryCampaignDiscovery("campaign-4", true, request);
    expect(request).toHaveBeenCalledWith("/outreach/campaigns/campaign-4/discovery-runs?validationMode=true", { method: "POST" });
  });
});
