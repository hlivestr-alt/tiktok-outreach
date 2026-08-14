ALTER TABLE "CreatorMetricSnapshot" ADD COLUMN "shopId" TEXT;
CREATE INDEX "CreatorMetricSnapshot_shopId_sourceFetchedAt_idx" ON "CreatorMetricSnapshot"("shopId", "sourceFetchedAt");
ALTER TABLE "CreatorMetricSnapshot" ADD CONSTRAINT "CreatorMetricSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
