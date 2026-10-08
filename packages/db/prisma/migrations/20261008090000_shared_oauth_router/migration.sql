-- Additive only. Pending unbound legacy states fail closed and expire naturally.
ALTER TABLE "TikTokAuthorizationState" ADD COLUMN "browserHash" TEXT,
 ADD COLUMN "operationId" TEXT, ADD COLUMN "routerRegistered" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "TikTokAuthorizationState_operationId_key" ON "TikTokAuthorizationState"("operationId");
ALTER TABLE "TikTokAuthorizationState" ADD CONSTRAINT "native_oauth_binding_shape" CHECK (
 ("browserHash" IS NULL AND "operationId" IS NULL AND NOT "routerRegistered") OR
 ("browserHash" IS NOT NULL AND "browserHash" ~ '^[a-f0-9]{64}$' AND "operationId" IS NOT NULL AND "operationId" ~ '^[a-f0-9-]{36}$'));
CREATE TABLE "TikTokOAuthHandoffNonce" (
 "nonceHash" TEXT PRIMARY KEY CHECK("nonceHash" ~ '^[a-f0-9]{64}$'),
 "expiresAt" TIMESTAMP(3) NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "TikTokOAuthHandoffNonce_expiresAt_idx" ON "TikTokOAuthHandoffNonce"("expiresAt");
