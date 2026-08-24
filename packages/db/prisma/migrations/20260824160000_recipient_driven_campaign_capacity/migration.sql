-- Campaign capacity is determined only by the frozen recipient set. Preserve
-- dispatch counters for observability and pacing controls for rate governance.
INSERT INTO "SafetySettingsAudit" ("id", "shopId", "source", "previousValues", "effectiveValues", "createdAt")
SELECT gen_random_uuid(), "id", 'RECIPIENT_DRIVEN_CAMPAIGN_CAPACITY_MIGRATION',
  jsonb_build_object(
    'maxRecipientsPerCampaign', "maxRecipientsPerCampaign",
    'maxDispatchAttemptsPerCampaign', "maxDispatchAttemptsPerCampaign",
    'maxSendsPerDay', "maxSendsPerDay"
  ),
  jsonb_build_object(
    'maxRecipientsPerCampaign', "maxRecipientsPerCampaign",
    'maxSendsPerHour', "maxSendsPerHour",
    'maxDispatchesPerMinute', "maxDispatchesPerMinute",
    'outboundPacingMs', "outboundPacingMs",
    'dailyDispatchCounterRetained', true,
    'campaignDispatchCounterRetained', true,
    'reason', 'Removed daily and fixed per-campaign dispatch-attempt blockers; frozen recipient terminal outcomes determine completion'
  ), CURRENT_TIMESTAMP
FROM "Shop";

-- Keep legacy columns physically present for rolling deployment compatibility
-- with older API containers. New generated clients do not expose or read them.
-- Existing daily rows retain their historical ceiling snapshot; new counter rows
-- no longer need one because it is not an enforcement input.
ALTER TABLE "ShopOutboundDailyUsage" ALTER COLUMN "ceiling" DROP NOT NULL;
