-- CreateEnum
CREATE TYPE "ConnectionMode" AS ENUM ('MOCK', 'DISABLED', 'READ_ONLY', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "CampaignState" AS ENUM ('DRAFT', 'DISCOVERING', 'PREVIEW_READY', 'FROZEN', 'QUEUED', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_ERRORS');

-- CreateEnum
CREATE TYPE "Eligibility" AS ENUM ('ELIGIBLE', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "RecipientState" AS ENUM ('DISCOVERED', 'ELIGIBLE', 'SELECTED', 'RESERVED', 'QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'DELIVERY_UNKNOWN', 'DELIVERY_UNKNOWN_UNRESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'DISPATCHING', 'SENT', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'DELIVERY_UNKNOWN', 'DELIVERY_UNKNOWN_UNRESOLVED');

-- CreateEnum
CREATE TYPE "SyncState" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "ReconciliationState" AS ENUM ('PENDING', 'MATCHED', 'UNRESOLVED');

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalShopId" TEXT,
    "shopCipher" TEXT,
    "region" TEXT NOT NULL DEFAULT 'ID',
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    "connectionMode" "ConnectionMode" NOT NULL DEFAULT 'MOCK',
    "maxSendsPerCampaign" INTEGER NOT NULL DEFAULT 1000,
    "maxSendsPerDay" INTEGER NOT NULL DEFAULT 1000,
    "maxDispatchesPerMinute" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'TIKTOK_SHOP',
    "mode" "ConnectionMode" NOT NULL DEFAULT 'MOCK',
    "status" TEXT NOT NULL DEFAULT 'READY',
    "grantedScopes" JSONB NOT NULL DEFAULT '[]',
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Creator" (
    "id" TEXT NOT NULL,
    "creatorOpenId" TEXT NOT NULL,
    "creatorUserId" TEXT,
    "username" TEXT,
    "nickname" TEXT,
    "selectionRegion" TEXT NOT NULL DEFAULT 'ID',
    "avatarUrl" TEXT,
    "profileUri" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Creator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorMetricSnapshot" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "followerCount" INTEGER NOT NULL,
    "categoryIds" JSONB NOT NULL,
    "gmvAmount" DECIMAL(24,2) NOT NULL,
    "gmvCurrency" TEXT NOT NULL,
    "unitsSold" INTEGER NOT NULL,
    "avgVideoViews" INTEGER NOT NULL,
    "avgLiveViewers" INTEGER NOT NULL,
    "engagementRate" DECIMAL(10,6),
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "rawPayload" JSONB NOT NULL DEFAULT '{}',
    "sourceFetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorShopContactState" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "firstContactedAt" TIMESTAMP(3),
    "lastContactedAt" TIMESTAMP(3),
    "contactCount" INTEGER NOT NULL DEFAULT 0,
    "lastCampaignId" TEXT,
    "lastDeliveryId" TEXT,
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "unresolvedDelivery" BOOLEAN NOT NULL DEFAULT false,
    "latestReplyStatus" TEXT NOT NULL DEFAULT 'NONE',
    "historyCoverageStart" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorShopContactState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "externalConversationId" TEXT NOT NULL,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "messageType" TEXT NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "providerCreatedAt" TIMESTAMP(3) NOT NULL,
    "importSource" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactHistorySyncRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "state" "SyncState" NOT NULL DEFAULT 'PENDING',
    "cursor" JSONB,
    "earliestCoveredAt" TIMESTAMP(3),
    "latestCoveredAt" TIMESTAMP(3),
    "conversationsScanned" INTEGER NOT NULL DEFAULT 0,
    "messagesImported" INTEGER NOT NULL DEFAULT 0,
    "unmatchedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactHistorySyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalContactImport" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "state" "SyncState" NOT NULL DEFAULT 'PENDING',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "unmatchedCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "HistoricalContactImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalContactRecord" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "creatorOpenId" TEXT,
    "conversationId" TEXT,
    "externalMessageId" TEXT,
    "contactedAt" TIMESTAMP(3) NOT NULL,
    "sendStatus" TEXT NOT NULL,
    "campaignName" TEXT,
    "messageContent" TEXT,
    "resolutionState" TEXT NOT NULL,

    CONSTRAINT "HistoricalContactRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "targetCount" INTEGER NOT NULL,
    "candidateLimit" INTEGER NOT NULL,
    "cooldownDays" INTEGER NOT NULL,
    "messageTemplate" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "rankingMetric" TEXT NOT NULL,
    "rankingDirection" TEXT NOT NULL DEFAULT 'DESC',
    "state" "CampaignState" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "searchKey" TEXT,
    "nextPageToken" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "frozenAt" TIMESTAMP(3),
    "freezeExpiresAt" TIMESTAMP(3),
    "dispatchCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "discoveryOrdinal" INTEGER NOT NULL,
    "eligibility" "Eligibility" NOT NULL,
    "skipReason" TEXT,
    "skipDetail" TEXT,
    "rankingValue" DECIMAL(24,6) NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "frozenMessage" TEXT,
    "contentHash" TEXT,
    "state" "RecipientState" NOT NULL DEFAULT 'DISCOVERED',
    "replyStatus" TEXT NOT NULL DEFAULT 'NONE',

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachReservation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "campaignRecipientId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachDelivery" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignRecipientId" TEXT NOT NULL,
    "conversationId" TEXT,
    "deterministicKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "state" "DeliveryState" NOT NULL DEFAULT 'PENDING',
    "externalMessageId" TEXT,
    "providerRequestId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "firstDispatchedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "providerCode" TEXT,
    "providerRequestId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryReconciliationRun" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "state" "ReconciliationState" NOT NULL DEFAULT 'PENDING',
    "matchedMessageId" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundDispatchEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundDispatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopOutboundDailyUsage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopDate" DATE NOT NULL,
    "dispatchCount" INTEGER NOT NULL DEFAULT 0,
    "ceiling" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopOutboundDailyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "campaignId" TEXT,
    "eventType" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'local-operator',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_externalShopId_key" ON "Shop"("externalShopId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_shopId_provider_key" ON "IntegrationConnection"("shopId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Creator_creatorOpenId_key" ON "Creator"("creatorOpenId");

-- CreateIndex
CREATE INDEX "CreatorMetricSnapshot_creatorId_sourceFetchedAt_idx" ON "CreatorMetricSnapshot"("creatorId", "sourceFetchedAt");

-- CreateIndex
CREATE INDEX "CreatorShopContactState_shopId_lastContactedAt_idx" ON "CreatorShopContactState"("shopId", "lastContactedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorShopContactState_shopId_creatorId_key" ON "CreatorShopContactState"("shopId", "creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_externalConversationId_key" ON "Conversation"("externalConversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_shopId_creatorId_key" ON "Conversation"("shopId", "creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationMessage_externalMessageId_key" ON "ConversationMessage"("externalMessageId");

-- CreateIndex
CREATE INDEX "ConversationMessage_conversationId_providerCreatedAt_idx" ON "ConversationMessage"("conversationId", "providerCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalContactImport_shopId_sourceHash_key" ON "HistoricalContactImport"("shopId", "sourceHash");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalContactRecord_importId_sourceRecordId_key" ON "HistoricalContactRecord"("importId", "sourceRecordId");

-- CreateIndex
CREATE INDEX "Campaign_shopId_state_idx" ON "Campaign"("shopId", "state");

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaignId_selected_state_idx" ON "CampaignRecipient"("campaignId", "selected", "state");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_creatorId_key" ON "CampaignRecipient"("campaignId", "creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachReservation_campaignRecipientId_key" ON "OutreachReservation"("campaignRecipientId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachReservation_shopId_creatorId_key" ON "OutreachReservation"("shopId", "creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachDelivery_campaignRecipientId_key" ON "OutreachDelivery"("campaignRecipientId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachDelivery_deterministicKey_key" ON "OutreachDelivery"("deterministicKey");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachDelivery_externalMessageId_key" ON "OutreachDelivery"("externalMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAttempt_deliveryId_attemptNumber_key" ON "DeliveryAttempt"("deliveryId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryReconciliationRun_deliveryId_attemptNumber_key" ON "DeliveryReconciliationRun"("deliveryId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundDispatchEvent_deliveryId_key" ON "OutboundDispatchEvent"("deliveryId");

-- CreateIndex
CREATE INDEX "OutboundDispatchEvent_shopId_dispatchedAt_idx" ON "OutboundDispatchEvent"("shopId", "dispatchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopOutboundDailyUsage_shopId_shopDate_key" ON "ShopOutboundDailyUsage"("shopId", "shopDate");

-- CreateIndex
CREATE INDEX "AuditEvent_shopId_createdAt_idx" ON "AuditEvent"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "CreatorMetricSnapshot" ADD CONSTRAINT "CreatorMetricSnapshot_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorShopContactState" ADD CONSTRAINT "CreatorShopContactState_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorShopContactState" ADD CONSTRAINT "CreatorShopContactState_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactHistorySyncRun" ADD CONSTRAINT "ContactHistorySyncRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalContactImport" ADD CONSTRAINT "HistoricalContactImport_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalContactRecord" ADD CONSTRAINT "HistoricalContactRecord_importId_fkey" FOREIGN KEY ("importId") REFERENCES "HistoricalContactImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CreatorMetricSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachReservation" ADD CONSTRAINT "OutreachReservation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachReservation" ADD CONSTRAINT "OutreachReservation_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachReservation" ADD CONSTRAINT "OutreachReservation_campaignRecipientId_fkey" FOREIGN KEY ("campaignRecipientId") REFERENCES "CampaignRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDelivery" ADD CONSTRAINT "OutreachDelivery_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDelivery" ADD CONSTRAINT "OutreachDelivery_campaignRecipientId_fkey" FOREIGN KEY ("campaignRecipientId") REFERENCES "CampaignRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDelivery" ADD CONSTRAINT "OutreachDelivery_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "OutreachDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryReconciliationRun" ADD CONSTRAINT "DeliveryReconciliationRun_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "OutreachDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDispatchEvent" ADD CONSTRAINT "OutboundDispatchEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDispatchEvent" ADD CONSTRAINT "OutboundDispatchEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOutboundDailyUsage" ADD CONSTRAINT "ShopOutboundDailyUsage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
