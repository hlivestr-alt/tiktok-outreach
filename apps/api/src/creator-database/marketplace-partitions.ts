import { CREATOR_FOLLOWER_BUCKETS, CREATOR_GMV_BUCKETS, type CreatorFilters } from "@affiliate/domain";

export const V2_GENERATION = 2;
export const V3_ADAPTIVE_GENERATION = 3;
export const CREATOR_FOLLOWER_HARD_FLOOR = 600;
export const BASE_QUEUE_GAP = 1_000_000n;
export const DEFAULT_FIRST_SPLIT_MIN_WIDTH = 500;
export const DEFAULT_DEEP_SPLIT_MIN_INCREMENTAL_YIELD = 0.10;
export const DEFAULT_LOW_VALUE_COMBINED_YIELD = 0.05;
export const DEFAULT_OBSERVED_SATURATION_MIN_ROWS = 380;
export const DEFAULT_OBSERVED_SATURATION_MAX_ROWS = 405;
export const DEFAULT_BRANCH_EVIDENCE_MIN_ROWS = 200;
export const DEFAULT_FIRST_SPLIT_MIN_UNIQUE_RATE = 0.20;
export const DEFAULT_FIRST_SPLIT_MIN_NEW_PER_PAGE = 4;
export const DEFAULT_G4_RECURSION_MIN_UNIQUE_RATE = 0.10;
export const DEFAULT_G4_RECURSION_MIN_NEW_PER_PAGE = 4;

export const PRODUCTION_PARTITION_TYPES = ["V2_SEED", "ADAPTIVE_FOLLOWER", "ADAPTIVE_GMV"] as const;
export type ProductionPartitionType = typeof PRODUCTION_PARTITION_TYPES[number];
export type BranchClassification = "UNCLASSIFIED" | "STRONG" | "PRODUCTIVE" | "MARGINAL" | "LOW_VALUE" | "EFFECTIVELY_DEAD";
export type ObservedSaturationState = "UNKNOWN" | "OBSERVED_SATURATED" | "NOT_OBSERVED_SATURATED";

export const FOLLOWER_BUCKETS = CREATOR_FOLLOWER_BUCKETS;
export const GMV_BUCKETS = CREATOR_GMV_BUCKETS;
export type GmvBucketCode = typeof GMV_BUCKETS[number]["code"];
export const SPECIFIC_GMV_BUCKET_CODES = GMV_BUCKETS.map((bucket) => bucket.code) as GmvBucketCode[];

export function gmvBucketDefinition(code: string | null | undefined) {
  return GMV_BUCKETS.find((bucket) => bucket.code === code);
}

export function isSpecificGmvBucket(code: string | null | undefined): code is GmvBucketCode {
  return Boolean(gmvBucketDefinition(code));
}

export function specificGmvCombinationKey(input: { categoryId: string | null; categoryChildId: string | null;
  followersMin: number | null; followersMax: number | null; gmvBucket: string | null }) {
  if (!input.categoryId || !input.categoryChildId || input.followersMin == null || !isSpecificGmvBucket(input.gmvBucket)) return null;
  return [input.categoryId, input.categoryChildId, input.followersMin, input.followersMax == null ? "plus" : input.followersMax,
    input.gmvBucket].map((value) => String(value).toLowerCase()).join(":");
}

export function isSpecificGmvPartition(partition: { gmvBucket: string | null; gmvRange: string | null }) {
  const bucket = gmvBucketDefinition(partition.gmvBucket);
  return Boolean(bucket && partition.gmvRange === bucket.range);
}

export type MarketplaceCategoryCatalogNode = { categoryId: string; categoryName?: string; parentCategoryId: string | null;
  enabledForCreatorCrawl?: boolean; availableForCreatorFilter?: boolean; sortOrder?: number };
export type FollowerWidthRules = { from600: number; from1000: number; from10000: number; from100000: number; from1000000: number };
export const DEFAULT_FOLLOWER_WIDTH_RULES: FollowerWidthRules = {
  from600: 50, from1000: 100, from10000: 1_000, from100000: 10_000, from1000000: 100_000
};

