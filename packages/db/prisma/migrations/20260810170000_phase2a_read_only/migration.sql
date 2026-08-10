-- Phase 2A read-only TikTok connection metadata and identity separation.
ALTER TYPE "ConnectionMode" RENAME TO "ConnectionMode_old";
CREATE TYPE "ConnectionMode" AS ENUM ('MOCK', 'DISABLED', 'READ_ONLY');
ALTER TABLE "Shop" ALTER COLUMN "connectionMode" DROP DEFAULT;
ALTER TABLE "Shop" ALTER COLUMN "connectionMode" TYPE "ConnectionMode" USING (CASE WHEN "connectionMode"::text = 'PRODUCTION' THEN 'DISABLED' ELSE "connectionMode"::text END)::"ConnectionMode";
ALTER TABLE "IntegrationConnection" ALTER COLUMN "mode" DROP DEFAULT;
ALTER TABLE "IntegrationConnection" ALTER COLUMN "mode" TYPE "ConnectionMode" USING (CASE WHEN "mode"::text = 'PRODUCTION' THEN 'DISABLED' ELSE "mode"::text END)::"ConnectionMode";
ALTER TABLE "Shop" ALTER COLUMN "connectionMode" SET DEFAULT 'MOCK';
ALTER TABLE "IntegrationConnection" ALTER COLUMN "mode" SET DEFAULT 'MOCK';
DROP TYPE "ConnectionMode_old";

ALTER TABLE "Shop" ADD COLUMN "shopCode" TEXT,
ADD COLUMN "sellerType" TEXT,
ADD COLUMN "selectedForReadOnly" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "IntegrationConnection" ADD COLUMN "sellerOpenId" TEXT,
ADD COLUMN "lastAuthorizedAt" TIMESTAMP(3),
ADD COLUMN "lastRefreshAt" TIMESTAMP(3),
ADD COLUMN "lastRefreshFailureAt" TIMESTAMP(3),
ADD COLUMN "refreshFailureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastErrorCode" TEXT,
ADD COLUMN "lastErrorMessage" TEXT,
ADD COLUMN "lastApiRequestAt" TIMESTAMP(3),
ADD COLUMN "lastRequestId" TEXT;

CREATE TABLE "TikTokAuthorizationState" (
  "id" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TikTokAuthorizationState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TikTokAuthorizationState_stateHash_key" ON "TikTokAuthorizationState"("stateHash");
CREATE INDEX "TikTokAuthorizationState_expiresAt_consumedAt_idx" ON "TikTokAuthorizationState"("expiresAt", "consumedAt");

ALTER TABLE "Creator" ADD COLUMN "creatorImId" TEXT;
CREATE UNIQUE INDEX "Creator_creatorImId_key" ON "Creator"("creatorImId");

ALTER TABLE "CreatorMetricSnapshot" ALTER COLUMN "followerCount" DROP NOT NULL,
ALTER COLUMN "gmvAmount" DROP NOT NULL,
ALTER COLUMN "gmvCurrency" DROP NOT NULL,
ALTER COLUMN "unitsSold" DROP NOT NULL,
ALTER COLUMN "avgVideoViews" DROP NOT NULL,
ALTER COLUMN "avgLiveViewers" DROP NOT NULL;
