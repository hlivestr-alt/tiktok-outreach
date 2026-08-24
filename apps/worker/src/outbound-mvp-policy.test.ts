import { describe, expect, it } from "vitest";
import { classifySendException, completionState, shouldAutoRetryDelivery } from "./outbound-mvp-policy";

describe("outbound MVP safety policy", () => {
  it("never retries ambiguous, terminal, restricted, sent, cancelled, or unknown deliveries", () => {
    expect(classifySendException(true, false)).toBe("UNKNOWN");
    expect(classifySendException(false, false)).toBe("RETRYABLE_PRE_SEND");
    expect(shouldAutoRetryDelivery("FAILED_RETRYABLE")).toBe(true);
    for (const state of ["SENT", "RESTRICTED", "FAILED_TERMINAL", "DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN_UNRESOLVED", "CANCELLED"]) expect(shouldAutoRetryDelivery(state)).toBe(false);
  });

  it("computes campaign completion with recipient-level issues", () => {
    expect(completionState(["SENT", "SENT"])).toBe("COMPLETED");
    expect(completionState(["SENT", "RESTRICTED", "FAILED", "DELIVERY_UNKNOWN_UNRESOLVED"])).toBe("COMPLETED_WITH_ERRORS");
    expect(completionState(["SENT", "QUEUED"])).toBeNull();
  });
});