export function followerRangeLabel(min: number | null, max: number | null) {
  if (min == null) return "All";
  return max == null ? `${min.toLocaleString("en-US")}+` : `${min.toLocaleString("en-US")} – ${max.toLocaleString("en-US")}`;
}
export function followerBucketFor(count: number) {
  return FOLLOWER_BUCKETS.find((bucket) => count >= bucket.min && (bucket.max == null || count <= bucket.max));
}
export function partitionKeyV2(parentCategoryId: string, childCategoryId: string, min: number, max: number | null, gmvBucket?: string | null) {
  const followers = `f${min}-${max == null ? "plus" : max}`;
  return `v2:${parentCategoryId.toLowerCase()}:${childCategoryId.toLowerCase()}:${followers}${gmvBucket ? `:${gmvBucket.toLowerCase()}` : ""}`;
}
export function adaptiveFollowerPartitionKey(parentPartitionKey: string, min: number, max: number) {
  return `v3:${parentPartitionKey}:f${min}-${max}`;
}
export function adaptiveGmvPartitionKey(parentPartitionKey: string, gmvBucket: string) {
  return `v3:${parentPartitionKey}:${gmvBucket.toLowerCase()}`;
}
export function inclusiveFollowerWidth(min: number, max: number | null) {
  return max == null || min < CREATOR_FOLLOWER_HARD_FLOOR || max < min ? null : max - min + 1;
}
export function binaryFollowerRange(min: number, max: number | null) {
  const width = inclusiveFollowerWidth(min, max);
  if (width == null || width < 2) return null;
  const mid = Math.floor((min + max!) / 2);
  return [{ min, max: mid }, { min: mid + 1, max: max! }] as const;
}
export function firstExploratoryFollowerSplit(min: number, max: number | null, minimumWidth = DEFAULT_FIRST_SPLIT_MIN_WIDTH) {
  const width = inclusiveFollowerWidth(min, max);
  return width != null && width >= minimumWidth ? binaryFollowerRange(min, max) : null;
}
export function minimumFollowerWidth(min: number, rules: FollowerWidthRules = DEFAULT_FOLLOWER_WIDTH_RULES) {
  if (min >= 1_000_000) return rules.from1000000;
  if (min >= 100_000) return rules.from100000;
  if (min >= 10_000) return rules.from10000;
  if (min >= 1_000) return rules.from1000;
  return rules.from600;
}
export function splitFollowerRange(min: number, max: number | null, rules: FollowerWidthRules = DEFAULT_FOLLOWER_WIDTH_RULES) {
  const width = inclusiveFollowerWidth(min, max);
  if (width == null) return null;
  const minimum = minimumFollowerWidth(min, rules);
  if (width < minimum * 2) return null;
  return binaryFollowerRange(min, max);
}

export function deeperFollowerSplit(min: number, max: number | null, incrementalYield: number | null,
  rules: FollowerWidthRules = DEFAULT_FOLLOWER_WIDTH_RULES, minimumYield = DEFAULT_DEEP_SPLIT_MIN_INCREMENTAL_YIELD) {
  return incrementalYield != null && incrementalYield >= minimumYield ? splitFollowerRange(min, max, rules) : null;
}

export function observedSaturationState(completed: boolean, rowsReturned: number,
  minRows = DEFAULT_OBSERVED_SATURATION_MIN_ROWS, maxRows = DEFAULT_OBSERVED_SATURATION_MAX_ROWS): ObservedSaturationState {
  if (!completed) return "UNKNOWN";
  return rowsReturned >= minRows && rowsReturned <= maxRows ? "OBSERVED_SATURATED" : "NOT_OBSERVED_SATURATED";
}

export function classifyIncrementalYield(value: number | null): BranchClassification {
  if (value == null || !Number.isFinite(value)) return "UNCLASSIFIED";
  if (value <= 0.02) return "EFFECTIVELY_DEAD";
  if (value < 0.05) return "LOW_VALUE";
  if (value < 0.10) return "MARGINAL";
  if (value < 0.20) return "PRODUCTIVE";
  return "STRONG";
}

export function combinedIncrementalYield(children: ReadonlyArray<{ rowsReturned: number; uniqueCreatorsAdded: number }>) {
  const rows = children.reduce((total, child) => total + child.rowsReturned, 0);
  return rows ? children.reduce((total, child) => total + child.uniqueCreatorsAdded, 0) / rows : 0;
}

export type AdaptiveExpansion =
  | { kind: "FOLLOWER"; bounds: readonly [{ min: number; max: number }, { min: number; max: number }]; reason: string }
  | { kind: "NONE"; reason: string };

