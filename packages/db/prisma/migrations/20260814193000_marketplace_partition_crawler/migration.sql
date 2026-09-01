CREATE TYPE "CreatorSearchPartitionStatus" AS ENUM (
  'QUEUED', 'STARTING', 'RUNNING', 'WAITING_RETRY', 'SATURATED',
  'SPLIT', 'COMPLETE', 'PAUSED', 'ERROR'
);

ALTER TABLE "CreatorSyncJob" ALTER COLUMN "privateSearchKey" DROP NOT NULL;
ALTER TABLE "CreatorSyncJob" ADD COLUMN "currentPartitionId" TEXT;

CREATE TABLE "CreatorMarketplaceCategory" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "categoryName" TEXT NOT NULL,
  "parentCategoryId" TEXT,
  "level" INTEGER NOT NULL,
  "enabledForCreatorCrawl" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL,
  "isLeaf" BOOLEAN NOT NULL DEFAULT false,
  "fetchedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorMarketplaceCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorSearchPartition" (
  "id" TEXT NOT NULL,
  "creatorSyncJobId" TEXT NOT NULL,
  "partitionKey" TEXT NOT NULL,
  "categoryId" TEXT,
  "categoryName" TEXT NOT NULL,
  "followerBucket" TEXT,
  "followersMin" INTEGER,
  "followersMax" INTEGER,
  "gmvBucket" TEXT,
  "gmvRange" TEXT,
  "parentPartitionId" TEXT,
  "status" "CreatorSearchPartitionStatus" NOT NULL DEFAULT 'QUEUED',
  "queuePosition" BIGINT NOT NULL,
  "privateSearchKey" TEXT,
  "privateNextPageToken" TEXT,
  "pagesCompleted" INTEGER NOT NULL DEFAULT 0,
  "rowsReturned" INTEGER NOT NULL DEFAULT 0,
  "uniqueCreatorsAdded" INTEGER NOT NULL DEFAULT 0,
  "duplicates" INTEGER NOT NULL DEFAULT 0,
  "mayStillBeDense" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastRequestAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastError" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorSearchPartition_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CreatorSyncEvent" ADD COLUMN "creatorSearchPartitionId" TEXT;
ALTER TABLE "CreatorSyncEvent" ADD COLUMN "partitionKey" TEXT;
ALTER TABLE "CreatorSyncEvent" ADD COLUMN "partitionLabel" TEXT;
ALTER TABLE "CreatorSyncPage" ADD COLUMN "creatorSearchPartitionId" TEXT;

CREATE UNIQUE INDEX "CreatorMarketplaceCategory_shopId_categoryId_key" ON "CreatorMarketplaceCategory"("shopId", "categoryId");
CREATE INDEX "CreatorMarketplaceCategory_shopId_enabledForCreatorCrawl_sortOrder_idx" ON "CreatorMarketplaceCategory"("shopId", "enabledForCreatorCrawl", "sortOrder");
CREATE UNIQUE INDEX "CreatorSearchPartition_creatorSyncJobId_partitionKey_key" ON "CreatorSearchPartition"("creatorSyncJobId", "partitionKey");
CREATE INDEX "CreatorSearchPartition_creatorSyncJobId_status_queuePosition_idx" ON "CreatorSearchPartition"("creatorSyncJobId", "status", "queuePosition");
CREATE INDEX "CreatorSearchPartition_parentPartitionId_idx" ON "CreatorSearchPartition"("parentPartitionId");
CREATE UNIQUE INDEX "CreatorSyncJob_currentPartitionId_key" ON "CreatorSyncJob"("currentPartitionId");

ALTER TABLE "CreatorMarketplaceCategory" ADD CONSTRAINT "CreatorMarketplaceCategory_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorSearchPartition" ADD CONSTRAINT "CreatorSearchPartition_creatorSyncJobId_fkey" FOREIGN KEY ("creatorSyncJobId") REFERENCES "CreatorSyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorSearchPartition" ADD CONSTRAINT "CreatorSearchPartition_parentPartitionId_fkey" FOREIGN KEY ("parentPartitionId") REFERENCES "CreatorSearchPartition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreatorSyncJob" ADD CONSTRAINT "CreatorSyncJob_currentPartitionId_fkey" FOREIGN KEY ("currentPartitionId") REFERENCES "CreatorSearchPartition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreatorSyncEvent" ADD CONSTRAINT "CreatorSyncEvent_creatorSearchPartitionId_fkey" FOREIGN KEY ("creatorSearchPartitionId") REFERENCES "CreatorSearchPartition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreatorSyncPage" ADD CONSTRAINT "CreatorSyncPage_creatorSearchPartitionId_fkey" FOREIGN KEY ("creatorSearchPartitionId") REFERENCES "CreatorSearchPartition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve the already exhausted broad Marketplace sequence as history. It is
-- never queued and its opaque cursor is not exposed by any API projection.
INSERT INTO "CreatorSearchPartition" (
  "id", "creatorSyncJobId", "partitionKey", "categoryName", "status",
  "queuePosition", "privateSearchKey", "privateNextPageToken",
  "pagesCompleted", "rowsReturned", "createdAt", "completedAt", "updatedAt"
)
SELECT gen_random_uuid()::text, "id", 'legacy:all-creators', 'Legacy broad search',
  'COMPLETE'::"CreatorSearchPartitionStatus", -1, "privateSearchKey",
  "privateNextPageToken", "pagesCompleted", "creatorsFetched", "createdAt",
  COALESCE("lastSuccessAt", "updatedAt"), CURRENT_TIMESTAMP
FROM "CreatorSyncJob"
ON CONFLICT ("creatorSyncJobId", "partitionKey") DO NOTHING;

-- Deployment must remain operator-paused. Structured partitions are created by
-- the explicit category refresh/initialization step and Continue starts them.
UPDATE "CreatorSyncJob"
SET "state" = 'PAUSED', "currentStage" = 'PAUSED', "pauseRequested" = false,
    "nextAttemptAt" = NULL, "leaseId" = NULL, "leaseExpiresAt" = NULL,
    "currentPartitionId" = NULL;
