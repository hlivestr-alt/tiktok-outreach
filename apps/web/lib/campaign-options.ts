import { CREATOR_GMV_BUCKETS } from "@affiliate/domain";

const number = new Intl.NumberFormat("en-US");

export const CAMPAIGN_FOLLOWER_RANGES = [
  { code: "C1", label: "0–10K", min: 0, max: 9_999 },
  { code: "C2", label: "10K–50K", min: 10_000, max: 49_999 },
  { code: "C3", label: "50K–100K", min: 50_000, max: 99_999 },
  { code: "C4", label: "100K–1M", min: 100_000, max: 999_999 },
  { code: "C5", label: "1M+", min: 1_000_000, max: null }
] as const;

export const CAMPAIGN_GMV_OPTIONS = CREATOR_GMV_BUCKETS.map((bucket) => ({
  ...bucket,
  description: bucket.max == null ? `${number.format(bucket.min)}+` : `${number.format(bucket.min)}–${number.format(bucket.max)}`
}));

export function followerFilters(code: string): { minFollowers?: number; maxFollowers?: number } {
  const option = CAMPAIGN_FOLLOWER_RANGES.find((item) => item.code === code);
  return option ? { minFollowers: option.min, ...(option.max == null ? {} : { maxFollowers: option.max }) } : {};
}

export function campaignFollowerRangeCode(filters: { minFollowers?: number; maxFollowers?: number }): string {
  const exact = CAMPAIGN_FOLLOWER_RANGES.find((range) =>
    range.min === filters.minFollowers && (range.max ?? undefined) === filters.maxFollowers
  );
  return exact?.code ?? "CUSTOM";
}

export function gmvFilters(code: string): { minGmv?: number; maxGmv?: number } {
  const option = CAMPAIGN_GMV_OPTIONS.find((item) => item.code === code);
  return option ? { minGmv: option.min, ...(option.max == null ? {} : { maxGmv: option.max }) } : {};
}
