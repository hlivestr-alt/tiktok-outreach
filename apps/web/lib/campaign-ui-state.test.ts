import { describe, expect, it } from "vitest";
import { campaignSendAvailability } from "./campaign-ui-state";

describe("campaign notice severity", () => {
  it("keeps genuine sending blockers prominent", () => {
    expect(campaignSendAvailability({ eligibleCount: 0, selectedCount: 0, outboundEnabled: true })).toEqual({
      canSend: false, reason: "No eligible recipients are available to send"
    });
    expect(campaignSendAvailability({ eligibleCount: 10, selectedCount: 10, outboundEnabled: false, outboundReason: "Authentication required" })).toEqual({
      canSend: false, reason: "Authentication required"
    });
  });

  it("does not disable Send for non-blocking data-quality notes", () => {
    const warnings = { historyIdentityCoverageIncomplete: true, gmvMixedCurrency: true, gmvExcludedCurrencyMismatch: 3 };
    expect(warnings.historyIdentityCoverageIncomplete).toBe(true);
    expect(campaignSendAvailability({ eligibleCount: 10, selectedCount: 10, outboundEnabled: true })).toEqual({ canSend: true, reason: null });
  });
});
