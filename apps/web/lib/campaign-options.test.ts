import { describe, expect, it } from "vitest";
import { CREATOR_FOLLOWER_BUCKETS, CREATOR_GMV_BUCKETS, matchesFilters, type CreatorCandidate } from "@affiliate/domain";
import { CAMPAIGN_FOLLOWER_OPTIONS, CAMPAIGN_GMV_OPTIONS, followerFilters, gmvFilters } from "./campaign-options";

describe("campaign filter options", () => {
  it("uses every canonical Creator Database follower bucket", () => {
    expect(CAMPAIGN_FOLLOWER_OPTIONS).toHaveLength(25);
    expect(followerFilters("F01")).toEqual({ minFollowers: 600, maxFollowers: 799 });
    expect(followerFilters("F10")).toEqual({ minFollowers: 10_000, maxFollowers: 14_999 });
    expect(followerFilters("F25")).toEqual({ minFollowers: 5_000_000 });
    expect(followerFilters("invalid")).toEqual({});
    for (const bucket of CREATOR_FOLLOWER_BUCKETS) {
      expect(followerFilters(bucket.code)).toEqual({ minFollowers: bucket.min, ...(bucket.max == null ? {} : { maxFollowers: bucket.max }) });
    }
  });

  it("maps friendly GMV segments onto the existing numeric campaign filters", () => {
    expect(CAMPAIGN_GMV_OPTIONS.map((option) => option.label)).toEqual(["Low", "Medium", "High", "Very High"]);
    expect(CAMPAIGN_GMV_OPTIONS.map((option) => option.range)).toEqual([
      "GMV_RANGE_0_100", "GMV_RANGE_100_1000", "GMV_RANGE_1000_10000", "GMV_RANGE_10000_AND_ABOVE"
    ]);
    expect(gmvFilters("G1")).toEqual({ minGmv: 0, maxGmv: 100 });
    expect(gmvFilters("G4")).toEqual({ minGmv: 10_000 });
    expect(gmvFilters("invalid")).toEqual({});
    for (const bucket of CREATOR_GMV_BUCKETS) {
      expect(gmvFilters(bucket.code)).toEqual({ minGmv: bucket.min, ...(bucket.max == null ? {} : { maxGmv: bucket.max }) });
    }
  });

  it("produces the same eligibility result as the equivalent former min/max input", () => {
    const creator: CreatorCandidate = {
      creatorOpenId: "creator-1", categoryIds: [], followerCount: 12_500,
      gmv: { amount: "750", currency: "IDR" }, unitsSold: null, avgVideoViews: null, avgLiveViewers: null,
      selectionRegion: "ID", discoveryOrdinal: 0
    };
    const selected = { ...followerFilters("F10"), ...gmvFilters("G2"), gmvCurrency: "IDR" };
    const former = { minFollowers: 10_000, maxFollowers: 14_999, minGmv: 100, maxGmv: 1_000, gmvCurrency: "IDR" };
    expect(matchesFilters(creator, selected)).toBe(matchesFilters(creator, former));
  });
});
