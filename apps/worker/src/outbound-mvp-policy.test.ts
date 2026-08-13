import { describe, expect, it } from "vitest";
import { classifySendException, completionState, shouldAutoRetryDelivery, withShopMutationLease, type LeaseStore } from "./outbound-mvp-policy";

describe("outbound MVP safety policy", () => {
  it("allows only one active outbound mutation sequence per shop", async () => {
    const rows = new Map<string, { owner: string; expiresAt: Date }>();
    const store: LeaseStore = {
      find: async (shopId) => rows.get(shopId) ?? null,
      put: async (shopId, owner, expiresAt) => { rows.set(shopId, { owner, expiresAt }); },
      remove: async (shopId, owner) => { if (rows.get(shopId)?.owner === owner) rows.delete(shopId); }
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = withShopMutationLease(store, "shop", new Date(), async () => held);
    await Promise.resolve();
    await expect(withShopMutationLease(store, "shop", new Date(), async () => undefined)).rejects.toThrow("SHOP_OUTBOUND_SEQUENCE_BUSY");
    release(); await first;
    await expect(withShopMutationLease(store, "shop", new Date(), async () => "ok")).resolves.toBe("ok");
  });

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
