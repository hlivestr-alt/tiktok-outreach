-- The durable 1,000-recipient mock benchmark showed that 32 simultaneous
-- interactive Prisma transactions can exhaust the default pool. Keep 16 as
-- the application/DB technical default while retaining adaptive provider flow.
ALTER TABLE "ProviderOutboundLimiter" ALTER COLUMN "technicalMaxConcurrency" SET DEFAULT 16;
UPDATE "ProviderOutboundLimiter"
SET "technicalMaxConcurrency" = LEAST("technicalMaxConcurrency", 16),
    "effectiveConcurrency" = LEAST("effectiveConcurrency", 16),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "technicalMaxConcurrency" > 16 OR "effectiveConcurrency" > 16;
