-- Conservative application safeguards. These are not TikTok provider quotas.
ALTER TABLE "Shop" ALTER COLUMN "maxRecipientsPerCampaign" SET DEFAULT 100;
ALTER TABLE "Shop" ALTER COLUMN "maxDispatchAttemptsPerCampaign" SET DEFAULT 400;
ALTER TABLE "Shop" ALTER COLUMN "maxSendsPerDay" SET DEFAULT 100;
ALTER TABLE "Shop" ALTER COLUMN "maxSendsPerHour" SET DEFAULT 20;
ALTER TABLE "Shop" ALTER COLUMN "maxDispatchesPerMinute" SET DEFAULT 5;
ALTER TABLE "Shop" ALTER COLUMN "outboundPacingMs" SET DEFAULT 10000;

INSERT INTO "SafetySettingsAudit" ("id", "shopId", "source", "effectiveValues", "createdAt")
SELECT gen_random_uuid(), "id", 'PRODUCTION_HARDENING_MIGRATION',
  jsonb_build_object(
    'maxRecipientsPerCampaign', LEAST("maxRecipientsPerCampaign", 100),
    'maxDispatchAttemptsPerCampaign', LEAST("maxDispatchAttemptsPerCampaign", 400),
    'maxSendsPerDay', LEAST("maxSendsPerDay", 100),
    'maxSendsPerHour', LEAST("maxSendsPerHour", 20),
    'maxDispatchesPerMinute', LEAST("maxDispatchesPerMinute", 5),
    'outboundPacingMs', GREATEST("outboundPacingMs", 10000),
    'reason', 'Conservative production application defaults; not TikTok quotas'
  ), CURRENT_TIMESTAMP
FROM "Shop"
WHERE "maxRecipientsPerCampaign" > 100 OR "maxDispatchAttemptsPerCampaign" > 400
   OR "maxSendsPerDay" > 100 OR "maxSendsPerHour" > 20
   OR "maxDispatchesPerMinute" > 5 OR "outboundPacingMs" < 10000;

UPDATE "Shop" SET
  "maxRecipientsPerCampaign" = LEAST("maxRecipientsPerCampaign", 100),
  "maxDispatchAttemptsPerCampaign" = LEAST("maxDispatchAttemptsPerCampaign", 400),
  "maxSendsPerDay" = LEAST("maxSendsPerDay", 100),
  "maxSendsPerHour" = LEAST("maxSendsPerHour", 20),
  "maxDispatchesPerMinute" = LEAST("maxDispatchesPerMinute", 5),
  "outboundPacingMs" = GREATEST("outboundPacingMs", 10000),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "maxRecipientsPerCampaign" > 100 OR "maxDispatchAttemptsPerCampaign" > 400
   OR "maxSendsPerDay" > 100 OR "maxSendsPerHour" > 20
   OR "maxDispatchesPerMinute" > 5 OR "outboundPacingMs" < 10000;
