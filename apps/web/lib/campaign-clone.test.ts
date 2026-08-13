import { describe, expect, it, vi } from "vitest";
import { cloneCampaignFromPreview, LOCAL_CLONE_EXPLANATION } from "./campaign-clone";

describe("clone campaign from preview", () => {
  it("calls only the local clone endpoint with a stable idempotency key", async () => {
    const request = vi.fn().mockResolvedValue({ id: "clone-1", state: "PREVIEW_READY", fetched: 20, eligible: 20, selected: 1, warnings: [] });
    const payload = { name: "Clone", productName: "Sheet Mask", targetCount: 1, messageTemplate: "Hi {{creator_display_name}}" };
    await expect(cloneCampaignFromPreview("source-1", payload, "submission-1", request)).resolves.toMatchObject({ id: "clone-1", state: "PREVIEW_READY" });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("/outreach/campaigns/source-1/clone-from-preview", {
      method: "POST", headers: { "Idempotency-Key": "submission-1" }, body: JSON.stringify(payload)
    });
  });

  it("states that cloning is local and makes no discovery request", () => {
    expect(LOCAL_CLONE_EXPLANATION).toContain("already-fetched creator candidates");
    expect(LOCAL_CLONE_EXPLANATION).toContain("No new TikTok discovery request");
  });
});
