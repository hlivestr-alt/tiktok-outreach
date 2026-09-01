CREATE TYPE "CreatorSearchPartitionType" AS ENUM (
  'LEGACY', 'V2_SEED', 'EXPERIMENT', 'ADAPTIVE_FOLLOWER', 'ADAPTIVE_GMV'
);

CREATE TYPE "CreatorObservedSaturationState" AS ENUM (
  'UNKNOWN', 'OBSERVED_SATURATED', 'NOT_OBSERVED_SATURATED'
);

CREATE TYPE "CreatorBranchClassification" AS ENUM (
  'UNCLASSIFIED', 'STRONG', 'PRODUCTIVE', 'MARGINAL', 'LOW_VALUE', 'EFFECTIVELY_DEAD'
);

ALTER TABLE "CreatorSyncJob"
  ADD COLUMN "partitionClaimSequence" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CreatorSyncPage"
  ADD COLUMN "newUniqueCreators" INTEGER,
  ADD COLUMN "duplicateRows" INTEGER,
  ADD COLUMN "newCreatorOpenIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "CreatorSearchPartition"
  ADD COLUMN "partitionType" "CreatorSearchPartitionType" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "adaptiveDepth" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "throttleAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "originalYield" DECIMAL(10,8),
  ADD COLUMN "incrementalYield" DECIMAL(10,8),
  ADD COLUMN "combinedChildIncrementalYield" DECIMAL(10,8),
  ADD COLUMN "observedSaturationState" "CreatorObservedSaturationState" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "branchClassification" "CreatorBranchClassification" NOT NULL DEFAULT 'UNCLASSIFIED',
  ADD COLUMN "followerSplitExplored" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "followerRecursionTerminal" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "gmvSplitCreated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "priorityScore" DECIMAL(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN "priorityReason" TEXT,
  ADD COLUMN "priorityUpdatedAt" TIMESTAMP(3);

CREATE INDEX "CreatorSearchPartition_creatorSyncJobId_partitionType_status_priorityScore_queuePosition_idx"
  ON "CreatorSearchPartition"("creatorSyncJobId", "partitionType", "status", "priorityScore", "queuePosition");

-- Classify existing rows without changing their status, search cursor, metrics,
-- queue identity, parent link, receipts, or timestamps.
UPDATE "CreatorSearchPartition"
SET "partitionType" = CASE
      WHEN "partitionKey" LIKE 'experiment:split:%' THEN 'EXPERIMENT'::"CreatorSearchPartitionType"
      WHEN "generation" = 2 AND "partitionKey" LIKE 'v2:%' THEN 'V2_SEED'::"CreatorSearchPartitionType"
      ELSE 'LEGACY'::"CreatorSearchPartitionType"
    END,
    "adaptiveDepth" = CASE WHEN "partitionKey" LIKE 'experiment:split:%' THEN 1 ELSE 0 END;

UPDATE "CreatorSearchPartition" partition
SET "throttleAttempts" = throttle.count
FROM (
  SELECT "creatorSearchPartitionId", count(*)::integer AS count
  FROM "CreatorSyncEvent"
  WHERE stage = 'TIKTOK_THROTTLED' AND "creatorSearchPartitionId" IS NOT NULL
  GROUP BY "creatorSearchPartitionId"
) throttle
WHERE partition.id = throttle."creatorSearchPartitionId";

UPDATE "CreatorSearchPartition"
SET "newCreatorsPerRequest" = CASE
      WHEN "marketplaceRequests" > 0 THEN "uniqueCreatorsAdded"::decimal / "marketplaceRequests"::decimal
      ELSE "newCreatorsPerRequest"
    END,
    "originalYield" = CASE
      WHEN "partitionType" = 'V2_SEED' AND "rowsReturned" > 0
        THEN "uniqueCreatorsAdded"::decimal / "rowsReturned"::decimal
      ELSE NULL
    END,
    "incrementalYield" = CASE
      WHEN "partitionType" IN ('EXPERIMENT', 'ADAPTIVE_FOLLOWER', 'ADAPTIVE_GMV') AND "rowsReturned" > 0
        THEN "uniqueCreatorsAdded"::decimal / "rowsReturned"::decimal
      ELSE NULL
    END,
    "observedSaturationState" = CASE
      WHEN "status" IN ('COMPLETE', 'SPLIT', 'DEEPLY_SATURATED') AND "rowsReturned" BETWEEN 380 AND 405
        THEN 'OBSERVED_SATURATED'::"CreatorObservedSaturationState"
      WHEN "status" IN ('COMPLETE', 'SPLIT', 'DEEPLY_SATURATED')
        THEN 'NOT_OBSERVED_SATURATED'::"CreatorObservedSaturationState"
      ELSE 'UNKNOWN'::"CreatorObservedSaturationState"
    END;

