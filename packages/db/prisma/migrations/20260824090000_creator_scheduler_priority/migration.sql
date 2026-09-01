CREATE TYPE "CreatorSchedulerClass" AS ENUM ('HIGH', 'MEDIUM', 'EXPLORATION', 'LOW');

ALTER TABLE "CreatorSearchPartition"
  ADD COLUMN "schedulerClass" "CreatorSchedulerClass",
  ADD COLUMN "schedulerClaimSequence" INTEGER,
  ADD COLUMN "schedulerCategoryRows" DECIMAL(18,3),
  ADD COLUMN "schedulerCategoryYield" DECIMAL(10,8),
  ADD COLUMN "schedulerCategoryWeight" DECIMAL(12,6),
  ADD COLUMN "schedulerFollowerRows" DECIMAL(18,3),
  ADD COLUMN "schedulerFollowerYield" DECIMAL(10,8),
  ADD COLUMN "schedulerFollowerWeight" DECIMAL(12,6),
  ADD COLUMN "schedulerAncestorYield" DECIMAL(10,8),
  ADD COLUMN "schedulerNewPerSuccessfulPage" DECIMAL(14,6);

CREATE INDEX "CreatorSearchPartition_creatorSyncJobId_schedulerClass_schedulerClaimSequence_idx"
  ON "CreatorSearchPartition"("creatorSyncJobId", "schedulerClass", "schedulerClaimSequence");

-- The already-active sequence must resume in place after deployment. This is
-- a decision snapshot only; it does not requeue or otherwise mutate its cursor.
UPDATE "CreatorSearchPartition" AS partition
SET "schedulerClass" = CASE
      WHEN partition."partitionType" = 'V2_SEED' THEN 'EXPLORATION'::"CreatorSchedulerClass"
      WHEN partition."branchClassification" IN ('LOW_VALUE', 'EFFECTIVELY_DEAD') THEN 'LOW'::"CreatorSchedulerClass"
      WHEN partition."adaptiveDepth" >= 2 THEN 'HIGH'::"CreatorSchedulerClass"
      ELSE 'MEDIUM'::"CreatorSchedulerClass"
    END,
    "schedulerClaimSequence" = job."partitionClaimSequence",
    "priorityReason" = COALESCE(partition."priorityReason", 'Existing active partition preserved across scheduler deployment'),
    "priorityUpdatedAt" = CURRENT_TIMESTAMP
FROM "CreatorSyncJob" AS job
WHERE job."currentPartitionId" = partition.id
  AND partition."schedulerClass" IS NULL;
