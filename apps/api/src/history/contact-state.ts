import { lockCreatorEligibility, type Prisma } from "@affiliate/db";

/** Rebuild from exact provider-message identities, preserving delivery/import facts. */
export async function rebuildHistoricalContactState(
  db: Prisma.TransactionClient,
  shopId: string,
  creatorId: string
): Promise<void> {
  await lockCreatorEligibility(db, shopId, [creatorId]);
  const creator = await db.creator.findUniqueOrThrow({ where: { id: creatorId }, select: { creatorOpenId: true } });
  const [deliveries, messages, facts, unknownDeliveries, inboundCount] = await Promise.all([
    db.outreachDelivery.findMany({
      where: { state: "SENT", recipient: { creatorId }, campaign: { shopId } },
      select: { id: true, externalMessageId: true, sentAt: true, firstDispatchedAt: true, campaignId: true },
      orderBy: { sentAt: "desc" }
    }),
    db.conversationMessage.findMany({
      where: { direction: "OUTBOUND", conversation: { shopId, creatorId } },
      select: { externalMessageId: true, providerCreatedAt: true }
    }),
    creator.creatorOpenId ? db.historicalContactFact.findMany({ where: { shopId, creatorOpenId: creator.creatorOpenId } }) : Promise.resolve([]),
    db.outreachDelivery.count({ where: { state: { in: ["DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN_UNRESOLVED"] }, recipient: { creatorId }, campaign: { shopId } } }),
    db.conversationMessage.count({ where: { direction: "INBOUND", conversation: { shopId, creatorId } } })
  ]);
  const contacts = new Map<string, Date>();
  for (const delivery of deliveries) contacts.set(delivery.externalMessageId ? `provider:${delivery.externalMessageId}` : `delivery:${delivery.id}`, delivery.sentAt ?? delivery.firstDispatchedAt ?? new Date(0));
  for (const message of messages) contacts.set(`provider:${message.externalMessageId}`, message.providerCreatedAt);
  for (const fact of facts.filter((item) => item.sendStatus === "SENT" && item.resolutionState === "MATCHED")) {
    contacts.set(fact.externalMessageId ? `provider:${fact.externalMessageId}` : `historical:${fact.identityKey}`, fact.contactedAt);
  }
  const dates = [...contacts.values()].filter((date) => date.getTime() > 0).sort((a, b) => a.getTime() - b.getTime());
  const historicalDates = [
    ...messages.map((item) => item.providerCreatedAt),
    ...facts.filter((item) => item.resolutionState === "MATCHED").map((item) => item.contactedAt)
  ].sort((a, b) => a.getTime() - b.getTime());
  const latestDelivery = deliveries[0];
  await db.creatorShopContactState.upsert({
    where: { shopId_creatorId: { shopId, creatorId } },
    update: {
      firstContactedAt: dates[0] ?? null,
      lastContactedAt: dates.at(-1) ?? null,
      contactCount: contacts.size,
      historyCoverageStart: historicalDates[0] ?? undefined,
      unresolvedDelivery: unknownDeliveries > 0 || facts.some((item) => item.sendStatus === "UNKNOWN" && item.resolutionState === "MATCHED"),
      latestReplyStatus: inboundCount > 0 ? "REPLIED" : undefined,
      lastCampaignId: latestDelivery?.campaignId,
      lastDeliveryId: latestDelivery?.id
    },
    create: {
      shopId, creatorId,
      firstContactedAt: dates[0] ?? null,
      lastContactedAt: dates.at(-1) ?? null,
      contactCount: contacts.size,
      historyCoverageStart: historicalDates[0],
      unresolvedDelivery: unknownDeliveries > 0 || facts.some((item) => item.sendStatus === "UNKNOWN" && item.resolutionState === "MATCHED"),
      latestReplyStatus: inboundCount > 0 ? "REPLIED" : "NONE",
      lastCampaignId: latestDelivery?.campaignId,
      lastDeliveryId: latestDelivery?.id
    }
  });
}
