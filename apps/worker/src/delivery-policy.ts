import { PrismaClient } from "@affiliate/db";

export type DeliveryAction = "DISPATCH" | "RECOVER_AS_UNKNOWN" | "SKIP";

export function deliveryAction(state: string): DeliveryAction {
  if (state === "DISPATCHING") return "RECOVER_AS_UNKNOWN";
  if (["SENT", "FAILED_TERMINAL", "DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN_UNRESOLVED"].includes(state)) return "SKIP";
  return "DISPATCH";
}

export async function recoverDispatchingDelivery(prisma: PrismaClient, recipient: any): Promise<void> {
  await prisma.$transaction([
    prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: { state: "DELIVERY_UNKNOWN", lastErrorDetail: "Worker restarted after dispatch began" } }),
    prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "DELIVERY_UNKNOWN" } }),
    prisma.creatorShopContactState.upsert({
      where: { shopId_creatorId: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId } },
      update: { unresolvedDelivery: true }, create: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId, unresolvedDelivery: true }
    }),
    prisma.queueOutbox.updateMany({ where: { recipientId: recipient.id }, data: { state: "COMPLETED" } })
  ]);
}
