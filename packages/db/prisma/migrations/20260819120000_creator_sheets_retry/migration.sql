ALTER TABLE "CreatorSyncEvent"
  ADD COLUMN "googleApiCode" TEXT,
  ADD COLUMN "retryable" BOOLEAN;

ALTER TABLE "CreatorSyncPage"
  ADD COLUMN "sheetsAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextSheetsAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastSheetsHttpStatus" INTEGER,
  ADD COLUMN "lastSheetsApiCode" TEXT,
  ADD COLUMN "lastSheetsRetryable" BOOLEAN,
  ADD COLUMN "lastSheetsError" TEXT;
