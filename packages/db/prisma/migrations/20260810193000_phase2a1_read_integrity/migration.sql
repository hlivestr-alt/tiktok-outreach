-- Phase 2A.1: preserve provider identity namespaces and make token refresh crash-safe.
CREATE TYPE "CreatorIdentityType" AS ENUM ('TIKTOK_CREATOR_OPEN_ID', 'TIKTOK_CREATOR_USER_ID', 'TIKTOK_CREATOR_IM_ID');
CREATE TYPE "CreatorIdentityLinkState" AS ENUM ('VERIFIED', 'UNRESOLVED');
CREATE TYPE "TokenRefreshState" AS ENUM ('IDLE', 'IN_PROGRESS', 'FAILED', 'OUTCOME_UNCERTAIN');

ALTER TABLE "Creator" ALTER COLUMN "creatorOpenId" DROP NOT NULL;
CREATE UNIQUE INDEX "Creator_creatorUserId_key" ON "Creator"("creatorUserId");
DROP INDEX "Conversation_shopId_creatorId_key";
CREATE INDEX "Conversation_shopId_creatorId_idx" ON "Conversation"("shopId", "creatorId");

-- Phase 2A used im:<creator_im_id> as a local placeholder in the Open ID column.
-- The actual IM identity remains in creatorImId; the overloaded Open ID is removed.
UPDATE "Creator"
SET "creatorOpenId" = NULL
WHERE "creatorOpenId" LIKE 'im:%' AND "creatorImId" IS NOT NULL;

-- Authorized Shops does not return a GMV currency. Remove the Phase 2A region-based inference.
UPDATE "Shop" SET "currency" = 'UNKNOWN' WHERE "connectionMode" = 'READ_ONLY';

ALTER TABLE "IntegrationConnection"
ADD COLUMN "capabilityStatus" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "refreshState" "TokenRefreshState" NOT NULL DEFAULT 'IDLE',
ADD COLUMN "refreshLeaseId" TEXT,
ADD COLUMN "refreshLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "refreshStartedAt" TIMESTAMP(3),
ADD COLUMN "refreshUncertainAt" TIMESTAMP(3),
ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CreatorProviderIdentity" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'TIKTOK_SHOP',
  "identityType" "CreatorIdentityType" NOT NULL,
  "identifier" TEXT NOT NULL,
  "linkState" "CreatorIdentityLinkState" NOT NULL DEFAULT 'VERIFIED',
  "evidenceType" TEXT NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorProviderIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorProviderIdentity_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CreatorProviderIdentity_provider_identityType_identifier_key"
ON "CreatorProviderIdentity"("provider", "identityType", "identifier");
CREATE INDEX "CreatorProviderIdentity_creatorId_linkState_idx" ON "CreatorProviderIdentity"("creatorId", "linkState");

INSERT INTO "CreatorProviderIdentity" ("id", "creatorId", "identityType", "identifier", "linkState", "evidenceType", "updatedAt")
SELECT gen_random_uuid()::text, "id", 'TIKTOK_CREATOR_OPEN_ID', "creatorOpenId", 'VERIFIED', 'MIGRATED_EXACT_FIELD', CURRENT_TIMESTAMP
FROM "Creator" WHERE "creatorOpenId" IS NOT NULL;

INSERT INTO "CreatorProviderIdentity" ("id", "creatorId", "identityType", "identifier", "linkState", "evidenceType", "updatedAt")
SELECT gen_random_uuid()::text, "id", 'TIKTOK_CREATOR_USER_ID', "creatorUserId", 'VERIFIED', 'MIGRATED_EXACT_FIELD', CURRENT_TIMESTAMP
FROM "Creator" WHERE "creatorUserId" IS NOT NULL;

INSERT INTO "CreatorProviderIdentity" ("id", "creatorId", "identityType", "identifier", "linkState", "evidenceType", "updatedAt")
SELECT gen_random_uuid()::text, "id", 'TIKTOK_CREATOR_IM_ID', "creatorImId",
  CASE WHEN "creatorOpenId" IS NULL THEN 'UNRESOLVED'::"CreatorIdentityLinkState" ELSE 'VERIFIED'::"CreatorIdentityLinkState" END,
  CASE WHEN "creatorOpenId" IS NULL THEN 'MIGRATED_IM_ONLY' ELSE 'MIGRATED_EXACT_FIELD' END,
  CURRENT_TIMESTAMP
FROM "Creator" WHERE "creatorImId" IS NOT NULL;

CREATE TABLE "CreatorIdentityAudit" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'TIKTOK_SHOP',
  "action" TEXT NOT NULL,
  "sourceCreatorId" TEXT NOT NULL,
  "targetCreatorId" TEXT,
  "evidenceType" TEXT NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorIdentityAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CreatorIdentityAudit_sourceCreatorId_createdAt_idx" ON "CreatorIdentityAudit"("sourceCreatorId", "createdAt");
CREATE INDEX "CreatorIdentityAudit_targetCreatorId_createdAt_idx" ON "CreatorIdentityAudit"("targetCreatorId", "createdAt");
