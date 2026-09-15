import { describe, expect, it } from "vitest";
import { assertCampaignWithinLimit, assertContactCooldownDays, buildPreview, DEFAULT_OUTREACH_MESSAGE_TEMPLATE, MAX_CONTACT_COOLDOWN_DAYS, matchesFilters, rankingValue, reconcileUnknownDelivery, renderMessage, type CreatorCandidate } from "./index";

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

  it("uses fixed UTC timestamps for 30, 90, 180, and 360-day cooldown boundaries", () => {
    const now = new Date("2026-09-15T00:00:00.000Z");
    const ages = [0, 29, 30, 31, 89, 90, 91, 179, 180, 181, 359, 360, 361];
    const creators = ages.map((age, index) => creator(`age-${age}`, index + 1));
    const contacts = new Map(ages.map((age) => [`age-${age}`, {
      contactCount: 1,
      lastContactedAt: new Date(now.getTime() - age * 86_400_000)
    }]));
    const eligible = (cooldownDays: number) => buildPreview({
      creators, filters: {}, contacts, activeReservations: new Set(), requested: creators.length,
      cooldownDays, rankingMetric: "FOLLOWERS", now
    }).creators.filter((item) => item.eligibility === "ELIGIBLE").map((item) => Number(item.creatorOpenId.slice(4))).sort((a, b) => a - b);

    expect(eligible(30)).toEqual([30, 31, 89, 90, 91, 179, 180, 181, 359, 360, 361]);
    expect(eligible(90)).toEqual([90, 91, 179, 180, 181, 359, 360, 361]);
    expect(eligible(180)).toEqual([180, 181, 359, 360, 361]);
    expect(eligible(360)).toEqual([360, 361]);
  });

  it("never increases eligibility when the cooldown grows", () => {
    const now = new Date("2026-09-15T00:00:00.000Z");
    const ages = [0, 29, 30, 31, 89, 90, 91, 179, 180, 181, 359, 360, 361];
    const creators = ages.map((age, index) => creator(`monotonic-${age}`, index + 1));
    const contacts = new Map(ages.map((age) => [`monotonic-${age}`, {
      contactCount: 1, lastContactedAt: new Date(now.getTime() - age * 86_400_000)
    }]));
    const counts = [30, 90, 180, 360].map((cooldownDays) => buildPreview({
      creators, filters: {}, contacts, activeReservations: new Set(), requested: creators.length,
      cooldownDays, rankingMetric: "FOLLOWERS", now
    }).summary.eligible);
    expect(counts).toEqual([11, 8, 5, 2]);
  });

  it("accepts editable whole-day cooldowns and rejects invalid or overflowing values", () => {
    for (const days of [0, 1, 30, 90, 180, 360, 365, 730, MAX_CONTACT_COOLDOWN_DAYS]) {
      expect(() => assertContactCooldownDays(days)).not.toThrow();
    }
    for (const days of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_CONTACT_COOLDOWN_DAYS + 1]) {
      expect(() => assertContactCooldownDays(days)).toThrow("Contact cooldown must be a whole number");
    }
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
  it("keeps the canonical PROYA template exact and renders creator names including Unicode", () => {
    const expected = `Halo kak {{creator_display_name}}

Aku dari tim PROYA, mau mengajak Kakak untuk bekerja sama sebagai affiliate.

Syarat:
Akun TikTok Kakak sudah bisa menggunakan keranjang kuning.

Alur kerja sama:
Kami akan mengirimkan video cuplikan dari live PROYA yang sudah siap di-upload. Kakak tinggal upload videonya ke akun TikTok dan memasukkan keranjang kuning produk PROYA.

Benefit:
Kakak tidak perlu membuat video dari awal dan bisa mendapatkan komisi 10% dari setiap penjualan melalui video tersebut.

Kalau tertarik, silakan langsung hubungi WhatsApp tim PROYA di:
+62 811-2026-2826

Kami tunggu pesan WhatsApp dari Kakak ya 🙌
Terima kasih!`;
    expect(DEFAULT_OUTREACH_MESSAGE_TEMPLATE).toBe(expected);
    expect(DEFAULT_OUTREACH_MESSAGE_TEMPLATE).toContain("{{creator_display_name}}");
    expect(renderMessage(DEFAULT_OUTREACH_MESSAGE_TEMPLATE, {
      creatorDisplayName: "Ayu Cántik 🇮🇩", productName: "", campaignName: "20260902_001"
    })).toBe(expected.replace("{{creator_display_name}}", "Ayu Cántik 🇮🇩"));
  });

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
  it("accepts every campaign target from 1 through 500 and rejects 501", () => {
    const limits = { maxRecipientsPerCampaign: 500 };
    for (let requested = 1; requested <= 500; requested++) expect(() => assertCampaignWithinLimit(requested, limits)).not.toThrow();
    expect(() => assertCampaignWithinLimit(501, limits)).toThrow("campaign recipient ceiling of 500");
    expect(() => assertCampaignWithinLimit(0, limits)).toThrow("positive integer");
  });
});
