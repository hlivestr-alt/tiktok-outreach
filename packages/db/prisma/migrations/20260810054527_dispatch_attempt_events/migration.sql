-- DropIndex
DROP INDEX "OutboundDispatchEvent_deliveryId_key";

-- CreateIndex
CREATE INDEX "OutboundDispatchEvent_deliveryId_idx" ON "OutboundDispatchEvent"("deliveryId");
