import { describe, expect, it } from "vitest";
import { adaptiveExpansion, adaptiveFollowerPartitionKey, adaptiveGmvPartitionKey, classifyIncrementalYield,
  combinedIncrementalYield, CREATOR_FOLLOWER_HARD_FLOOR, FOLLOWER_BUCKETS, firstExploratoryFollowerSplit, followerBucketFor, GMV_BUCKETS,
  isSpecificGmvPartition, observedSaturationState, partitionFilters, partitionKeyV2, specificGmvCombinationKey, splitFollowerRange,
  validateMarketplaceCategorySelection, validateV2CategorySelection, v2BasePartitionRows } from "./marketplace-partitions";

describe("Marketplace V2 follower partitions", () => {
  it("uses all 25 exact inclusive ranges without gaps, overlap, or values below 600", () => {
    expect(FOLLOWER_BUCKETS).toHaveLength(25);
    expect(FOLLOWER_BUCKETS[0]).toEqual({ code: "F01", min: 600, max: 799 });
    expect(FOLLOWER_BUCKETS.at(-1)).toEqual({ code: "F25", min: 5_000_000, max: null });
    expect(FOLLOWER_BUCKETS.every((bucket) => bucket.min >= CREATOR_FOLLOWER_HARD_FLOOR)).toBe(true);
    for (let index = 1; index < FOLLOWER_BUCKETS.length; index++) expect(FOLLOWER_BUCKETS[index].min).toBe((FOLLOWER_BUCKETS[index - 1].max ?? 0) + 1);
    const boundaries = [599, 600, 799, 800, 999, 1000, 1499, 1500, 1999, 2000, 999999, 1000000,
      1499999, 1500000, 2499999, 2500000, 4999999, 5000000];
    expect(boundaries.map((value) => followerBucketFor(value)?.code ?? null)).toEqual([
      null, "F01", "F01", "F02", "F02", "F03", "F03", "F04", "F04", "F05", "F21", "F22",
      "F22", "F23", "F23", "F24", "F24", "F25"
    ]);
  });

  it("constructs only the documented inclusive request filters and omits the open upper bound", () => {
    expect(() => partitionFilters({ categoryId: "600001", categoryChildIds: ["851848"], followersMin: 600, followersMax: 799,
      gmvBucket: null, gmvRange: null })).toThrow(/Specific documented GMV bucket/);
    expect(partitionFilters({ categoryId: "600001", categoryChildIds: ["851848"], followersMin: 5_000_000, followersMax: null,
      gmvBucket: "G4",
      gmvRange: "GMV_RANGE_10000_AND_ABOVE" })).toEqual({ marketplaceCategory: { parentCategoryId: "600001", childCategoryIds: ["851848"] },
      minFollowers: 5_000_000, marketplaceGmvRanges: ["GMV_RANGE_10000_AND_ABOVE"] });
  });

  it("maps every follower partition to exactly one official GMV range", () => {
    for (const bucket of GMV_BUCKETS) expect(partitionFilters({ categoryId: "600001", categoryChildIds: ["851848"], followersMin: 1_000,
      followersMax: 1_499, gmvBucket: bucket.code, gmvRange: bucket.range })).toEqual({
      marketplaceCategory: { parentCategoryId: "600001", childCategoryIds: ["851848"] }, minFollowers: 1_000, maxFollowers: 1_499,
      marketplaceGmvRanges: [bucket.range]
    });
  });

  it("uses deterministic V2 identities distinct from V1", () => {
    expect(partitionKeyV2("600001", "851848", 600, 799)).toBe("v2:600001:851848:f600-799");
    expect(partitionKeyV2("600001", "851848", 5_000_000, null, "G1")).toBe("v2:600001:851848:f5000000-plus:g1");
    expect(specificGmvCombinationKey({ categoryId: "600001", categoryChildId: "851848", followersMin: 600, followersMax: 799, gmvBucket: "G1" }))
      .toBe("600001:851848:600:799:g1");
    expect(isSpecificGmvPartition({ gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100" })).toBe(true);
    expect(isSpecificGmvPartition({ gmvBucket: "G1", gmvRange: "GMV_RANGE_100_1000" })).toBe(false);
  });

  it("splits bounded ranges deterministically with exact coverage and stops at configured minimum width", () => {
    expect(splitFollowerRange(1_000, 1_499)).toEqual([{ min: 1_000, max: 1_249 }, { min: 1_250, max: 1_499 }]);
    const first = splitFollowerRange(1_000, 1_499)!;
    expect(first[0].min).toBe(1_000); expect(first[0].max + 1).toBe(first[1].min); expect(first[1].max).toBe(1_499);
    expect(splitFollowerRange(1_000, 1_099)).toBeNull();
    expect(splitFollowerRange(600, 649)).toBeNull();
    expect(splitFollowerRange(5_000_000, null)).toBeNull();
    expect(splitFollowerRange(599, 799)).toBeNull();
  });
});

describe("Marketplace V2 category isolation", () => {
  const catalog = [
    { categoryId: "parent", categoryName: "Parent", parentCategoryId: null, enabledForCreatorCrawl: true, availableForCreatorFilter: true, sortOrder: 0 },
    { categoryId: "child-b", categoryName: "Child B", parentCategoryId: "parent", availableForCreatorFilter: true, sortOrder: 2 },
    { categoryId: "child-a", categoryName: "Child A", parentCategoryId: "parent", availableForCreatorFilter: true, sortOrder: 1 },
    { categoryId: "disabled", categoryName: "Disabled", parentCategoryId: "parent", availableForCreatorFilter: false, sortOrder: 3 },
    { categoryId: "grandchild", parentCategoryId: "child-a", availableForCreatorFilter: true, sortOrder: 4 }
  ];
  it("requires exactly one verified immediate child", () => {
    expect(() => validateV2CategorySelection("parent", ["child-a"], catalog)).not.toThrow();
    expect(() => validateV2CategorySelection("parent", ["child-a", "child-b"], catalog)).toThrow(/exactly one/);
    expect(() => validateV2CategorySelection("parent", ["grandchild"], catalog)).toThrow(/one catalog level/);
    expect(() => validateV2CategorySelection("parent", ["disabled"], catalog)).toThrow(/disabled or stale/);
    expect(() => validateMarketplaceCategorySelection("parent", [], catalog)).toThrow(/at least one/);
  });

  it("generates child-by-bucket rows in deterministic order", () => {
    const rows = v2BasePartitionRows(catalog);
    expect(rows).toHaveLength(200);
    expect(rows[0]).toMatchObject({ parentCategoryId: "parent", childCategoryId: "child-a", followerBucket: "F01", followersMin: 600, followersMax: 799,
      gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100" });
    expect(rows[3]).toMatchObject({ childCategoryId: "child-a", followerBucket: "F01", gmvBucket: "G4" });
    expect(rows[99]).toMatchObject({ childCategoryId: "child-a", followerBucket: "F25", followersMin: 5_000_000, followersMax: null, gmvBucket: "G4" });
    expect(rows[100]).toMatchObject({ childCategoryId: "child-b", followerBucket: "F01", gmvBucket: "G1" });
    expect(rows.every((row) => row.partitionKey.includes(":g") && row.followersMin >= 600 && row.gmvRange.startsWith("GMV_RANGE_"))).toBe(true);
  });
});

describe("Marketplace V3 adaptive follower planning", () => {
  const seed = (overrides: Partial<Parameters<typeof adaptiveExpansion>[0]> = {}) => ({
    partitionType: "V2_SEED" as const, observedSaturationState: "OBSERVED_SATURATED" as const,
    followersMin: 1_000, followersMax: 1_499, yield: 0.01, followerSplitExplored: false,
    followerRecursionTerminal: false, gmvSplitCreated: false, gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100", ...overrides
  });

  it("gives a low-yield saturated seed its one exploratory split", () => {
    expect(adaptiveExpansion(seed())).toEqual({ kind: "FOLLOWER", bounds: [
      { min: 1_000, max: 1_249 }, { min: 1_250, max: 1_499 }
    ] });
  });

  it("does not split an unsaturated branch", () => {
    expect(adaptiveExpansion(seed({ observedSaturationState: "NOT_OBSERVED_SATURATED", yield: 0.50 }))).toEqual({ kind: "NONE" });
    expect(observedSaturationState(true, 379)).toBe("NOT_OBSERVED_SATURATED");
    expect(observedSaturationState(true, 380)).toBe("OBSERVED_SATURATED");
    expect(observedSaturationState(true, 405)).toBe("OBSERVED_SATURATED");
    expect(observedSaturationState(true, 406)).toBe("NOT_OBSERVED_SATURATED");
  });

  it("uses inclusive deterministic binary bounds with no gap or overlap and honors the 600 floor", () => {
    const bounds = firstExploratoryFollowerSplit(600, 1_099)!;
    expect(bounds).toEqual([{ min: 600, max: 849 }, { min: 850, max: 1_099 }]);
    expect(bounds[0].max + 1).toBe(bounds[1].min);
    expect(bounds[0].min).toBe(600);
    expect(firstExploratoryFollowerSplit(599, 1_098)).toBeNull();
    expect(firstExploratoryFollowerSplit(1_000, 1_498)).toBeNull();
  });

  it("never invents an upper bound for an open-ended follower range", () => {
    expect(firstExploratoryFollowerSplit(5_000_000, null)).toBeNull();
    expect(adaptiveExpansion(seed({ followersMin: 5_000_000, followersMax: null, yield: 0.20 }))).toEqual({ kind: "NONE" });
  });

  it("requires at least ten percent incremental yield for deeper recursion", () => {
    const adaptive = { ...seed(), partitionType: "ADAPTIVE_FOLLOWER" as const, followersMin: 1_000, followersMax: 1_249 };
    expect(adaptiveExpansion({ ...adaptive, yield: 0.0999 })).toEqual({ kind: "NONE" });
    expect(adaptiveExpansion({ ...adaptive, yield: 0.10 })).toEqual({ kind: "FOLLOWER", bounds: [
      { min: 1_000, max: 1_124 }, { min: 1_125, max: 1_249 }
    ] });
  });

  it("stops a first-split branch below five percent combined yield", () => {
    const combined = combinedIncrementalYield([{ rowsReturned: 403, uniqueCreatorsAdded: 4 }, { rowsReturned: 401, uniqueCreatorsAdded: 4 }]);
    expect(combined).toBeCloseTo(0.01, 3);
    expect(combined).toBeLessThan(0.05);
    expect(classifyIncrementalYield(combined)).toBe("EFFECTIVELY_DEAD");
  });

  it("uses configurable minimum useful widths and leaves productive terminal widths in their GMV branch", () => {
    expect(splitFollowerRange(1_000, 1_099)).toBeNull();
    expect(splitFollowerRange(10_000, 11_999)).toEqual([{ min: 10_000, max: 10_999 }, { min: 11_000, max: 11_999 }]);
    expect(adaptiveExpansion({ ...seed(), partitionType: "ADAPTIVE_FOLLOWER", followersMin: 1_000,
      followersMax: 1_099, yield: 0.10 })).toEqual({ kind: "NONE" });
  });

  it("creates deterministic production keys distinct from V2 and experiment keys", () => {
    const parent = "v2:600001:851848:f1000-1499";
    expect(adaptiveFollowerPartitionKey(parent, 1_000, 1_249)).toBe("v3:v2:600001:851848:f1000-1499:f1000-1249");
    expect(adaptiveGmvPartitionKey(parent, "G1")).toBe("v3:v2:600001:851848:f1000-1499:g1");
    expect(adaptiveFollowerPartitionKey(parent, 1_000, 1_249)).not.toContain("experiment:split:");
  });

});
