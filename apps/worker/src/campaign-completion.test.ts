import { describe, expect, it } from "vitest";
import { allFrozenRecipientsTerminal, campaignCompletionSummary } from "./campaign-completion";

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

  it.each([251, 499, 500, 501, 750, 1000])("does not complete a %i-recipient campaign at a 250-row boundary", (size) => {
    const afterFirstBatch = [
      ...Array(250).fill("SENT"),
      ...Array(size - 250).fill("QUEUED")
    ];
    expect(allFrozenRecipientsTerminal(afterFirstBatch)).toBe(false);
    expect(allFrozenRecipientsTerminal(Array(size).fill("SENT"))).toBe(true);
  });

  it("requires every frozen recipient to use an established terminal state", () => {
    expect(allFrozenRecipientsTerminal(["SENT", "RESTRICTED", "FAILED", "DELIVERY_UNKNOWN_UNRESOLVED", "CANCELLED"])).toBe(true);
    for (const unfinished of ["DISCOVERED", "SELECTED", "RESERVED", "QUEUED", "PROCESSING", "DELIVERY_UNKNOWN"]) {
      expect(allFrozenRecipientsTerminal(["SENT", unfinished])).toBe(false);
    }
  });
});
