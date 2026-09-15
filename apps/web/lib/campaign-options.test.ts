import { describe, expect, it } from "vitest";
import { CREATOR_FOLLOWER_BUCKETS, CREATOR_GMV_BUCKETS, matchesFilters, OUTREACH_GMV_CURRENCY, type CreatorCandidate } from "@affiliate/domain";
import { CAMPAIGN_FOLLOWER_RANGES, CAMPAIGN_GMV_OPTIONS, campaignFollowerRangeCode, followerFilters, gmvFilters } from "./campaign-options";

describe("campaign filter options", () => {
  it("uses exactly five non-overlapping campaign-facing follower ranges", () => {
    expect(CAMPAIGN_FOLLOWER_RANGES.map((range) => range.label)).toEqual(["0–10K", "10K–50K", "50K–100K", "100K–1M", "1M+"]);
    expect(CAMPAIGN_FOLLOWER_RANGES).toHaveLength(5);
    expect(followerFilters("C1")).toEqual({ minFollowers: 0, maxFollowers: 9_999 });
    expect(followerFilters("C2")).toEqual({ minFollowers: 10_000, maxFollowers: 49_999 });
    expect(followerFilters("C3")).toEqual({ minFollowers: 50_000, maxFollowers: 99_999 });
    expect(followerFilters("C4")).toEqual({ minFollowers: 100_000, maxFollowers: 999_999 });
    expect(followerFilters("C5")).toEqual({ minFollowers: 1_000_000 });
    expect(followerFilters("invalid")).toEqual({});
    for (let index = 1; index < CAMPAIGN_FOLLOWER_RANGES.length; index++) {
      expect(CAMPAIGN_FOLLOWER_RANGES[index].min).toBe(CAMPAIGN_FOLLOWER_RANGES[index - 1].max! + 1);
    }
  });

  it("keeps crawler buckets unchanged and identifies old custom ranges without mutating them", () => {
    expect(CREATOR_FOLLOWER_BUCKETS).toHaveLength(25);
    expect(CREATOR_FOLLOWER_BUCKETS[0]).toEqual({ code: "F01", min: 600, max: 799 });
    expect(CREATOR_FOLLOWER_BUCKETS.at(-1)).toEqual({ code: "F25", min: 5_000_000, max: null });
    const legacy = { minFollowers: 10_000, maxFollowers: 14_999 };
    expect(campaignFollowerRangeCode(legacy)).toBe("CUSTOM");
    expect(legacy).toEqual({ minFollowers: 10_000, maxFollowers: 14_999 });
    expect(campaignFollowerRangeCode(followerFilters("C2"))).toBe("C2");
  });

  it("matches every boundary creator to exactly one simplified range", () => {
    const boundaryCounts = [0, 9_999, 10_000, 49_999, 50_000, 99_999, 100_000, 999_999, 1_000_000, 5_000_000];
    for (const followerCount of boundaryCounts) {
      const candidate: CreatorCandidate = {
        creatorOpenId: `creator-${followerCount}`, categoryIds: [], followerCount, gmv: null,
        unitsSold: null, avgVideoViews: null, avgLiveViewers: null, selectionRegion: "ID", discoveryOrdinal: 0
      };
      expect(CAMPAIGN_FOLLOWER_RANGES.filter((range) => matchesFilters(candidate, followerFilters(range.code)))).toHaveLength(1);
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
      gmv: { amount: "750", currency: OUTREACH_GMV_CURRENCY }, unitsSold: null, avgVideoViews: null, avgLiveViewers: null,
      selectionRegion: "ID", discoveryOrdinal: 0
    };
    const selected = { ...followerFilters("C2"), ...gmvFilters("G2"), gmvCurrency: OUTREACH_GMV_CURRENCY };
    const former = { minFollowers: 10_000, maxFollowers: 49_999, minGmv: 100, maxGmv: 1_000, gmvCurrency: OUTREACH_GMV_CURRENCY };
    expect(matchesFilters(creator, selected)).toBe(matchesFilters(creator, former));
  });
});