export function adaptiveExpansion(input: { partitionType: ProductionPartitionType; observedSaturationState: ObservedSaturationState;
  followersMin: number; followersMax: number | null; yield: number | null; rowsReturned: number; successfulPages: number;
  uniqueCreatorsAdded: number; followerSplitExplored: boolean;
  followerRecursionTerminal: boolean; gmvSplitCreated: boolean; gmvBucket?: string | null; gmvRange?: string | null }, rules: FollowerWidthRules = DEFAULT_FOLLOWER_WIDTH_RULES,
  _firstSplitMinWidth = DEFAULT_FIRST_SPLIT_MIN_WIDTH, deepMinimumYield = DEFAULT_DEEP_SPLIT_MIN_INCREMENTAL_YIELD,
  minimumEvidenceRows = DEFAULT_BRANCH_EVIDENCE_MIN_ROWS): AdaptiveExpansion {
  // GMV is now part of the branch identity from the first request. Historical
  // GMV-All rows are never eligible for adaptive expansion.
  if (!isSpecificGmvPartition({ gmvBucket: input.gmvBucket ?? null, gmvRange: input.gmvRange ?? null })
    ) return { kind: "NONE", reason: "UNSUPPORTED_GMV_BRANCH" };
  if (input.followerRecursionTerminal) return { kind: "NONE", reason: "ALREADY_TERMINAL" };
  if (input.gmvSplitCreated || input.followerSplitExplored) return { kind: "NONE", reason: "ALREADY_EXPLORED" };
  const bounds = splitFollowerRange(input.followersMin, input.followersMax, rules);
  if (!bounds) return { kind: "NONE", reason: "RANGE_AT_MINIMUM_WIDTH" };
  if (input.rowsReturned < minimumEvidenceRows) return { kind: "NONE", reason: "INSUFFICIENT_SAMPLE" };
  const uniqueRate = input.rowsReturned ? input.uniqueCreatorsAdded / input.rowsReturned : 0;
  const newPerPage = input.successfulPages ? input.uniqueCreatorsAdded / input.successfulPages : 0;
  const saturated = input.observedSaturationState === "OBSERVED_SATURATED";

  if (input.gmvBucket === "G4") {
    const exceptional = uniqueRate >= DEFAULT_G4_RECURSION_MIN_UNIQUE_RATE && newPerPage >= DEFAULT_G4_RECURSION_MIN_NEW_PER_PAGE;
    return exceptional ? { kind: "FOLLOWER", bounds, reason: "G4_EXCEPTIONAL_EVIDENCE" }
      : { kind: "NONE", reason: "G4_EVIDENCE_GATE_NOT_MET" };
  }

  if (input.gmvBucket === "G3") {
    const productive = uniqueRate >= DEFAULT_FIRST_SPLIT_MIN_UNIQUE_RATE && newPerPage >= DEFAULT_FIRST_SPLIT_MIN_NEW_PER_PAGE;
    return productive ? { kind: "FOLLOWER", bounds, reason: "G3_LOCAL_PRODUCTIVITY_OVERRIDE" }
      : { kind: "NONE", reason: "G3_LOCAL_EVIDENCE_NOT_PRODUCTIVE" };
  }

  if (input.gmvBucket !== "G1" && input.gmvBucket !== "G2") return { kind: "NONE", reason: "UNSUPPORTED_GMV_BRANCH" };
  if (input.partitionType === "V2_SEED") {
    const eligible = saturated || uniqueRate >= DEFAULT_FIRST_SPLIT_MIN_UNIQUE_RATE || newPerPage >= DEFAULT_FIRST_SPLIT_MIN_NEW_PER_PAGE;
    return eligible ? { kind: "FOLLOWER", bounds, reason: "G1_G2_FIRST_SPLIT_EVIDENCE" }
      : { kind: "NONE", reason: "FIRST_SPLIT_EVIDENCE_NOT_PRODUCTIVE" };
  }
  if (input.partitionType !== "ADAPTIVE_FOLLOWER" || input.yield == null) return { kind: "NONE", reason: "NOT_FOLLOWER_RECURSION" };
  const deeperEligible = input.yield >= deepMinimumYield && newPerPage >= DEFAULT_FIRST_SPLIT_MIN_NEW_PER_PAGE
    && (saturated || uniqueRate >= DEFAULT_FIRST_SPLIT_MIN_UNIQUE_RATE);
  return deeperEligible ? { kind: "FOLLOWER", bounds, reason: "G1_G2_DEEP_PRODUCTIVITY" }
    : { kind: "NONE", reason: "DEEPER_EVIDENCE_NOT_PRODUCTIVE" };
}

