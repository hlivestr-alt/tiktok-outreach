import { lockCreatorEligibility, PrismaClient } from "@affiliate/db";

export type DeliveryAction = "DISPATCH" | "RECOVER_AS_UNKNOWN" | "SKIP";

export function deliveryAction(state: string): DeliveryAction {
  if (state === "DISPATCHING") return "RECOVER_AS_UNKNOWN";
  if (["SENT", "RESTRICTED", "FAILED_TERMINAL", "CANCELLED", "DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN_UNRESOLVED"].includes(state)) return "SKIP";
  return "DISPATCH";
}

export async function recoverDispatchingDelivery(prisma: PrismaClient, recipient: any): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockCreatorEligibility(tx, recipient.campaign.shopId, [recipient.creatorId]);
    await tx.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: { state: "DELIVERY_UNKNOWN", lastErrorDetail: "Worker restarted after dispatch began" } });
    await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "DELIVERY_UNKNOWN" } });
    await tx.creatorShopContactState.upsert({
      where: { shopId_creatorId: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId } },
      update: { unresolvedDelivery: true, lastDeliveryId: recipient.delivery.id },
      create: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId, unresolvedDelivery: true, lastDeliveryId: recipient.delivery.id }
    });
    await tx.queueOutbox.updateMany({ where: { recipientId: recipient.id }, data: { state: "COMPLETED" } });
  });
}
