-- Durable per-provider, per-shop, per-operation read pacing and single-flight state.
-- This table intentionally contains no credentials, shop cipher, headers, or response bodies.
CREATE TABLE "ProviderReadThrottle" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "shopScope" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "lastRequestAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastThrottleAt" TIMESTAMP(3),
  "consecutiveThrottleCount" INTEGER NOT NULL DEFAULT 0,
  "nextPermittedAt" TIMESTAMP(3),
  "spacingUntil" TIMESTAMP(3),
  "lastProviderRequestId" TEXT,
  "retryAfterMs" INTEGER,
  "leaseId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderReadThrottle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderReadThrottle_provider_shopScope_operation_key"
ON "ProviderReadThrottle"("provider", "shopScope", "operation");
CREATE INDEX "ProviderReadThrottle_provider_shopScope_nextPermittedAt_idx"
ON "ProviderReadThrottle"("provider", "shopScope", "nextPermittedAt");
CREATE INDEX "ProviderReadThrottle_leaseExpiresAt_idx"
ON "ProviderReadThrottle"("leaseExpiresAt");
