ALTER TABLE "CreatorSyncJob"
  ADD COLUMN "currentStage" TEXT NOT NULL DEFAULT 'PAUSED',
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastResponseAt" TIMESTAMP(3),
  ADD COLUMN "lastAttemptPage" INTEGER,
  ADD COLUMN "lastHttpStatus" INTEGER,
  ADD COLUMN "lastTikTokCode" TEXT,
  ADD COLUMN "lastSafeError" TEXT,
  ADD COLUMN "lastCreatorsReturned" INTEGER,
  ADD COLUMN "lastCreatorsAdded" INTEGER,
  ADD COLUMN "lastDuplicates" INTEGER;

CREATE TABLE "CreatorSyncEvent" (
  "id" TEXT NOT NULL,
  "creatorSyncJobId" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "pageNumber" INTEGER,
  "httpStatus" INTEGER,
  "tiktokCode" TEXT,
  "safeMessage" TEXT,
  "creatorsReturned" INTEGER,
  "creatorsAdded" INTEGER,
  "duplicates" INTEGER,
  "nextAttemptAt" TIMESTAMP(3),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorSyncEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreatorSyncEvent_creatorSyncJobId_occurredAt_idx"
  ON "CreatorSyncEvent"("creatorSyncJobId", "occurredAt");

ALTER TABLE "CreatorSyncEvent"
  ADD CONSTRAINT "CreatorSyncEvent_creatorSyncJobId_fkey"
  FOREIGN KEY ("creatorSyncJobId") REFERENCES "CreatorSyncJob"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
