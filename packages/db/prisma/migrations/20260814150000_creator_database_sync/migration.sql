CREATE TYPE "CreatorSyncState" AS ENUM ('IDLE', 'RUNNING', 'PAUSED', 'WAITING', 'EXHAUSTED', 'ERROR');
CREATE TYPE "CreatorSyncPageState" AS ENUM ('RECEIVED', 'COMMITTED');

ALTER TABLE "CreatorMetricSnapshot" ADD COLUMN "sourcePageKey" TEXT;
CREATE UNIQUE INDEX "CreatorMetricSnapshot_creatorId_sourcePageKey_key" ON "CreatorMetricSnapshot"("creatorId", "sourcePageKey");

CREATE TABLE "CreatorSyncJob" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "state" "CreatorSyncState" NOT NULL DEFAULT 'PAUSED',
  "privateSearchKey" TEXT NOT NULL,
  "privateNextPageToken" TEXT,
  "pagesCompleted" INTEGER NOT NULL DEFAULT 10,
  "creatorsFetched" INTEGER NOT NULL DEFAULT 200,
  "creatorsFetchedThisRun" INTEGER NOT NULL DEFAULT 0,
  "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
  "nextAttemptAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "lastPageAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastError" TEXT,
  "lastProviderCode" TEXT,
  "spreadsheetId" TEXT NOT NULL,
  "sheetImportedAt" TIMESTAMP(3),
  "leaseId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorSyncJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreatorSyncPage" (
  "id" TEXT NOT NULL,
  "creatorSyncJobId" TEXT NOT NULL,
  "state" "CreatorSyncPageState" NOT NULL DEFAULT 'RECEIVED',
  "pageNumber" INTEGER NOT NULL,
  "privateRequestToken" TEXT NOT NULL,
  "privateNextToken" TEXT,
  "privateSearchKey" TEXT NOT NULL,
  "providerHasMore" BOOLEAN NOT NULL,
  "creatorsReturned" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt" TIMESTAMP(3),
  CONSTRAINT "CreatorSyncPage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorSyncJob_shopId_key" ON "CreatorSyncJob"("shopId");
CREATE INDEX "CreatorSyncJob_state_nextAttemptAt_idx" ON "CreatorSyncJob"("state", "nextAttemptAt");
CREATE INDEX "CreatorSyncJob_leaseExpiresAt_idx" ON "CreatorSyncJob"("leaseExpiresAt");
CREATE UNIQUE INDEX "CreatorSyncPage_creatorSyncJobId_privateRequestToken_key" ON "CreatorSyncPage"("creatorSyncJobId", "privateRequestToken");
CREATE INDEX "CreatorSyncPage_creatorSyncJobId_state_pageNumber_idx" ON "CreatorSyncPage"("creatorSyncJobId", "state", "pageNumber");
ALTER TABLE "CreatorSyncJob" ADD CONSTRAINT "CreatorSyncJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorSyncPage" ADD CONSTRAINT "CreatorSyncPage_creatorSyncJobId_fkey" FOREIGN KEY ("creatorSyncJobId") REFERENCES "CreatorSyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
