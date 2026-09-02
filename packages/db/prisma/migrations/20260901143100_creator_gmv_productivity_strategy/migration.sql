-- Post-GMV-All scheduler strategy. This migration is additive and preserves
-- every partition, cursor, receipt, relationship, metric, and audit record.

ALTER TABLE "CreatorSearchPartition"
  ADD COLUMN "schedulerFamilyKey" TEXT,
  ADD COLUMN "schedulerG1G2FirstBucket" TEXT,
  ADD COLUMN "schedulerWasFirstG1G2Sibling" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "schedulerIsG4Probe" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "splitDecisionReason" TEXT,
  ADD COLUMN "splitParentRows" INTEGER,
  ADD COLUMN "splitParentUniqueRate" DECIMAL(10,8),
  ADD COLUMN "splitParentNewPerPage" DECIMAL(14,6),
  ADD COLUMN "splitParentObservedSaturated" BOOLEAN,
  ADD COLUMN "followerRecursionStopReason" TEXT;

-- Persist a stable, approximately balanced G1/G2 first-sibling designation.
-- The MD5 digest is used only as a deterministic distribution function, not
-- for security. The application uses the same UTF-8 digest rule for new rows.
WITH designated AS (
  SELECT id,
    lower("categoryId") || ':' || lower("categoryChildId") || ':' ||
      "followersMin"::text || ':' || COALESCE("followersMax"::text, 'plus') AS family_key
  FROM "CreatorSearchPartition"
  WHERE "partitionType" = 'V2_SEED'
    AND "gmvBucket" IN ('G1', 'G2')
    AND "categoryId" IS NOT NULL
    AND "categoryChildId" IS NOT NULL
    AND "followersMin" IS NOT NULL
)
UPDATE "CreatorSearchPartition" AS partition
SET "schedulerFamilyKey" = designated.family_key,
    "schedulerG1G2FirstBucket" = CASE
      WHEN get_byte(decode(md5(designated.family_key), 'hex'), 0) % 2 = 0 THEN 'G1'
      ELSE 'G2'
    END
FROM designated
WHERE partition.id = designated.id;

-- Very High leaves normal scheduling without deleting or erroring any row.
-- Completed history is untouched; only queued work changes eligibility.
UPDATE "CreatorSearchPartition"
SET "status" = 'EXPERIMENT_ONLY'::"CreatorSearchPartitionStatus",
    "schedulerClass" = 'EXPERIMENT_ONLY'::"CreatorSchedulerClass",
    "priorityReason" = 'Very High retained for deterministic rare probing',
    "priorityUpdatedAt" = CURRENT_TIMESTAMP
WHERE "gmvBucket" = 'G4'
  AND "partitionType" IN ('V2_SEED', 'ADAPTIVE_FOLLOWER', 'ADAPTIVE_GMV')
  AND "status" = 'QUEUED';

CREATE INDEX "CreatorSearchPartition_creatorSyncJobId_gmvBucket_status_family_idx"
  ON "CreatorSearchPartition"("creatorSyncJobId", "gmvBucket", "status", "schedulerFamilyKey");