export function partitionFilters(partition: { categoryId: string | null; categoryChildIds: string[]; followersMin: number | null;
  followersMax: number | null; gmvBucket: string | null; gmvRange: string | null }): CreatorFilters {
  if (!partition.categoryId || partition.followersMin == null) throw new Error("Structured Marketplace partition is missing documented filters");
  const gmv = gmvBucketDefinition(partition.gmvBucket);
  if (!gmv || partition.gmvRange !== gmv.range) throw new Error("Specific documented GMV bucket is required for Marketplace discovery");
  const filters: CreatorFilters = { marketplaceCategory: { parentCategoryId: partition.categoryId, childCategoryIds: [...partition.categoryChildIds] },
    minFollowers: partition.followersMin, ...(partition.followersMax == null ? {} : { maxFollowers: partition.followersMax }) };
  filters.marketplaceGmvRanges = [gmv.range];
  return filters;
}
export function validateMarketplaceCategorySelection(parentCategoryId: string, childCategoryIds: string[], catalog: MarketplaceCategoryCatalogNode[]): void {
  const byId = new Map(catalog.map((category) => [category.categoryId, category])), parent = byId.get(parentCategoryId);
  if (!parent) throw new Error("Marketplace partition category is absent from the verified TikTok catalog");
  if (parent.parentCategoryId !== null) throw new Error("Marketplace partition parent must be a verified root category");
  if (parent.enabledForCreatorCrawl === false) throw new Error("Marketplace partition category is not enabled for creator crawling");
  if (!childCategoryIds.length) throw new Error("Marketplace partition category requires at least one verified immediate child");
  if (new Set(childCategoryIds).size !== childCategoryIds.length) throw new Error("Marketplace partition category contains duplicate child IDs");
  for (const childId of childCategoryIds) {
    const child = byId.get(childId);
    if (!child || child.parentCategoryId !== parentCategoryId) throw new Error("Marketplace category child must be exactly one catalog level below its parent");
    if (child.availableForCreatorFilter === false) throw new Error("Marketplace category child is disabled or stale");
  }
}
export function validateV2CategorySelection(parentCategoryId: string, childCategoryIds: string[], catalog: MarketplaceCategoryCatalogNode[]) {
  if (childCategoryIds.length !== 1) throw new Error("V2 Marketplace partition must contain exactly one immediate child category");
  validateMarketplaceCategorySelection(parentCategoryId, childCategoryIds, catalog);
}
export function categoryChildSnapshot(parentCategoryId: string, catalog: MarketplaceCategoryCatalogNode[]): string[] {
  const childIds = catalog.filter((node) => node.parentCategoryId === parentCategoryId && node.availableForCreatorFilter !== false)
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.categoryId.localeCompare(right.categoryId)).map((node) => node.categoryId);
  validateMarketplaceCategorySelection(parentCategoryId, childIds, catalog);
  return childIds;
}
export function v2BasePartitionRows(catalog: MarketplaceCategoryCatalogNode[]) {
  const parents = catalog.filter((node) => node.parentCategoryId === null && node.enabledForCreatorCrawl !== false && node.availableForCreatorFilter !== false)
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.categoryId.localeCompare(right.categoryId));
  const rows: Array<{ partitionKey: string; parentCategoryId: string; parentCategoryName: string; childCategoryId: string; childCategoryName: string;
    followerBucket: string; followersMin: number; followersMax: number | null; gmvBucket: GmvBucketCode; gmvRange: string; queuePosition: bigint }> = [];
  for (const parent of parents) {
    const children = catalog.filter((node) => node.parentCategoryId === parent.categoryId && node.availableForCreatorFilter !== false)
      .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.categoryId.localeCompare(right.categoryId));
    for (const child of children) for (const bucket of FOLLOWER_BUCKETS) for (const gmv of GMV_BUCKETS) {
      if (bucket.min < CREATOR_FOLLOWER_HARD_FLOOR) throw new Error("V2 follower partition violates the hard floor");
      rows.push({ partitionKey: partitionKeyV2(parent.categoryId, child.categoryId, bucket.min, bucket.max, gmv.code), parentCategoryId: parent.categoryId,
        parentCategoryName: parent.categoryName ?? parent.categoryId, childCategoryId: child.categoryId, childCategoryName: child.categoryName ?? child.categoryId,
        followerBucket: bucket.code, followersMin: bucket.min, followersMax: bucket.max, gmvBucket: gmv.code, gmvRange: gmv.range,
        queuePosition: BigInt(rows.length + 1) * BASE_QUEUE_GAP });
    }
  }
  return rows;
}
export function partitionLabel(partition: { categoryName: string; categoryChildName?: string | null; followersMin?: number | null;
  followersMax?: number | null; gmvBucket: string | null }) {
  const category = partition.categoryChildName ? `${partition.categoryName} → ${partition.categoryChildName}` : partition.categoryName;
  const follower = followerRangeLabel(partition.followersMin ?? null, partition.followersMax ?? null);
  const gmv = GMV_BUCKETS.find((bucket) => bucket.code === partition.gmvBucket)?.label ?? "All GMV";
  return `${category} / ${follower} / ${gmv}`;
}
