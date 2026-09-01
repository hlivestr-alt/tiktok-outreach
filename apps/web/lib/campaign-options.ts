import { CREATOR_FOLLOWER_BUCKETS, CREATOR_GMV_BUCKETS } from "@affiliate/domain";

const number = new Intl.NumberFormat("en-US");

export const CAMPAIGN_FOLLOWER_OPTIONS = CREATOR_FOLLOWER_BUCKETS.map((bucket) => ({
  ...bucket,
  label: bucket.max == null ? `${number.format(bucket.min)}+` : `${number.format(bucket.min)}–${number.format(bucket.max)}`
}));

export const CAMPAIGN_GMV_OPTIONS = CREATOR_GMV_BUCKETS.map((bucket) => ({
  ...bucket,
  description: bucket.max == null ? `${number.format(bucket.min)}+` : `${number.format(bucket.min)}–${number.format(bucket.max)}`
}));

export function followerFilters(code: string): { minFollowers?: number; maxFollowers?: number } {
  const option = CAMPAIGN_FOLLOWER_OPTIONS.find((item) => item.code === code);
  return option ? { minFollowers: option.min, ...(option.max == null ? {} : { maxFollowers: option.max }) } : {};
}

export function gmvFilters(code: string): { minGmv?: number; maxGmv?: number } {
  const option = CAMPAIGN_GMV_OPTIONS.find((item) => item.code === code);
  return option ? { minGmv: option.min, ...(option.max == null ? {} : { maxGmv: option.max }) } : {};
}
