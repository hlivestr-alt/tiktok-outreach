import { describe, expect, it } from "vitest";
import { campaignCompletionSummary } from "./campaign-completion";

describe("campaign completion reporting", () => {
  it("does not report an all-safety-cancelled campaign as successful", () => {
    expect(campaignCompletionSummary(["CANCELLED", "CANCELLED"])).toEqual({
      completedSuccessfully: false, sent: 0, restricted: 0, failed: 0, safetyCancelled: 2, unresolved: 0, otherTerminal: 0, terminalRecipients: 2
    });
  });

  it("reports success only when every selected recipient was sent", () => {
    expect(campaignCompletionSummary(["SENT", "SENT"]).completedSuccessfully).toBe(true);
    expect(campaignCompletionSummary(["SENT", "FAILED"]).completedSuccessfully).toBe(false);
  });

  it("counts every terminal recipient outcome independently of successful-send count", () => {
    expect(campaignCompletionSummary([
      ...Array(800).fill("SENT"), ...Array(150).fill("RESTRICTED"), ...Array(50).fill("FAILED")
    ])).toMatchObject({
      completedSuccessfully: false, sent: 800, restricted: 150, failed: 50, unresolved: 0, terminalRecipients: 1000
    });
  });
});
