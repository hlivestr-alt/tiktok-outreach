ALTER TABLE "CreatorSyncJob"
  ADD COLUMN "marketplaceRetryDelaySeconds" INTEGER NOT NULL DEFAULT 3;

ALTER TABLE "CreatorSyncJob"
  ADD CONSTRAINT "CreatorSyncJob_marketplaceRetryDelaySeconds_check"
  CHECK ("marketplaceRetryDelaySeconds" >= 1);
