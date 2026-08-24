-- Raise only the per-campaign recipient ceiling. PostgreSQL remains authoritative
-- for existing shops; dispatch, pacing, concurrency, and retry ceilings are unchanged.
ALTER TABLE "Shop" ALTER COLUMN "maxRecipientsPerCampaign" SET DEFAULT 500;

INSERT INTO "SafetySettingsAudit" ("id", "shopId", "source", "previousValues", "effectiveValues", "createdAt")
SELECT gen_random_uuid(), "id", 'CAMPAIGN_RECIPIENT_CEILING_500_MIGRATION',
  jsonb_build_object('maxRecipientsPerCampaign', "maxRecipientsPerCampaign"),
  jsonb_build_object(
    'maxRecipientsPerCampaign', 500,
    'maxDispatchAttemptsPerCampaign', "maxDispatchAttemptsPerCampaign",
    'maxSendsPerDay', "maxSendsPerDay",
    'maxSendsPerHour', "maxSendsPerHour",
    'maxDispatchesPerMinute', "maxDispatchesPerMinute",
    'outboundPacingMs', "outboundPacingMs",
    'reason', 'Campaign recipient ceiling raised from 100 to 500; all outbound delivery controls unchanged'
  ), CURRENT_TIMESTAMP
FROM "Shop"
WHERE "maxRecipientsPerCampaign" <> 500;

UPDATE "Shop"
SET "maxRecipientsPerCampaign" = 500,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "maxRecipientsPerCampaign" <> 500;
