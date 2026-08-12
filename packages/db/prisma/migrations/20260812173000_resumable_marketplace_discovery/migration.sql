CREATE TYPE "DiscoveryRunState" AS ENUM ('QUEUED', 'RUNNING', 'BACKING_OFF', 'COMPLETE', 'FAILED', 'CANCELLED');

CREATE TABLE "DiscoveryRun" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "state" "DiscoveryRunState" NOT NULL DEFAULT 'QUEUED',
  "requestedTarget" INTEGER NOT NULL,
  "candidateLimit" INTEGER NOT NULL,
  "pagesFetched" INTEGER NOT NULL DEFAULT 0,
  "candidatesFetched" INTEGER NOT NULL DEFAULT 0,
  "consecutiveThrottleCount" INTEGER NOT NULL DEFAULT 0,
  "totalProviderRequests" INTEGER NOT NULL DEFAULT 0,
  "lastProviderCode" TEXT,
  "lastProviderRequestAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "providerSearchKey" TEXT,
  "providerNextPageToken" TEXT,
  "providerHasMore" BOOLEAN NOT NULL DEFAULT true,
  "failureCategory" TEXT,
  "leaseId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryCandidate" (
  "id" TEXT NOT NULL,
  "discoveryRunId" TEXT NOT NULL,
  "creatorOpenId" TEXT NOT NULL,
  "discoveryOrdinal" INTEGER NOT NULL,
  "candidate" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscoveryCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscoveryRun_campaignId_key" ON "DiscoveryRun"("campaignId");
CREATE INDEX "DiscoveryRun_state_nextAttemptAt_idx" ON "DiscoveryRun"("state", "nextAttemptAt");
CREATE INDEX "DiscoveryRun_shopId_state_idx" ON "DiscoveryRun"("shopId", "state");
CREATE INDEX "DiscoveryRun_leaseExpiresAt_idx" ON "DiscoveryRun"("leaseExpiresAt");
CREATE UNIQUE INDEX "DiscoveryCandidate_discoveryRunId_creatorOpenId_key" ON "DiscoveryCandidate"("discoveryRunId", "creatorOpenId");
CREATE INDEX "DiscoveryCandidate_discoveryRunId_discoveryOrdinal_idx" ON "DiscoveryCandidate"("discoveryRunId", "discoveryOrdinal");
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryCandidate" ADD CONSTRAINT "DiscoveryCandidate_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Legacy campaign cursors were publicly exposed. The new private run owns all
-- opaque provider pagination state; existing campaigns remain otherwise intact.
ALTER TABLE "Campaign" DROP COLUMN "searchKey", DROP COLUMN "nextPageToken";
