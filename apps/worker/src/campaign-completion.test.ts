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
});
