-- Legacy Creator.creatorOpenId values may have originated from CSV imports.
-- Preserve the namespaced row, but require provider-observed evidence before it
-- can satisfy Marketplace identity readiness.
UPDATE "CreatorProviderIdentity"
SET "linkState" = 'UNRESOLVED', "updatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'TIKTOK_SHOP'
  AND "identityType" = 'TIKTOK_CREATOR_OPEN_ID'
  AND "evidenceType" = 'MIGRATED_EXACT_FIELD';
