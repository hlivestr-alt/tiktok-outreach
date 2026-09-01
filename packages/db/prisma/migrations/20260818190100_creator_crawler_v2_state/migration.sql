ALTER TABLE "CreatorSyncJob"
  ADD COLUMN "crawlerGeneration" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "CreatorSearchPartition"
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "categoryChildId" TEXT,
  ADD COLUMN "categoryChildName" TEXT,
  ADD COLUMN "marketplaceRequests" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "newCreatorsPerRequest" DECIMAL(14,6),
  ADD COLUMN "duplicateRate" DECIMAL(10,8);

CREATE INDEX "CreatorSearchPartition_creatorSyncJobId_generation_status_queuePosition_idx"
  ON "CreatorSearchPartition"("creatorSyncJobId", "generation", "status", "queuePosition");

-- Preserve V1 rows and receipts. Only never-started broad work is retired.
UPDATE "CreatorSearchPartition"
SET "status" = 'SUPERSEDED'
WHERE "generation" = 1
  AND "status" = 'QUEUED'
  AND "pagesCompleted" = 0
  AND "privateSearchKey" IS NULL
  AND "privateNextPageToken" IS NULL;

UPDATE "CreatorSearchPartition"
SET "status" = 'PAUSED'
WHERE "generation" = 1
  AND "status" IN ('STARTING', 'RUNNING', 'WAITING_RETRY');

-- Generate every valid root -> immediate child x F01-F25 in deterministic order.
WITH follower_buckets(code, bucket_order, followers_min, followers_max) AS (
  VALUES
    ('F01', 1, 600, 799), ('F02', 2, 800, 999),
    ('F03', 3, 1000, 1499), ('F04', 4, 1500, 1999),
    ('F05', 5, 2000, 2999), ('F06', 6, 3000, 3999), ('F07', 7, 4000, 4999),
    ('F08', 8, 5000, 7499), ('F09', 9, 7500, 9999),
    ('F10', 10, 10000, 14999), ('F11', 11, 15000, 24999),
    ('F12', 12, 25000, 34999), ('F13', 13, 35000, 49999),
    ('F14', 14, 50000, 74999), ('F15', 15, 75000, 99999),
    ('F16', 16, 100000, 149999), ('F17', 17, 150000, 249999),
    ('F18', 18, 250000, 349999), ('F19', 19, 350000, 499999),
    ('F20', 20, 500000, 749999), ('F21', 21, 750000, 999999),
    ('F22', 22, 1000000, 1499999), ('F23', 23, 1500000, 2499999),
    ('F24', 24, 2500000, 4999999), ('F25', 25, 5000000, NULL)
), candidates AS (
  SELECT j.id AS job_id, parent."categoryId" AS parent_id, parent."categoryName" AS parent_name,
    child."categoryId" AS child_id, child."categoryName" AS child_name,
    bucket.code, bucket.followers_min, bucket.followers_max,
    row_number() OVER (PARTITION BY j.id ORDER BY parent."sortOrder", parent."categoryId", child."sortOrder", child."categoryId", bucket.bucket_order) AS ordinal
  FROM "CreatorSyncJob" j
  JOIN "CreatorMarketplaceCategory" parent
    ON parent."shopId" = j."shopId"
   AND parent."parentCategoryId" IS NULL
   AND parent."enabledForCreatorCrawl" = true
   AND parent."availableForCreatorFilter" = true
  JOIN "CreatorMarketplaceCategory" child
    ON child."shopId" = parent."shopId"
   AND child."parentCategoryId" = parent."categoryId"
   AND child."availableForCreatorFilter" = true
  CROSS JOIN follower_buckets bucket
)
INSERT INTO "CreatorSearchPartition" (
  "id", "creatorSyncJobId", "partitionKey", "generation",
  "categoryId", "categoryName", "categoryChildId", "categoryChildName", "categoryChildIds",
  "followerBucket", "followersMin", "followersMax", "status", "queuePosition", "createdAt", "updatedAt"
)
SELECT gen_random_uuid()::text, job_id,
  'v2:' || lower(parent_id) || ':' || lower(child_id) || ':f' || followers_min::text || '-' || COALESCE(followers_max::text, 'plus'),
  2, parent_id, parent_name, child_id, child_name, ARRAY[child_id], code, followers_min, followers_max,
  'QUEUED'::"CreatorSearchPartitionStatus", ordinal * 1000000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM candidates
ON CONFLICT ("creatorSyncJobId", "partitionKey") DO NOTHING;

-- Deployment activates the V2 generation but deliberately leaves it paused.
UPDATE "CreatorSyncJob"
SET "crawlerGeneration" = 2,
    "state" = 'PAUSED',
    "currentStage" = 'PAUSED',
    "pauseRequested" = false,
    "nextAttemptAt" = NULL,
    "leaseId" = NULL,
    "leaseExpiresAt" = NULL,
    "currentPartitionId" = NULL,
    "privateSearchKey" = NULL,
    "privateNextPageToken" = NULL;
