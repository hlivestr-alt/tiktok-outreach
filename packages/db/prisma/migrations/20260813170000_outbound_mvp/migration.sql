-- Complete the outbound MVP without resetting or rewriting existing data.
ALTER TYPE "CampaignState" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "RecipientState" ADD VALUE IF NOT EXISTS 'RESTRICTED';
ALTER TYPE "DeliveryState" ADD VALUE IF NOT EXISTS 'RESTRICTED';
ALTER TYPE "DeliveryState" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "Shop"
  ADD COLUMN "maxSendsPerHour" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "outboundPacingMs" INTEGER NOT NULL DEFAULT 5000,
  ADD COLUMN "outboundNextAllowedAt" TIMESTAMP(3);

ALTER TABLE "Campaign"
  ADD COLUMN "frozenFilters" JSONB,
  ADD COLUMN "frozenTemplate" TEXT,
  ADD COLUMN "frozenContext" JSONB;

ALTER TABLE "CampaignRecipient"
  ADD COLUMN "creatorOpenIdSnapshot" TEXT,
  ADD COLUMN "recipientSnapshot" JSONB,
  ADD COLUMN "frozenRank" INTEGER;

ALTER TABLE "OutreachDelivery" ADD COLUMN "lastAttemptedAt" TIMESTAMP(3);

UPDATE "CampaignRecipient" AS recipient
SET "creatorOpenIdSnapshot" = creator."creatorOpenId"
FROM "Creator" AS creator
WHERE recipient."creatorId" = creator.id
  AND recipient."frozenMessage" IS NOT NULL
  AND recipient."creatorOpenIdSnapshot" IS NULL;

CREATE TABLE "ShopOutboundLease" (
  "shopId" TEXT NOT NULL,
  "leaseOwner" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopOutboundLease_pkey" PRIMARY KEY ("shopId")
);
CREATE INDEX "ShopOutboundLease_expiresAt_idx" ON "ShopOutboundLease"("expiresAt");
ALTER TABLE "ShopOutboundLease" ADD CONSTRAINT "ShopOutboundLease_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
