-- Separate recipient and provider-dispatch ceilings while preserving configured values.
ALTER TYPE "CampaignState" ADD VALUE 'PREVIEW_EXPIRED' AFTER 'PREVIEW_READY';
ALTER TYPE "CampaignState" ADD VALUE 'SAFETY_PAUSED' AFTER 'PAUSED';

ALTER TABLE "Shop" RENAME COLUMN "maxSendsPerCampaign" TO "maxRecipientsPerCampaign";
ALTER TABLE "Shop" ADD COLUMN "maxDispatchAttemptsPerCampaign" INTEGER NOT NULL DEFAULT 4000;
ALTER TABLE "Campaign" ADD COLUMN "safetyPauseReason" TEXT;

-- Durable queue intent. PostgreSQL remains authoritative and deterministic job ids make replay safe.
CREATE TABLE "QueueOutbox" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "queueName" TEXT NOT NULL DEFAULT 'outreach',
  "jobName" TEXT NOT NULL DEFAULT 'send',
  "deterministicJobId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "enqueueAttempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "enqueuedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QueueOutbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QueueOutbox_deliveryId_key" ON "QueueOutbox"("deliveryId");
CREATE UNIQUE INDEX "QueueOutbox_recipientId_key" ON "QueueOutbox"("recipientId");
CREATE UNIQUE INDEX "QueueOutbox_deterministicJobId_key" ON "QueueOutbox"("deterministicJobId");
CREATE INDEX "QueueOutbox_state_availableAt_idx" ON "QueueOutbox"("state", "availableAt");
CREATE INDEX "QueueOutbox_campaignId_idx" ON "QueueOutbox"("campaignId");
ALTER TABLE "QueueOutbox" ADD CONSTRAINT "QueueOutbox_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QueueOutbox" ADD CONSTRAINT "QueueOutbox_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "OutreachDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cross-file historical identity ledger. Import rows remain immutable audit evidence.
ALTER TABLE "HistoricalContactRecord" ADD COLUMN "shopId" TEXT;
ALTER TABLE "HistoricalContactRecord" ADD COLUMN "identityKey" TEXT;
ALTER TABLE "HistoricalContactRecord" ADD COLUMN "contactFactId" TEXT;
ALTER TABLE "HistoricalContactRecord" ADD COLUMN "supersededByRecordId" TEXT;
UPDATE "HistoricalContactRecord" r
SET "shopId" = i."shopId",
    "identityKey" = 'legacy:' || r."importId" || ':' || r."sourceRecordId"
FROM "HistoricalContactImport" i
WHERE i."id" = r."importId";
ALTER TABLE "HistoricalContactRecord" ALTER COLUMN "shopId" SET NOT NULL;
ALTER TABLE "HistoricalContactRecord" ALTER COLUMN "identityKey" SET NOT NULL;
CREATE INDEX "HistoricalContactRecord_shopId_identityKey_idx" ON "HistoricalContactRecord"("shopId", "identityKey");

CREATE TABLE "HistoricalContactFact" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "identityKey" TEXT NOT NULL,
  "externalSource" TEXT NOT NULL,
  "sourceRecordId" TEXT,
  "externalMessageId" TEXT,
  "creatorOpenId" TEXT,
  "conversationId" TEXT,
  "contactedAt" TIMESTAMP(3) NOT NULL,
  "sendStatus" TEXT NOT NULL,
  "resolutionState" TEXT NOT NULL,
  "currentRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HistoricalContactFact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoricalContactFact_shopId_identityKey_key" ON "HistoricalContactFact"("shopId", "identityKey");
CREATE INDEX "HistoricalContactFact_shopId_creatorOpenId_contactedAt_idx" ON "HistoricalContactFact"("shopId", "creatorOpenId", "contactedAt");
ALTER TABLE "HistoricalContactFact" ADD CONSTRAINT "HistoricalContactFact_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HistoricalContactRecord" ADD CONSTRAINT "HistoricalContactRecord_contactFactId_fkey" FOREIGN KEY ("contactFactId") REFERENCES "HistoricalContactFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Settings are database-authoritative after initialization and every future mutation has an audit home.
CREATE TABLE "SafetySettingsAudit" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "actor" TEXT NOT NULL DEFAULT 'system-initialization',
  "source" TEXT NOT NULL,
  "previousValues" JSONB,
  "effectiveValues" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SafetySettingsAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SafetySettingsAudit_shopId_createdAt_idx" ON "SafetySettingsAudit"("shopId", "createdAt");
ALTER TABLE "SafetySettingsAudit" ADD CONSTRAINT "SafetySettingsAudit_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
