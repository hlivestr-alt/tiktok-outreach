import { describe, expect, it } from "vitest";
import { assertCampaignWithinLimit, buildPreview, matchesFilters, rankingValue, reconcileUnknownDelivery, renderMessage, type CreatorCandidate } from "./index";

const creator = (id: string, ordinal: number, gmv = 100): CreatorCandidate => ({
  creatorOpenId: id,
  username: `creator_${id}`,
  nickname: `Creator ${id}`,
  categoryIds: ["beauty"],
  followerCount: 10_000,
  gmv: { amount: String(gmv), currency: "IDR" },
  unitsSold: 20,
  avgVideoViews: 5000,
  avgLiveViewers: 250,
  engagementRate: 0.08,
  selectionRegion: "ID",
  discoveryOrdinal: ordinal
});

describe("campaign preview", () => {
  it("deduplicates, applies historical cooldown and allows a shortfall", () => {
    const now = new Date("2026-08-10T00:00:00Z");
    const result = buildPreview({
      creators: [creator("a", 1, 50), creator("a", 2, 500), creator("b", 3, 400), creator("c", 4, 300)],
      filters: {},
      contacts: new Map([["b", { contactCount: 1, historical: true, lastContactedAt: new Date("2026-08-01T00:00:00Z") }]]),
      activeReservations: new Set(),
      requested: 10,
      cooldownDays: 30,
      rankingMetric: "GMV",
      now
    });
    expect(result.summary.skippedDuplicates).toBe(1);
    expect(result.summary.skippedCooldown).toBe(1);
    expect(result.summary.eligible).toBe(2);
    expect(result.summary.selected).toBe(2);
    expect(result.summary.shortfall).toBe(8);
  });

  it("treats the exact cooldown boundary as eligible", () => {
    const now = new Date("2026-08-10T00:00:00Z");
    const result = buildPreview({
      creators: [creator("a", 1)], filters: {}, activeReservations: new Set(), requested: 1,
      cooldownDays: 30, rankingMetric: "GMV", now,
      contacts: new Map([["a", { contactCount: 1, lastContactedAt: new Date("2026-07-11T00:00:00Z") }]])
    });
    expect(result.summary.selected).toBe(1);
  });
});

describe("currency-aware GMV", () => {
  it("compares GMV only in the explicit matching currency", () => {
    expect(matchesFilters(creator("idr", 1, 100), { minGmv: 50, gmvCurrency: "IDR" })).toBe(true);
    expect(matchesFilters({ ...creator("usd", 1, 100), gmv: { amount: "100", currency: "USD" } }, { minGmv: 50, gmvCurrency: "IDR" })).toBe(false);
  });

  it("reports mixed currencies and excludes unexpected values without FX conversion", () => {
    const result = buildPreview({
      creators: [creator("idr", 1, 100), { ...creator("usd", 2, 999), gmv: { amount: "999", currency: "USD" } }],
      filters: { gmvCurrency: "IDR" }, contacts: new Map(), activeReservations: new Set(), requested: 2,
      cooldownDays: 0, rankingMetric: "GMV", now: new Date("2026-08-10T00:00:00Z")
    });
    expect(result.summary).toMatchObject({ gmvCurrencyCounts: { IDR: 1, USD: 1 }, gmvMixedCurrency: true, gmvExcludedCurrencyMismatch: 1, selected: 1 });
  });

  it("keeps unknown GMV null rather than converting it to zero", () => {
    const unknown = { ...creator("null", 1), gmv: null };
    expect(matchesFilters(unknown, { minGmv: 0, gmvCurrency: "IDR" })).toBe(false);
    expect(rankingValue(unknown, "GMV")).toBe(Number.MIN_SAFE_INTEGER);
  });
});

describe("messages and reconciliation", () => {
  it("renders only approved placeholders", () => {
    expect(renderMessage("Hi {{creator_display_name}} — try {{product_name}}", {
      creatorDisplayName: "Ayu", productName: "Glow Serum", campaignName: "Launch"
    })).toBe("Hi Ayu — try Glow Serum");
    expect(() => renderMessage("{{secret}}", { creatorDisplayName: "A", productName: "B", campaignName: "C" })).toThrow();
    expect(() => renderMessage("{{creatorDisplayName}}", { creatorDisplayName: "A", productName: "B", campaignName: "C" })).toThrow();
    expect(() => renderMessage("{{creator_display_name", { creatorDisplayName: "A", productName: "B", campaignName: "C" })).toThrow();
  });

  it("matches exactly one outbound message and never chooses ambiguous matches", () => {
    const dispatchedAt = new Date("2026-08-10T00:00:00Z");
    const message = { id: "m1", conversationId: "c1", direction: "OUTBOUND" as const, contentHash: "hash", createdAt: dispatchedAt };
    expect(reconcileUnknownDelivery({ conversationId: "c1", contentHash: "hash", dispatchedAt, messages: [message], alreadyLinkedMessageIds: new Set() })).toEqual({ status: "MATCHED", messageId: "m1" });
    expect(reconcileUnknownDelivery({ conversationId: "c1", contentHash: "hash", dispatchedAt, messages: [message, { ...message, id: "m2" }], alreadyLinkedMessageIds: new Set() }).status).toBe("UNRESOLVED");
  });

  it("leaves reconciliation unresolved when there are zero matches", () => {
    const result = reconcileUnknownDelivery({
      conversationId: "c1", contentHash: "hash", dispatchedAt: new Date("2026-08-10T00:00:00Z"),
      messages: [], alreadyLinkedMessageIds: new Set()
    });
    expect(result).toEqual({ status: "UNRESOLVED", reason: "No exact outbound match" });
  });
});

describe("hard safety limits", () => {
  it("rejects invalid or above-ceiling campaign targets", () => {
    const limits = { maxRecipientsPerCampaign: 1000, maxDispatchAttemptsPerCampaign: 4000, maxSendsPerDay: 1000, maxDispatchesPerMinute: 10 };
    expect(() => assertCampaignWithinLimit(1000, limits)).not.toThrow();
    expect(() => assertCampaignWithinLimit(1001, limits)).toThrow("campaign recipient ceiling");
    expect(() => assertCampaignWithinLimit(0, limits)).toThrow("positive integer");
  });
});
