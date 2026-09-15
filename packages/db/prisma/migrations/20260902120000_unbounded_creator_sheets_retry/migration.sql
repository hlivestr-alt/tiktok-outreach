-- Creator Database Sheet reconciliation is durable and retry-unbounded.
-- These timestamps distinguish completed PostgreSQL persistence from the
-- external Sheet write and preserve outage telemetry across every restart.
ALTER TABLE "CreatorSyncPage"
  ADD COLUMN "databasePersistedAt" TIMESTAMP(3),
  ADD COLUMN "sheetsFirstFailureAt" TIMESTAMP(3),
  ADD COLUMN "sheetsLastAttemptAt" TIMESTAMP(3);

-- The previous pipeline always completed PostgreSQL persistence before it
-- entered one of these Sheet stages. Backfill the marker so an existing
-- staged page resumes with the Sheet operation only after deployment.
UPDATE "CreatorSyncPage" AS page
SET "databasePersistedAt" = COALESCE(page."databasePersistedAt", page."receivedAt"),
    "sheetsFirstFailureAt" = CASE
      WHEN page."sheetsAttemptCount" > 0 THEN COALESCE(page."sheetsFirstFailureAt", page."receivedAt")
      ELSE page."sheetsFirstFailureAt"
    END,
    "sheetsLastAttemptAt" = CASE
      WHEN page."sheetsAttemptCount" > 0 THEN COALESCE(page."sheetsLastAttemptAt", page."receivedAt")
      ELSE page."sheetsLastAttemptAt"
    END
FROM "CreatorSyncJob" AS job
WHERE page."creatorSyncJobId" = job.id
  AND page.state = 'RECEIVED'::"CreatorSyncPageState"
  AND job."currentStage" IN ('SAVING_SHEET', 'RECONCILING_SHEET', 'WAITING_SHEET_RETRY', 'SHEET_RETRY_LIMIT', 'SHEET_ERROR');

-- Jobs paused only by the former retry cap or a Sheet authentication/
-- permission classification become automatically recoverable. An explicit
-- operator PAUSED stage is deliberately not changed.
UPDATE "CreatorSyncJob" AS job
SET state = 'WAITING'::"CreatorSyncState",
    "currentStage" = CASE
      WHEN page."lastSheetsRetryable" = false THEN 'SHEETS_BLOCKED_RETRYING'
      ELSE 'WAITING_SHEET_RETRY'
    END,
    "nextAttemptAt" = CURRENT_TIMESTAMP + CASE
      WHEN page."lastSheetsRetryable" = false THEN INTERVAL '5 minutes'
      ELSE INTERVAL '5 seconds'
    END,
    "pauseRequested" = false,
    "leaseId" = NULL,
    "leaseExpiresAt" = NULL
FROM "CreatorSyncPage" AS page
WHERE page."creatorSyncJobId" = job.id
  AND page.state = 'RECEIVED'::"CreatorSyncPageState"
  AND job."currentStage" IN ('SHEET_RETRY_LIMIT', 'SHEET_ERROR');

UPDATE "CreatorSyncPage" AS page
SET "nextSheetsAttemptAt" = job."nextAttemptAt"
FROM "CreatorSyncJob" AS job
WHERE page."creatorSyncJobId" = job.id
  AND page.state = 'RECEIVED'::"CreatorSyncPageState"
  AND job."currentStage" IN ('WAITING_SHEET_RETRY', 'SHEETS_BLOCKED_RETRYING');

UPDATE "CreatorSearchPartition" AS partition
SET status = 'WAITING_RETRY'::"CreatorSearchPartitionStatus"
FROM "CreatorSyncJob" AS job, "CreatorSyncPage" AS page
WHERE page."creatorSyncJobId" = job.id
  AND page."creatorSearchPartitionId" = partition.id
  AND page.state = 'RECEIVED'::"CreatorSyncPageState"
  AND job."currentStage" IN ('WAITING_SHEET_RETRY', 'SHEETS_BLOCKED_RETRYING')
  AND partition.status = 'PAUSED'::"CreatorSearchPartitionStatus"
  AND partition."gmvBucket" IS NOT NULL;
