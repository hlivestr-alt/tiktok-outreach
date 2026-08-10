import { Prisma, PrismaClient } from "@affiliate/db";

export class SafetyDelay extends Error {
  constructor(readonly delayMs: number, message: string) { super(message); }
}

export const shopDate = (date: Date, timezone: string): Date => {
  const formatted = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return new Date(`${formatted}T00:00:00.000Z`);
};

export async function reserveDispatchSlot(prisma: PrismaClient, recipient: any, now = new Date()): Promise<{ claimed: true; attemptNumber: number } | { claimed: false }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outbound:${recipient.campaign.shopId}`}))`;
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: recipient.campaignId }, include: { shop: true } });
    const currentDelivery = await tx.outreachDelivery.findUniqueOrThrow({ where: { id: recipient.delivery.id } });
    if (!["PENDING", "FAILED_RETRYABLE"].includes(currentDelivery.state)) return { claimed: false as const };
    if (campaign.dispatchCount >= campaign.shop.maxDispatchAttemptsPerCampaign) {
      const reason = `Campaign dispatch-attempt ceiling of ${campaign.shop.maxDispatchAttemptsPerCampaign} reached`;
      await tx.campaign.update({ where: { id: campaign.id }, data: { state: "SAFETY_PAUSED", safetyPauseReason: reason, version: { increment: 1 } } });
      await tx.auditEvent.create({ data: { shopId: campaign.shopId, campaignId: campaign.id, eventType: "CAMPAIGN_DISPATCH_LIMIT_REACHED", payload: {
        dispatchAttempts: campaign.dispatchCount, ceiling: campaign.shop.maxDispatchAttemptsPerCampaign, reason
      } } });
      await tx.queueOutbox.updateMany({ where: { campaignId: campaign.id, state: { in: ["PENDING", "ENQUEUED"] } }, data: { state: "SAFETY_PAUSED", lastError: reason } });
      return { claimed: false as const };
    }
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const recent = await tx.outboundDispatchEvent.count({ where: { shopId: campaign.shopId, dispatchedAt: { gt: oneMinuteAgo } } });
    if (recent >= campaign.shop.maxDispatchesPerMinute) throw new SafetyDelay(60_000, "Absolute dispatch-rate ceiling reached");
    const date = shopDate(now, campaign.shop.timezone);
    const usage = await tx.shopOutboundDailyUsage.findUnique({ where: { shopId_shopDate: { shopId: campaign.shopId, shopDate: date } } });
    if ((usage?.dispatchCount ?? 0) >= campaign.shop.maxSendsPerDay) throw new SafetyDelay(15 * 60_000, "Daily shop ceiling reached");
    await tx.shopOutboundDailyUsage.upsert({
      where: { shopId_shopDate: { shopId: campaign.shopId, shopDate: date } },
      update: { dispatchCount: { increment: 1 }, ceiling: campaign.shop.maxSendsPerDay },
      create: { shopId: campaign.shopId, shopDate: date, dispatchCount: 1, ceiling: campaign.shop.maxSendsPerDay }
    });
    await tx.outboundDispatchEvent.create({ data: { shopId: campaign.shopId, campaignId: campaign.id, deliveryId: recipient.delivery.id, dispatchedAt: now } });
    await tx.campaign.update({ where: { id: campaign.id }, data: { dispatchCount: { increment: 1 }, state: "RUNNING" } });
    await tx.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
      state: "DISPATCHING", firstDispatchedAt: currentDelivery.firstDispatchedAt ?? now, attemptCount: { increment: 1 }
    } });
    await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "PROCESSING" } });
    return { claimed: true as const, attemptNumber: currentDelivery.attemptCount + 1 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
