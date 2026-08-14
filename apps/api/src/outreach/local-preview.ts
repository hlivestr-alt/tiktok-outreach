import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@affiliate/db";
import { buildPreview, type ContactState, type CreatorCandidate, type CreatorFilters, type RankingMetric } from "@affiliate/domain";

type PreviewDatabase = Prisma.TransactionClient;

/** Rebuilds recipients from persisted discovery candidates without any provider capability. */
export async function rebuildLocalPreview(db: PreviewDatabase, runId: string, now: Date) {
  const run = await db.discoveryRun.findUniqueOrThrow({
    where: { id: runId },
    include: { campaign: true, candidates: { orderBy: { discoveryOrdinal: "asc" } } }
  });
  if (!run.candidates.length) throw new BadRequestException("A local preview requires persisted discovery candidates");
  const creators = run.candidates.map((row) => row.candidate as unknown as CreatorCandidate);
  const openIds = creators.map((creator) => creator.creatorOpenId);
  if (creators.some((creator, index) => !creator.creatorOpenId || creator.creatorOpenId !== run.candidates[index].creatorOpenId)) {
    throw new BadRequestException("Persisted candidates must contain exact matching Creator Open IDs");
  }
  const existingCreators = await db.creator.findMany({
    where: { creatorOpenId: { in: openIds } },
    include: {
      contacts: { where: { shopId: run.shopId } },
      providerIdentities: {
        where: { provider: "TIKTOK_SHOP", identityType: "TIKTOK_CREATOR_OPEN_ID", linkState: "VERIFIED" }
      }
    }
  });
  const exactCreators = new Map(existingCreators.flatMap((creator) => {
    const exact = creator.creatorOpenId && creator.providerIdentities.some((identity) => identity.identifier === creator.creatorOpenId);
    return exact ? [[creator.creatorOpenId!, creator] as const] : [];
  }));
  if (openIds.some((openId) => !exactCreators.has(openId))) {
    throw new BadRequestException("Every persisted candidate requires verified exact Creator Open ID evidence");
  }
  const contacts = new Map<string, ContactState>(existingCreators.flatMap((creator) => creator.creatorOpenId ? [[creator.creatorOpenId, {
    contactCount: creator.contacts[0]?.contactCount ?? 0,
    lastContactedAt: creator.contacts[0]?.lastContactedAt ?? undefined,
    firstContactedAt: creator.contacts[0]?.firstContactedAt ?? undefined,
    doNotContact: creator.contacts[0]?.doNotContact,
    unresolvedDelivery: creator.contacts[0]?.unresolvedDelivery,
    historical: Boolean(creator.contacts[0]?.historyCoverageStart) && !creator.contacts[0]?.lastCampaignId
  }]] : []));
  const reservations = await db.outreachReservation.findMany({
    where: { shopId: run.shopId, expiresAt: { gt: now } }, include: { creator: true }
  });
  const preview = buildPreview({
    creators, filters: run.campaign.filters as CreatorFilters, contacts,
    activeReservations: new Set(reservations.flatMap((reservation) => reservation.creator.creatorOpenId ? [reservation.creator.creatorOpenId] : [])),
    requested: run.requestedTarget, cooldownDays: run.campaign.cooldownDays,
    rankingMetric: run.campaign.rankingMetric as RankingMetric,
    rankingDirection: run.campaign.rankingDirection as "ASC" | "DESC",
    now, truncated: run.providerHasMore
  });
  const unresolved = await db.creatorShopContactState.aggregate({
    where: { shopId: run.shopId, contactCount: { gt: 0 }, creator: { creatorOpenId: null } },
    _count: { _all: true }, _sum: { contactCount: true }
  });
  const duplicateOccurrences = Math.max(0, run.candidatesFetched - creators.length);
  const summary = {
    ...preview.summary,
    fetchedOccurrences: run.candidatesFetched,
    skippedDuplicates: preview.summary.skippedDuplicates + duplicateOccurrences,
    historyIdentityCoverageIncomplete: unresolved._count._all > 0,
    unresolvedHistoricalCreators: unresolved._count._all,
    unresolvedHistoricalOutboundContacts: unresolved._sum.contactCount ?? 0
  };

  await db.campaignRecipient.deleteMany({ where: { campaignId: run.campaignId } });
  const databaseSnapshotIds = preview.creators.flatMap((creator) => {
    const id = (creator as unknown as { databaseSnapshotId?: string }).databaseSnapshotId;
    return id ? [id] : [];
  });
  const databaseSnapshots = new Map((await db.creatorMetricSnapshot.findMany({ where: { id: { in: databaseSnapshotIds } } })).map((snapshot) => [snapshot.id, snapshot]));
  const recipientRows: Prisma.CampaignRecipientCreateManyInput[] = [];
  for (const evaluated of preview.creators) {
    const creatorId = exactCreators.get(evaluated.creatorOpenId)!.id;
    const databaseSnapshotId = (evaluated as unknown as { databaseSnapshotId?: string }).databaseSnapshotId;
    const existingSnapshot = databaseSnapshotId ? databaseSnapshots.get(databaseSnapshotId) : undefined;
    if (existingSnapshot && existingSnapshot.creatorId !== creatorId) throw new BadRequestException("Creator database snapshot identity mismatch");
    const snapshotId = existingSnapshot?.id ?? (await db.creatorMetricSnapshot.create({ data: {
      creatorId, shopId: run.shopId, followerCount: evaluated.followerCount, categoryIds: evaluated.categoryIds,
      gmvAmount: evaluated.gmv ? new Prisma.Decimal(evaluated.gmv.amount) : null,
      gmvCurrency: evaluated.gmv?.currency, unitsSold: evaluated.unitsSold,
      avgVideoViews: evaluated.avgVideoViews, avgLiveViewers: evaluated.avgLiveViewers,
      engagementRate: evaluated.engagementRate == null ? null : new Prisma.Decimal(evaluated.engagementRate),
      sourceFetchedAt: now, rawPayload: evaluated as unknown as Prisma.InputJsonValue
    } })).id;
    recipientRows.push({
      campaignId: run.campaignId, creatorId, snapshotId,
      discoveryOrdinal: evaluated.discoveryOrdinal, eligibility: evaluated.eligibility,
      skipReason: evaluated.skipReason, skipDetail: evaluated.skipDetail,
      rankingValue: new Prisma.Decimal(evaluated.rankingValue), selected: evaluated.selected,
      state: evaluated.selected ? "SELECTED" : evaluated.eligibility === "ELIGIBLE" ? "ELIGIBLE" : "DISCOVERED"
    });
  }
  for (let offset = 0; offset < recipientRows.length; offset += 1000) await db.campaignRecipient.createMany({ data: recipientRows.slice(offset, offset + 1000) });
  await db.campaign.update({ where: { id: run.campaignId }, data: {
    state: "PREVIEW_READY", summary: summary as unknown as Prisma.InputJsonValue,
    truncated: run.providerHasMore, version: { increment: 1 }
  } });
  await db.discoveryRun.update({ where: { id: runId }, data: {
    state: "COMPLETE", completedAt: now, nextAttemptAt: null, leaseId: null, leaseExpiresAt: null
  } });
  await db.auditEvent.create({ data: {
    shopId: run.shopId, campaignId: run.campaignId, eventType: "PREVIEW_READY",
    payload: summary as unknown as Prisma.InputJsonValue
  } });
  return summary;
}
