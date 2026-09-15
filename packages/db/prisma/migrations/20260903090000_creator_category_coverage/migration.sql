-- Durable category-coverage scheduler state. Existing successful Marketplace
-- receipts are the authority for the initial sampled-category snapshot.

ALTER TABLE "CreatorSyncJob"
  ADD COLUMN "categoryCoverageCompletedAt" TIMESTAMP(3);

ALTER TABLE "CreatorMarketplaceCategory"
  ADD COLUMN "creatorFirstSampledAt" TIMESTAMP(3),
  ADD COLUMN "creatorLastSampledAt" TIMESTAMP(3),
  ADD COLUMN "creatorExplorationClaimCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "creatorLastExplorationClaimAt" TIMESTAMP(3);

ALTER TABLE "CreatorSearchPartition"
  ADD COLUMN "schedulerWasCategoryExploration" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "schedulerCoverageMode" BOOLEAN NOT NULL DEFAULT false;

WITH successful_samples AS (
  SELECT partition."creatorSyncJobId", partition."categoryChildId",
         MIN(page."receivedAt") AS first_sampled_at,
         MAX(page."receivedAt") AS last_sampled_at
  FROM "CreatorSyncPage" page
  JOIN "CreatorSearchPartition" partition ON partition.id = page."creatorSearchPartitionId"
  WHERE partition."partitionType" IN ('V2_SEED', 'ADAPTIVE_FOLLOWER', 'ADAPTIVE_GMV')
    AND partition."categoryChildId" IS NOT NULL
  GROUP BY partition."creatorSyncJobId", partition."categoryChildId"
)
UPDATE "CreatorMarketplaceCategory" category
SET "creatorFirstSampledAt" = sample.first_sampled_at,
    "creatorLastSampledAt" = sample.last_sampled_at
FROM successful_samples sample
JOIN "CreatorSyncJob" job ON job.id = sample."creatorSyncJobId"
WHERE category."shopId" = job."shopId"
  AND category."categoryId" = sample."categoryChildId";

WITH exploration_claims AS (
  SELECT job."shopId", partition."categoryChildId",
         COUNT(*)::integer AS claim_count,
         MAX(partition."startedAt") AS last_claim_at
  FROM "CreatorSearchPartition" partition
  JOIN "CreatorSyncJob" job ON job.id = partition."creatorSyncJobId"
  WHERE partition."partitionType" = 'V2_SEED'
    AND partition."gmvBucket" IN ('G1', 'G2')
    AND partition."schedulerClass" = 'EXPLORATION'
    AND partition."startedAt" IS NOT NULL
    AND partition."categoryChildId" IS NOT NULL
  GROUP BY job."shopId", partition."categoryChildId"
)
UPDATE "CreatorMarketplaceCategory" category
SET "creatorExplorationClaimCount" = claims.claim_count,
    "creatorLastExplorationClaimAt" = claims.last_claim_at
FROM exploration_claims claims
WHERE category."shopId" = claims."shopId"
  AND category."categoryId" = claims."categoryChildId";

WITH parent_claims AS (
  SELECT child."shopId", child."parentCategoryId",
         SUM(child."creatorExplorationClaimCount")::integer AS claim_count,
         MAX(child."creatorLastExplorationClaimAt") AS last_claim_at
  FROM "CreatorMarketplaceCategory" child
  WHERE child."parentCategoryId" IS NOT NULL
  GROUP BY child."shopId", child."parentCategoryId"
)
UPDATE "CreatorMarketplaceCategory" parent
SET "creatorExplorationClaimCount" = claims.claim_count,
    "creatorLastExplorationClaimAt" = claims.last_claim_at
FROM parent_claims claims
WHERE parent."shopId" = claims."shopId"
  AND parent."categoryId" = claims."parentCategoryId";

CREATE INDEX "CreatorMarketplaceCategory_coverage_idx"
  ON "CreatorMarketplaceCategory"("shopId", "parentCategoryId", "availableForCreatorFilter", "creatorFirstSampledAt", "sortOrder");
