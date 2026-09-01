import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "apps/web/app/campaigns/[id]/page.tsx"), "utf8");

describe("one-click campaign send UI", () => {
  it("enables Send from a valid preview and calls the combined endpoint", () => {
    expect(page).toContain('campaign.state === "PREVIEW_READY"');
    expect(page).toContain('`/outreach/campaigns/${id}/send`');
    expect(page).toContain('`Send to ${formatNumber(selectedCount)} affiliates`');
    expect(page).toContain("eligibleCount <= 0");
    expect(page).toContain("selectedCount <= 0");
    expect(page).toContain("campaign.outboundCapability?.reason");
  });

  it("contains no typed campaign, count, or phrase confirmation controls", () => {
    expect(page).not.toContain("confirmName");
    expect(page).not.toContain("confirmCount");
    expect(page).not.toContain("confirmationName");
    expect(page).not.toContain("confirmationCount");
    expect(page).not.toContain("Confirm & queue");
    expect(page).not.toContain("confirmation");
  });

  it("prevents a second request while the first Send action is in flight", () => {
    expect(page).toContain("if (!campaign || sending) return");
    expect(page).toContain("disabled={sendDisabled}");
    expect(page).toContain("finally { setSending(false); }");
  });
});