UPDATE "CreatorSearchPartition"
SET "branchClassification" = CASE
  WHEN COALESCE("incrementalYield", "originalYield") IS NULL THEN 'UNCLASSIFIED'::"CreatorBranchClassification"
  WHEN COALESCE("incrementalYield", "originalYield") <= 0.02 THEN 'EFFECTIVELY_DEAD'::"CreatorBranchClassification"
  WHEN COALESCE("incrementalYield", "originalYield") < 0.05 THEN 'LOW_VALUE'::"CreatorBranchClassification"
  WHEN COALESCE("incrementalYield", "originalYield") < 0.10 THEN 'MARGINAL'::"CreatorBranchClassification"
  WHEN COALESCE("incrementalYield", "originalYield") < 0.20 THEN 'PRODUCTIVE'::"CreatorBranchClassification"
  ELSE 'STRONG'::"CreatorBranchClassification"
END;

UPDATE "CreatorSearchPartition"
SET "priorityScore" = 400,
    "priorityReason" = CASE WHEN status = 'QUEUED' THEN 'Untested V2 seed exploration' ELSE 'V2 seed metadata' END,
    "priorityUpdatedAt" = CURRENT_TIMESTAMP
WHERE "partitionType" = 'V2_SEED';

-- Materialize the first production exploratory split for already-completed,
-- empirically saturated V2 roots. Experiment children are intentionally ignored
-- and the v3 namespace makes these fresh Marketplace searches.
WITH eligible AS (
  SELECT parent.*,
         floor((parent."followersMin"::bigint + parent."followersMax"::bigint) / 2)::integer AS midpoint
  FROM "CreatorSearchPartition" parent
  WHERE parent."partitionType" = 'V2_SEED'
    AND parent.status IN ('COMPLETE', 'SPLIT')
    AND parent."observedSaturationState" = 'OBSERVED_SATURATED'
    AND parent."followersMin" >= 600
    AND parent."followersMax" IS NOT NULL
    AND parent."followersMax" - parent."followersMin" + 1 >= 500
    AND parent."followerSplitExplored" = false
), children AS (
  SELECT eligible.*, eligible."followersMin" AS child_min, eligible.midpoint AS child_max, 1 AS ordinal
  FROM eligible
  UNION ALL
  SELECT eligible.*, eligible.midpoint + 1 AS child_min, eligible."followersMax" AS child_max, 2 AS ordinal
  FROM eligible
)
INSERT INTO "CreatorSearchPartition" (
  id, "creatorSyncJobId", "partitionKey", generation, "partitionType", "adaptiveDepth",
  "categoryId", "categoryName", "categoryChildId", "categoryChildName", "categoryChildIds",
  "followersMin", "followersMax", "parentPartitionId", status, "queuePosition",
  "priorityScore", "priorityReason", "priorityUpdatedAt", "createdAt", "updatedAt"
)
SELECT gen_random_uuid()::text, "creatorSyncJobId",
       'v3:' || "partitionKey" || ':f' || child_min::text || '-' || child_max::text,
       3, 'ADAPTIVE_FOLLOWER'::"CreatorSearchPartitionType", 1,
       "categoryId", "categoryName", "categoryChildId", "categoryChildName", "categoryChildIds",
       child_min, child_max, id, 'QUEUED'::"CreatorSearchPartitionStatus",
       "queuePosition" * 100 + ordinal,
       1000 + COALESCE("newCreatorsPerRequest", 0) * 25 + COALESCE("originalYield", 0) * 500 - 25,
       'First exploratory split of observed-saturated V2 seed', CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM children
ON CONFLICT ("creatorSyncJobId", "partitionKey") DO NOTHING;

UPDATE "CreatorSearchPartition" parent
SET "followerSplitExplored" = true
WHERE parent."partitionType" = 'V2_SEED'
  AND (
    SELECT count(*) FROM "CreatorSearchPartition" child
    WHERE child."parentPartitionId" = parent.id
      AND child."partitionType" = 'ADAPTIVE_FOLLOWER'
  ) = 2;

-- Preserve the one exact paused V2 continuation as the next/current item.
-- Cursor values are copied, never reset or synthesized.
WITH paused AS (
  SELECT DISTINCT ON ("creatorSyncJobId") "creatorSyncJobId", id, "privateSearchKey", "privateNextPageToken"
  FROM "CreatorSearchPartition"
  WHERE "partitionType" = 'V2_SEED' AND status = 'PAUSED'
  ORDER BY "creatorSyncJobId", "updatedAt" DESC, id
)
UPDATE "CreatorSyncJob" job
SET "crawlerGeneration" = 3,
    state = 'PAUSED',
    "currentStage" = 'PAUSED',
    "pauseRequested" = false,
    "nextAttemptAt" = NULL,
    "leaseId" = NULL,
    "leaseExpiresAt" = NULL,
    "currentPartitionId" = paused.id,
    "privateSearchKey" = paused."privateSearchKey",
    "privateNextPageToken" = paused."privateNextPageToken"
FROM paused
WHERE paused."creatorSyncJobId" = job.id;

UPDATE "CreatorSyncJob" job
SET "crawlerGeneration" = 3,
    state = 'PAUSED',
    "currentStage" = 'PAUSED',
    "pauseRequested" = false,
    "nextAttemptAt" = NULL,
    "leaseId" = NULL,
    "leaseExpiresAt" = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "CreatorSearchPartition" partition
  WHERE partition."creatorSyncJobId" = job.id
    AND partition."partitionType" = 'V2_SEED'
    AND partition.status = 'PAUSED'
);
