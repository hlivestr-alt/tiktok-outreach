-- Future Creator Database work is always category + exact follower bounds +
-- one of the four documented Marketplace GMV ranges. Existing rows, receipts,
-- creator attribution, cursors, and page history are not deleted or rewritten.

CREATE INDEX "CreatorSearchPartition_creatorSyncJobId_gmvBucket_status_queuePosition_idx"
  ON "CreatorSearchPartition"("creatorSyncJobId", "gmvBucket", "status", "queuePosition");

-- Retire all uncompleted GMV-All work. A disabled row retains its exact cursor,
-- page counters, receipts, attribution, and error history. Terminal historical
-- rows remain in their original status for analysis.
UPDATE "CreatorSearchPartition"
SET "status" = 'DISABLED_BY_STRATEGY'::"CreatorSearchPartitionStatus"
WHERE "gmvBucket" IS NULL
  AND "partitionType" IN ('V2_SEED', 'ADAPTIVE_FOLLOWER', 'ADAPTIVE_GMV')
  AND "status" IN ('QUEUED', 'STARTING', 'RUNNING', 'WAITING_RETRY', 'SATURATED', 'PAUSED', 'ERROR');

-- Materialize the four specific-GMV roots for every existing V2 category and
-- follower seed. The logical identity check deliberately ignores the physical
-- key so prior adaptive GMV work is reused even when it used a v3 parent-path
-- key. The unique key remains the final concurrency/idempotency backstop.
WITH gmv(code, gmv_range, bucket_order) AS (
  VALUES
    ('G1', 'GMV_RANGE_0_100', 1),
    ('G2', 'GMV_RANGE_100_1000', 2),
    ('G3', 'GMV_RANGE_1000_10000', 3),
    ('G4', 'GMV_RANGE_10000_AND_ABOVE', 4)
), candidates AS (
  SELECT seed.*, gmv.code, gmv.gmv_range, gmv.bucket_order
  FROM "CreatorSearchPartition" seed
  CROSS JOIN gmv
  WHERE seed."partitionType" = 'V2_SEED'
    AND seed."gmvBucket" IS NULL
    AND seed."categoryId" IS NOT NULL
    AND seed."categoryChildId" IS NOT NULL
    AND seed."followersMin" IS NOT NULL
), missing AS (
  SELECT candidates.*
  FROM candidates
  WHERE NOT EXISTS (
    SELECT 1
    FROM "CreatorSearchPartition" existing
    WHERE existing."creatorSyncJobId" = candidates."creatorSyncJobId"
      AND existing."categoryId" = candidates."categoryId"
      AND existing."categoryChildId" = candidates."categoryChildId"
      AND existing."followersMin" = candidates."followersMin"
      AND existing."followersMax" IS NOT DISTINCT FROM candidates."followersMax"
      AND existing."gmvBucket" = candidates.code
  )
)
INSERT INTO "CreatorSearchPartition" (
  "id", "creatorSyncJobId", "partitionKey", "generation", "partitionType", "adaptiveDepth",
  "categoryId", "categoryName", "categoryChildId", "categoryChildName", "categoryChildIds",
  "followerBucket", "followersMin", "followersMax", "gmvBucket", "gmvRange", "parentPartitionId",
  "status", "queuePosition", "priorityScore", "priorityReason", "priorityUpdatedAt", "createdAt", "updatedAt"
)
SELECT gen_random_uuid()::text,
  missing."creatorSyncJobId",
  'v2:' || lower(missing."categoryId") || ':' || lower(missing."categoryChildId") ||
    ':f' || missing."followersMin"::text || '-' || COALESCE(missing."followersMax"::text, 'plus') ||
    ':g' || lower(missing.code),
  3,
  'V2_SEED'::"CreatorSearchPartitionType",
  0,
  missing."categoryId", missing."categoryName", missing."categoryChildId", missing."categoryChildName", missing."categoryChildIds",
  missing."followerBucket", missing."followersMin", missing."followersMax", missing.code, missing.gmv_range, missing.id,
  'QUEUED'::"CreatorSearchPartitionStatus",
  missing."queuePosition" * 100 + missing.bucket_order,
  100,
  'Untested specific-GMV seed exploration',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM missing
ON CONFLICT ("creatorSyncJobId", "partitionKey") DO NOTHING;

-- Deployment is deliberately operator-paused. Keep the current partition link
-- and job cursor mirror intact when it points at a disabled GMV-All row; the
-- partition itself remains the source of truth for that historical continuation.
UPDATE "CreatorSyncJob"
SET "state" = 'PAUSED',
    "currentStage" = 'PAUSED',
    "pauseRequested" = false,
    "nextAttemptAt" = NULL,
    "leaseId" = NULL,
    "leaseExpiresAt" = NULL;
