CREATE TYPE "HistorySyncState" AS ENUM ('QUEUED', 'RUNNING', 'BACKING_OFF', 'PAUSED', 'COMPLETE', 'FAILED');
CREATE TYPE "HistorySyncMode" AS ENUM ('INITIAL_BACKFILL', 'INCREMENTAL');
CREATE TYPE "HistorySyncPassKind" AS ENUM ('BACKFILL', 'HEAD', 'INCREMENTAL');
CREATE TYPE "HistorySyncPhase" AS ENUM ('LIST', 'MESSAGES');
CREATE TYPE "HistoryConversationWorkState" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETE');

CREATE TABLE "HistorySyncJob" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "state" "HistorySyncState" NOT NULL DEFAULT 'QUEUED',
  "mode" "HistorySyncMode" NOT NULL DEFAULT 'INITIAL_BACKFILL',
  "passKind" "HistorySyncPassKind" NOT NULL DEFAULT 'BACKFILL',
  "phase" "HistorySyncPhase" NOT NULL DEFAULT 'LIST',
  "pageSequence" INTEGER NOT NULL DEFAULT 0,
  "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
  "conversationsDiscovered" INTEGER NOT NULL DEFAULT 0,
  "conversationsImported" INTEGER NOT NULL DEFAULT 0,
  "conversationsCompleted" INTEGER NOT NULL DEFAULT 0,
  "messagesImported" INTEGER NOT NULL DEFAULT 0,
  "totalProviderRequests" INTEGER NOT NULL DEFAULT 0,
  "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
  "cursorRecoveryCount" INTEGER NOT NULL DEFAULT 0,
  "backfillPagesSinceHead" INTEGER NOT NULL DEFAULT 0,
  "incrementalPageIndex" INTEGER NOT NULL DEFAULT 0,
  "privateBackfillPageToken" TEXT,
  "privateIncrementalPageToken" TEXT,
  "privatePendingNextPageToken" TEXT,
  "privatePendingHasMore" BOOLEAN,
  "lastProviderCode" TEXT,
  "lastErrorCategory" TEXT,
  "lastSuccessfulProviderRequestAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "initialCompletedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HistorySyncJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HistorySyncConversationWork" (
  "id" TEXT NOT NULL,
  "historySyncJobId" TEXT NOT NULL,
  "pageSequence" INTEGER NOT NULL,
  "externalConversationId" TEXT NOT NULL,
  "creatorImId" TEXT NOT NULL,
  "username" TEXT,
  "avatarUrl" TEXT,
  "unreadCount" INTEGER NOT NULL DEFAULT 0,
  "state" "HistoryConversationWorkState" NOT NULL DEFAULT 'QUEUED',
  "privateMessagePageToken" TEXT,
  "messagesImported" INTEGER NOT NULL DEFAULT 0,
  "providerRequests" INTEGER NOT NULL DEFAULT 0,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HistorySyncConversationWork_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HistorySyncJob_shopId_key" ON "HistorySyncJob"("shopId");
CREATE INDEX "HistorySyncJob_state_nextAttemptAt_idx" ON "HistorySyncJob"("state", "nextAttemptAt");
CREATE INDEX "HistorySyncJob_leaseExpiresAt_idx" ON "HistorySyncJob"("leaseExpiresAt");
CREATE UNIQUE INDEX "HistorySyncConversationWork_historySyncJobId_pageSequence_externalConversationId_key" ON "HistorySyncConversationWork"("historySyncJobId", "pageSequence", "externalConversationId");
CREATE INDEX "HistorySyncConversationWork_historySyncJobId_pageSequence_state_idx" ON "HistorySyncConversationWork"("historySyncJobId", "pageSequence", "state");
ALTER TABLE "HistorySyncJob" ADD CONSTRAINT "HistorySyncJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HistorySyncConversationWork" ADD CONSTRAINT "HistorySyncConversationWork_historySyncJobId_fkey" FOREIGN KEY ("historySyncJobId") REFERENCES "HistorySyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
