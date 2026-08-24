-- Replace application-defined messaging quotas and serial pacing with durable,
-- endpoint-scoped provider feedback. Historical dispatch counters remain.
CREATE TABLE "ProviderOutboundLimiter" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "appScope" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'HEALTHY',
  "effectiveConcurrency" INTEGER NOT NULL DEFAULT 4,
  "technicalMaxConcurrency" INTEGER NOT NULL DEFAULT 32,
  "healthySuccessCount" INTEGER NOT NULL DEFAULT 0,
  "consecutiveThrottleCount" INTEGER NOT NULL DEFAULT 0,
  "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
  "nextPermittedAt" TIMESTAMP(3),
  "lastRequestAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastThrottleAt" TIMESTAMP(3),
  "lastHttpStatus" INTEGER,
  "lastBusinessCode" TEXT,
  "retryAfterMs" INTEGER,
  "quotaBlockedAt" TIMESTAMP(3),
  "quotaCode" TEXT,
  "quotaDetail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderOutboundLimiter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderOutboundPermit" (
  "id" TEXT NOT NULL,
  "limiterId" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderOutboundPermit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderOutboundEvent" (
  "id" TEXT NOT NULL,
  "limiterId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "httpStatus" INTEGER,
  "businessCode" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderOutboundEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderOutboundLimiter_provider_appScope_shopId_operation_key"
  ON "ProviderOutboundLimiter"("provider", "appScope", "shopId", "operation");
CREATE INDEX "ProviderOutboundLimiter_shopId_state_nextPermittedAt_idx"
  ON "ProviderOutboundLimiter"("shopId", "state", "nextPermittedAt");
CREATE UNIQUE INDEX "ProviderOutboundPermit_owner_key" ON "ProviderOutboundPermit"("owner");
CREATE INDEX "ProviderOutboundPermit_limiterId_expiresAt_idx" ON "ProviderOutboundPermit"("limiterId", "expiresAt");
CREATE INDEX "ProviderOutboundEvent_limiterId_occurredAt_idx" ON "ProviderOutboundEvent"("limiterId", "occurredAt");
CREATE INDEX "ProviderOutboundEvent_occurredAt_idx" ON "ProviderOutboundEvent"("occurredAt");

ALTER TABLE "ProviderOutboundLimiter" ADD CONSTRAINT "ProviderOutboundLimiter_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderOutboundPermit" ADD CONSTRAINT "ProviderOutboundPermit_limiterId_fkey"
  FOREIGN KEY ("limiterId") REFERENCES "ProviderOutboundLimiter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderOutboundEvent" ADD CONSTRAINT "ProviderOutboundEvent_limiterId_fkey"
  FOREIGN KEY ("limiterId") REFERENCES "ProviderOutboundLimiter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "SafetySettingsAudit" ("id", "shopId", "source", "previousValues", "effectiveValues", "createdAt")
SELECT gen_random_uuid(), "id", 'PROVIDER_LIMITED_OUTBOUND_MIGRATION',
  jsonb_build_object(
    'maxSendsPerDay', "maxSendsPerDay",
    'maxSendsPerHour', "maxSendsPerHour",
    'maxDispatchesPerMinute', "maxDispatchesPerMinute",
    'outboundPacingMs', "outboundPacingMs"
  ),
  jsonb_build_object(
    'maxRecipientsPerCampaign', "maxRecipientsPerCampaign",
    'providerDrivenAdaptiveConcurrency', true,
    'dailyDispatchCounterRetained', true,
    'campaignDispatchCounterRetained', true,
    'reason', 'Removed local daily/hourly/minute ceilings and fixed success spacing'
  ), CURRENT_TIMESTAMP
FROM "Shop";

-- Keep legacy storage during the rolling deployment because untouched
-- discovery/history images may have an older generated Prisma Shop shape.
-- New application schema, config, API, UI, and workers neither expose nor read
-- these columns, and the former lease table has no runtime writer or reader.
COMMENT ON COLUMN "Shop"."maxSendsPerDay" IS 'LEGACY_NON_ENFORCING: retained only for rolling client compatibility';
COMMENT ON COLUMN "Shop"."maxSendsPerHour" IS 'LEGACY_NON_ENFORCING: retained only for rolling client compatibility';
COMMENT ON COLUMN "Shop"."maxDispatchesPerMinute" IS 'LEGACY_NON_ENFORCING: retained only for rolling client compatibility';
COMMENT ON COLUMN "Shop"."outboundPacingMs" IS 'LEGACY_NON_ENFORCING: retained only for rolling client compatibility';
COMMENT ON COLUMN "Shop"."outboundNextAllowedAt" IS 'LEGACY_NON_ENFORCING: no longer read or written';
COMMENT ON TABLE "ShopOutboundLease" IS 'LEGACY_NON_ENFORCING: replaced by endpoint-scoped ProviderOutboundPermit';
