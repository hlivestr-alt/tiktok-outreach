import { lockCreatorEligibility, Prisma, PrismaClient } from "@affiliate/db";

export class SafetyDelay extends Error {
  constructor(readonly delayMs: number, message: string) { super(message); }
}

export const shopDate = (date: Date, timezone: string): Date => {
  const formatted = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return new Date(`${formatted}T00:00:00.000Z`);
};

type DispatchClaim = { claimed: true; attemptNumber: number; leaseOwner: string } | { claimed: false; cancelled: boolean; reason?: string };

export async function reserveDispatchSlot(prisma: PrismaClient, recipient: any, now = new Date()): Promise<DispatchClaim> {
  return prisma.$transaction(async (tx) => {
    await lockCreatorEligibility(tx, recipient.campaign.shopId, [recipient.creatorId]);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outbound:${recipient.campaign.shopId}`}))`;
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: recipient.campaignId }, include: { shop: true } });
    const currentDelivery = await tx.outreachDelivery.findUniqueOrThrow({ where: { id: recipient.delivery.id } });
    if (!["PENDING", "FAILED_RETRYABLE"].includes(currentDelivery.state)) return { claimed: false as const, cancelled: false };
    if (!["QUEUED", "RUNNING"].includes(campaign.state)) return { claimed: false as const, cancelled: false };
    const activeLease = await tx.shopOutboundLease.findUnique({ where: { shopId: campaign.shopId } });
    if (activeLease && activeLease.expiresAt > now && activeLease.deliveryId !== currentDelivery.id) {
      throw new SafetyDelay(Math.max(1000, activeLease.expiresAt.getTime() - now.getTime()), "Another outbound mutation sequence is active for this shop");
    }
    if (campaign.shop.outboundNextAllowedAt && campaign.shop.outboundNextAllowedAt > now && activeLease?.deliveryId !== currentDelivery.id) {
      throw new SafetyDelay(campaign.shop.outboundNextAllowedAt.getTime() - now.getTime(), "Shop outbound pacing interval is active");
    }

    const [currentRecipient, reservation, contact] = await Promise.all([
      tx.campaignRecipient.findUniqueOrThrow({ where: { id: recipient.id } }),
      tx.outreachReservation.findUnique({ where: { campaignRecipientId: recipient.id } }),
      tx.creatorShopContactState.findUnique({
        where: { shopId_creatorId: { shopId: campaign.shopId, creatorId: recipient.creatorId } }
      })
    ]);
    let exclusionReason: string | undefined;
    let exclusionDetail: string | undefined;
    if (contact?.doNotContact) {
      exclusionReason = "DO_NOT_CONTACT";
      exclusionDetail = "Creator was marked do-not-contact after campaign confirmation";
    } else if (contact?.unresolvedDelivery && contact.lastDeliveryId !== currentDelivery.id) {
      exclusionReason = "DELIVERY_UNKNOWN";
      exclusionDetail = "Creator has an unresolved delivery from another outreach delivery";
    } else if (!reservation || reservation.expiresAt <= now || reservation.shopId !== campaign.shopId || reservation.creatorId !== recipient.creatorId
      || reservation.campaignRecipientId !== currentRecipient.id || currentRecipient.campaignId !== campaign.id) {
      exclusionReason = "RESERVATION_INVALID";
      exclusionDetail = "The active reservation no longer belongs to this campaign recipient";
    } else {
      const ownConfirmedContact = contact?.lastCampaignId === campaign.id && contact.lastDeliveryId === currentDelivery.id;
      const cutoff = new Date(now.getTime() - campaign.cooldownDays * 86_400_000);
      if (!ownConfirmedContact && contact?.lastContactedAt && contact.lastContactedAt > cutoff) {
        exclusionReason = "COOLDOWN_CHANGED";
        exclusionDetail = `An external contact at ${contact.lastContactedAt.toISOString()} made dispatch unsafe`;
      }
    }
    if (exclusionReason) {
      await tx.outreachDelivery.update({ where: { id: currentDelivery.id }, data: {
        state: "FAILED_TERMINAL", lastErrorCode: `SAFETY_${exclusionReason}`, lastErrorDetail: exclusionDetail
      } });
      await tx.campaignRecipient.update({ where: { id: currentRecipient.id }, data: {
        state: "CANCELLED", eligibility: "EXCLUDED", skipReason: exclusionReason, skipDetail: exclusionDetail
      } });
      await tx.outreachReservation.deleteMany({ where: { campaignRecipientId: currentRecipient.id } });
      await tx.queueOutbox.updateMany({ where: { recipientId: currentRecipient.id }, data: {
        state: "COMPLETED", lastError: `Safety cancellation: ${exclusionReason}`
      } });
      await tx.auditEvent.create({ data: {
        shopId: campaign.shopId, campaignId: campaign.id, eventType: "RECIPIENT_CANCELLED_PRE_DISPATCH",
        payload: { recipientId: currentRecipient.id, creatorId: recipient.creatorId, deliveryId: currentDelivery.id, reason: exclusionReason, detail: exclusionDetail }
      } });
      return { claimed: false as const, cancelled: true, reason: exclusionReason };
    }
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const recent = await tx.outboundDispatchEvent.count({ where: { shopId: campaign.shopId, dispatchedAt: { gt: oneMinuteAgo } } });
    if (recent >= campaign.shop.maxDispatchesPerMinute) throw new SafetyDelay(60_000, "Absolute dispatch-rate ceiling reached");
    const oneHourAgo = new Date(now.getTime() - 3_600_000);
    const recentHour = await tx.outboundDispatchEvent.count({ where: { shopId: campaign.shopId, dispatchedAt: { gt: oneHourAgo } } });
    if (recentHour >= campaign.shop.maxSendsPerHour) throw new SafetyDelay(15 * 60_000, "Hourly shop safety ceiling reached");
    const date = shopDate(now, campaign.shop.timezone);
    await tx.shopOutboundDailyUsage.upsert({
      where: { shopId_shopDate: { shopId: campaign.shopId, shopDate: date } },
      update: { dispatchCount: { increment: 1 } },
      create: { shopId: campaign.shopId, shopDate: date, dispatchCount: 1 }
    });
    const leaseOwner = `${currentDelivery.id}:${currentDelivery.attemptCount + 1}`;
    await tx.shopOutboundLease.upsert({ where: { shopId: campaign.shopId }, update: {
      leaseOwner, deliveryId: currentDelivery.id, expiresAt: new Date(now.getTime() + 120_000)
    }, create: { shopId: campaign.shopId, leaseOwner, deliveryId: currentDelivery.id, expiresAt: new Date(now.getTime() + 120_000) } });
    await tx.shop.update({ where: { id: campaign.shopId }, data: { outboundNextAllowedAt: new Date(now.getTime() + campaign.shop.outboundPacingMs) } });
    await tx.outboundDispatchEvent.create({ data: { shopId: campaign.shopId, campaignId: campaign.id, deliveryId: recipient.delivery.id, dispatchedAt: now } });
    await tx.campaign.update({ where: { id: campaign.id }, data: { dispatchCount: { increment: 1 }, state: "RUNNING" } });
    await tx.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
      state: "DISPATCHING", firstDispatchedAt: currentDelivery.firstDispatchedAt ?? now, lastAttemptedAt: now, attemptCount: { increment: 1 }
    } });
    await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "PROCESSING" } });
    return { claimed: true as const, attemptNumber: currentDelivery.attemptCount + 1, leaseOwner };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function releaseDispatchLease(prisma: PrismaClient, shopId: string, leaseOwner: string): Promise<void> {
  await prisma.shopOutboundLease.deleteMany({ where: { shopId, leaseOwner } });
}
