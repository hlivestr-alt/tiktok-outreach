import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { lockCreatorEligibility, Prisma } from "@affiliate/db";
import type { CampaignCreateInput } from "@affiliate/contracts";
import { assertCampaignWithinLimit, buildPreview, renderMessage, type ContactState, type CreatorCandidate, type CreatorFilters, type RankingMetric } from "@affiliate/domain";
import { config, expireFrozenCampaigns, PrismaService, QueueService } from "../shared";
import { TikTokIntegrationService } from "../integrations/tiktok.service";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";

@Injectable()
export class OutreachService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly tiktok: TikTokIntegrationService,
    private readonly identities: CreatorIdentityResolver = new CreatorIdentityResolver(prisma)
  ) {}

  async list() {
    await expireFrozenCampaigns(this.prisma);
    return this.prisma.campaign.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { recipients: true, deliveries: true } } } });
  }

  async create(input: CampaignCreateInput) {
    const shop = await this.tiktok.activeShop();
    const rankingMetrics = new Set(["GMV", "UNITS_SOLD", "FOLLOWERS", "AVG_VIDEO_VIEWS", "AVG_LIVE_VIEWERS", "ENGAGEMENT_RATE", "TIKTOK_RELEVANCE"]);
    try {
      assertCampaignWithinLimit(input.targetCount, {
        maxRecipientsPerCampaign: shop.maxRecipientsPerCampaign,
        maxDispatchAttemptsPerCampaign: shop.maxDispatchAttemptsPerCampaign,
        maxSendsPerDay: shop.maxSendsPerDay, maxDispatchesPerMinute: shop.maxDispatchesPerMinute
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid campaign target");
    }
    if (!input.name?.trim() || !input.productName?.trim() || !input.messageTemplate?.trim()) throw new BadRequestException("Name, product, and message template are required");
    if (!Number.isInteger(input.cooldownDays) || input.cooldownDays < 0) throw new BadRequestException("Cooldown must be zero or more days");
    if (input.messageTemplate.length > 2000) throw new BadRequestException("Message template exceeds the mock provider limit of 2,000 characters");
    if (input.candidateLimit != null && (!Number.isInteger(input.candidateLimit) || input.candidateLimit < input.targetCount)) {
      throw new BadRequestException("Candidate limit must be an integer at least as large as the target");
    }
    if (!rankingMetrics.has(input.rankingMetric)) throw new BadRequestException("Unsupported ranking metric");
    if (input.rankingDirection && !["ASC", "DESC"].includes(input.rankingDirection)) throw new BadRequestException("Unsupported ranking direction");
    if (input.filters?.minFollowers != null && input.filters?.maxFollowers != null && input.filters.minFollowers > input.filters.maxFollowers) {
      throw new BadRequestException("Minimum followers cannot exceed maximum followers");
    }
    if (input.filters?.minGmv != null && input.filters?.maxGmv != null && input.filters.minGmv > input.filters.maxGmv) {
      throw new BadRequestException("Minimum GMV cannot exceed maximum GMV");
    }
    const usesGmv = input.rankingMetric === "GMV" || input.filters?.minGmv != null || input.filters?.maxGmv != null;
    const filters: CreatorFilters = { ...(input.filters ?? {}) };
    if (config.APP_MODE === "mock" && usesGmv) filters.gmvCurrency = "IDR";
    if (config.APP_MODE === "read_only" && usesGmv && !filters.gmvCurrency?.trim()) {
      throw new BadRequestException("An explicit expected GMV currency is required for real Marketplace filtering or ranking");
    }
    if (filters.gmvCurrency && !/^[A-Za-z]{3}$/.test(filters.gmvCurrency)) throw new BadRequestException("GMV currency must be a three-letter provider currency code");
    if (filters.gmvCurrency) filters.gmvCurrency = filters.gmvCurrency.toUpperCase();
    try {
      renderMessage(input.messageTemplate, { creatorDisplayName: "Creator", productName: input.productName, campaignName: input.name });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid message template");
    }
    return this.prisma.campaign.create({ data: {
      shopId: shop.id, name: input.name.trim(), productName: input.productName.trim(), targetCount: input.targetCount,
      candidateLimit: Math.min(10_000, input.candidateLimit ?? Math.max(input.targetCount * 2, input.targetCount + 500)),
      cooldownDays: input.cooldownDays, messageTemplate: input.messageTemplate, filters: filters as Prisma.InputJsonValue,
      rankingMetric: input.rankingMetric, rankingDirection: input.rankingDirection ?? "DESC"
    }});
  }

  private async requiredCampaign(id: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id }, include: { shop: true } });
    if (!campaign) throw new NotFoundException("Campaign not found");
    return campaign;
  }

  async discover(id: string) {
    await expireFrozenCampaigns(this.prisma);
    const campaign = await this.requiredCampaign(id);
    if (!["DRAFT", "PREVIEW_READY", "PREVIEW_EXPIRED"].includes(campaign.state)) throw new BadRequestException("Campaign cannot be rediscovered in its current state");
    await this.prisma.campaign.update({ where: { id }, data: { state: "DISCOVERING", version: { increment: 1 } } });
    const creators: CreatorCandidate[] = [];
    let pageToken: string | undefined;
    let searchKey: string | undefined;
    let hasMore = true;
    const adapter = await this.tiktok.adapter();
    while (hasMore && creators.length < campaign.candidateLimit) {
      const page = await adapter.searchCreators(campaign.filters as CreatorFilters, { pageToken, searchKey, pageSize: 20 });
      const remaining = campaign.candidateLimit - creators.length;
      creators.push(...page.creators.slice(0, remaining).map((creator, index) => ({ ...creator, discoveryOrdinal: creators.length + index })));
      pageToken = page.nextPageToken;
      searchKey = page.searchKey;
      hasMore = page.hasMore;
    }
    const openIds = [...new Set(creators.map((creator) => creator.creatorOpenId))];
    const existingCreators = await this.prisma.creator.findMany({ where: { creatorOpenId: { in: openIds } }, include: { contacts: { where: { shopId: campaign.shopId } } } });
    const contacts = new Map<string, ContactState>(existingCreators.filter((creator) => creator.creatorOpenId).map((creator) => [creator.creatorOpenId!, {
      contactCount: creator.contacts[0]?.contactCount ?? 0,
      lastContactedAt: creator.contacts[0]?.lastContactedAt ?? undefined,
      firstContactedAt: creator.contacts[0]?.firstContactedAt ?? undefined,
      doNotContact: creator.contacts[0]?.doNotContact,
      unresolvedDelivery: creator.contacts[0]?.unresolvedDelivery,
      historical: Boolean(creator.contacts[0]?.historyCoverageStart)
    }]));
    const reservations = await this.prisma.outreachReservation.findMany({ where: { shopId: campaign.shopId, expiresAt: { gt: new Date() } }, include: { creator: true } });
    const preview = buildPreview({
      creators, filters: campaign.filters as CreatorFilters, contacts,
      activeReservations: new Set(reservations.flatMap((reservation) => reservation.creator.creatorOpenId ? [reservation.creator.creatorOpenId] : [])),
      requested: campaign.targetCount, cooldownDays: campaign.cooldownDays,
      rankingMetric: campaign.rankingMetric as RankingMetric, rankingDirection: campaign.rankingDirection as "ASC" | "DESC",
      now: new Date(), truncated: hasMore
    });
    const unresolvedHistory = await this.prisma.creatorShopContactState.aggregate({
      where: { shopId: campaign.shopId, contactCount: { gt: 0 }, creator: { creatorOpenId: null } },
      _count: { _all: true }, _sum: { contactCount: true }
    });
    const summary = {
      ...preview.summary,
      historyIdentityCoverageIncomplete: unresolvedHistory._count._all > 0,
      unresolvedHistoricalCreators: unresolvedHistory._count._all,
      unresolvedHistoricalOutboundContacts: unresolvedHistory._sum.contactCount ?? 0
    };

    const canonical = new Map<string, (typeof preview.creators)[number]>();
    for (const evaluated of preview.creators) if (!canonical.has(evaluated.creatorOpenId)) canonical.set(evaluated.creatorOpenId, evaluated);
    const canonicalCreatorIds = new Map<string, string>();
    for (const evaluated of canonical.values()) canonicalCreatorIds.set(evaluated.creatorOpenId, (await this.identities.ensureMarketplaceCreator(evaluated)).id);

    await this.prisma.$transaction(async (tx) => {
      await tx.campaignRecipient.deleteMany({ where: { campaignId: id } });
      for (const evaluated of canonical.values()) {
        const creator = await tx.creator.findUniqueOrThrow({ where: { id: canonicalCreatorIds.get(evaluated.creatorOpenId)! } });
        const snapshot = await tx.creatorMetricSnapshot.create({ data: {
          creatorId: creator.id, followerCount: evaluated.followerCount, categoryIds: evaluated.categoryIds,
          gmvAmount: evaluated.gmv ? new Prisma.Decimal(evaluated.gmv.amount) : null, gmvCurrency: evaluated.gmv?.currency, unitsSold: evaluated.unitsSold,
          avgVideoViews: evaluated.avgVideoViews, avgLiveViewers: evaluated.avgLiveViewers,
          engagementRate: evaluated.engagementRate == null ? null : new Prisma.Decimal(evaluated.engagementRate),
          sourceFetchedAt: new Date(), rawPayload: evaluated as unknown as Prisma.InputJsonValue
        }});
        await tx.campaignRecipient.create({ data: {
          campaignId: id, creatorId: creator.id, snapshotId: snapshot.id, discoveryOrdinal: evaluated.discoveryOrdinal,
          eligibility: evaluated.eligibility, skipReason: evaluated.skipReason, skipDetail: evaluated.skipDetail,
          rankingValue: new Prisma.Decimal(evaluated.rankingValue), selected: evaluated.selected,
          state: evaluated.selected ? "SELECTED" : evaluated.eligibility === "ELIGIBLE" ? "ELIGIBLE" : "DISCOVERED"
        }});
      }
      await tx.campaign.update({ where: { id }, data: {
        state: "PREVIEW_READY", summary: summary as unknown as Prisma.InputJsonValue, searchKey, nextPageToken: pageToken,
        truncated: hasMore, version: { increment: 1 }
      }});
      await tx.auditEvent.create({ data: { shopId: campaign.shopId, campaignId: id, eventType: "PREVIEW_READY", payload: summary as unknown as Prisma.InputJsonValue } });
    });
    return this.preview(id);
  }

  async preview(id: string) {
    await expireFrozenCampaigns(this.prisma);
    return this.prisma.campaign.findUnique({ where: { id }, include: {
      recipients: { orderBy: [{ selected: "desc" }, { rankingValue: "desc" }], take: 250, include: { creator: true, snapshot: true } }
    }});
  }

  async recipients(id: string, view?: string) {
    const where: Prisma.CampaignRecipientWhereInput = { campaignId: id };
    if (view === "selected") where.selected = true;
    else if (view === "excluded") where.eligibility = "EXCLUDED";
    else if (view === "eligible") where.eligibility = "ELIGIBLE";
    return this.prisma.campaignRecipient.findMany({ where, include: { creator: true, snapshot: true, delivery: true }, orderBy: { rankingValue: "desc" }, take: 1000 });
  }

  async get(id: string) {
    await expireFrozenCampaigns(this.prisma);
    const campaign = await this.prisma.campaign.findUnique({ where: { id }, include: {
      shop: true, recipients: { include: { creator: true, snapshot: true, delivery: true }, orderBy: { rankingValue: "desc" }, take: 250 },
      _count: { select: { recipients: true, deliveries: true } }
    }});
    if (!campaign) throw new NotFoundException("Campaign not found");
    return campaign;
  }

  async freeze(id: string, version: number) {
    if (config.APP_MODE === "read_only") throw new BadRequestException("READ_ONLY_PREVIEW: real TikTok campaigns cannot be frozen or dispatched in Phase 2A");
    await expireFrozenCampaigns(this.prisma);
    const campaign = await this.requiredCampaign(id);
    if (campaign.state !== "PREVIEW_READY" || campaign.version !== version) throw new BadRequestException("Preview is stale; refresh it before freezing");
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    await this.prisma.$transaction(async (tx) => {
      const selectedCreatorIds = (await tx.campaignRecipient.findMany({
        where: { campaignId: id, selected: true }, select: { creatorId: true }
      })).map((recipient) => recipient.creatorId);
      if (!selectedCreatorIds.length) throw new BadRequestException("No eligible recipients to freeze");
      await lockCreatorEligibility(tx, campaign.shopId, selectedCreatorIds);
      const current = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { shop: true } });
      if (current.state !== "PREVIEW_READY" || current.version !== version) throw new BadRequestException("Preview is stale; refresh it before freezing");
      await tx.outreachReservation.deleteMany({ where: { shopId: current.shopId, expiresAt: { lte: new Date() } } });
      const selected = await tx.campaignRecipient.findMany({
        where: { campaignId: id, selected: true },
        include: {
          creator: { include: { contacts: { where: { shopId: current.shopId }, take: 1 } } },
          reservation: true
        }, orderBy: { rankingValue: current.rankingDirection === "ASC" ? "asc" : "desc" }
      });
      if (!selected.length) throw new BadRequestException("No eligible recipients to freeze");
      const cutoff = new Date(Date.now() - current.cooldownDays * 86_400_000);
      const exclusionCounts: Record<string, number> = {};
      let finalSelected = 0;
      for (const recipient of selected) {
        const contact = recipient.creator.contacts[0];
        const activeReservation = await tx.outreachReservation.findFirst({
          where: { shopId: current.shopId, creatorId: recipient.creatorId, expiresAt: { gt: new Date() } }
        });
        let skipReason: "DO_NOT_CONTACT" | "DELIVERY_UNKNOWN" | "COOLDOWN" | "ACTIVE_RESERVATION" | undefined;
        let skipDetail: string | undefined;
        if (contact?.doNotContact) skipReason = "DO_NOT_CONTACT";
        else if (contact?.unresolvedDelivery) skipReason = "DELIVERY_UNKNOWN";
        else if (contact?.lastContactedAt && contact.lastContactedAt > cutoff) {
          skipReason = "COOLDOWN";
          skipDetail = `Contact appeared after preview at ${contact.lastContactedAt.toISOString()}`;
        } else if (activeReservation) skipReason = "ACTIVE_RESERVATION";
        if (skipReason) {
          exclusionCounts[skipReason] = (exclusionCounts[skipReason] ?? 0) + 1;
          await tx.campaignRecipient.update({ where: { id: recipient.id }, data: {
            selected: false, eligibility: "EXCLUDED", skipReason, skipDetail, state: "DISCOVERED",
            frozenMessage: null, contentHash: null
          } });
          continue;
        }
        const frozenMessage = renderMessage(campaign.messageTemplate, {
          creatorDisplayName: recipient.creator.nickname ?? recipient.creator.username ?? "there",
          productName: campaign.productName, campaignName: campaign.name
        });
        const contentHash = createHash("sha256").update(frozenMessage).digest("hex");
        await tx.outreachReservation.create({ data: { shopId: campaign.shopId, creatorId: recipient.creatorId, campaignRecipientId: recipient.id, expiresAt } });
        await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { frozenMessage, contentHash, state: "RESERVED" } });
        finalSelected++;
      }
      const previousSummary = current.summary && typeof current.summary === "object" && !Array.isArray(current.summary)
        ? current.summary as Record<string, unknown> : {};
      const numberValue = (key: string) => Number(previousSummary[key] ?? 0);
      const finalSummary = {
        ...previousSummary,
        selected: finalSelected,
        eligible: Math.max(0, numberValue("eligible") - Object.values(exclusionCounts).reduce((sum, count) => sum + count, 0)),
        shortfall: Math.max(0, current.targetCount - finalSelected),
        skippedDoNotContact: numberValue("skippedDoNotContact") + (exclusionCounts.DO_NOT_CONTACT ?? 0),
        skippedUnknownDelivery: numberValue("skippedUnknownDelivery") + (exclusionCounts.DELIVERY_UNKNOWN ?? 0),
        skippedCooldown: numberValue("skippedCooldown") + (exclusionCounts.COOLDOWN ?? 0),
        skippedActiveReservation: numberValue("skippedActiveReservation") + (exclusionCounts.ACTIVE_RESERVATION ?? 0),
        freezeAdjustment: selected.length - finalSelected
      };
      if (finalSelected === 0) {
        await tx.outreachReservation.deleteMany({ where: { recipient: { campaignId: id } } });
        await tx.campaign.update({ where: { id }, data: {
          state: "PREVIEW_EXPIRED", frozenAt: null, freezeExpiresAt: null,
          summary: finalSummary as Prisma.InputJsonValue, version: { increment: 1 }
        } });
        await tx.auditEvent.create({ data: {
          shopId: campaign.shopId, campaignId: id, eventType: "CAMPAIGN_FREEZE_EMPTY",
          payload: { previewSelected: selected.length, finalSelected: 0, exclusions: exclusionCounts, reservationsReleased: true }
        } });
      } else {
        await tx.campaign.update({ where: { id }, data: {
          state: "FROZEN", frozenAt: new Date(), freezeExpiresAt: expiresAt,
          summary: finalSummary as Prisma.InputJsonValue, version: { increment: 1 }
        } });
        await tx.auditEvent.create({ data: { shopId: campaign.shopId, campaignId: id, eventType: "CAMPAIGN_FROZEN", payload: {
          previewSelected: selected.length, finalSelected, exclusions: exclusionCounts, expiresAt: expiresAt.toISOString()
        } } });
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 20_000 });
    return this.get(id);
  }

  async start(id: string, input: { version: number; confirmationName: string; confirmationCount: number }) {
    if (config.APP_MODE === "read_only") throw new BadRequestException("OUTBOUND_DISABLED: real TikTok campaigns cannot enter the dispatch queue");
    await expireFrozenCampaigns(this.prisma);
    const campaign = await this.requiredCampaign(id);
    const selectedCount = await this.prisma.campaignRecipient.count({ where: { campaignId: id, selected: true, state: "RESERVED" } });
    if (campaign.state !== "FROZEN" || campaign.version !== input.version || !campaign.freezeExpiresAt || campaign.freezeExpiresAt <= new Date()) throw new BadRequestException("Frozen preview is stale or expired");
    if (input.confirmationName !== campaign.name || input.confirmationCount !== selectedCount) throw new BadRequestException("Typed campaign name and selected count must match exactly");
    if (!selectedCount) throw new BadRequestException("No frozen recipients remain; rediscover and freeze again");
    const recipients = await this.prisma.campaignRecipient.findMany({ where: { campaignId: id, selected: true, state: "RESERVED" } });
    await this.prisma.$transaction(async (tx) => {
      await tx.outreachReservation.updateMany({
        where: { recipient: { campaignId: id, selected: true } },
        data: { expiresAt: new Date("9999-12-31T23:59:59.999Z") }
      });
      for (const recipient of recipients) {
        const delivery = await tx.outreachDelivery.upsert({
          where: { campaignRecipientId: recipient.id },
          update: {},
          create: { campaignId: id, campaignRecipientId: recipient.id, deterministicKey: `${id}:${recipient.creatorId}`, contentHash: recipient.contentHash! }
        });
        await tx.queueOutbox.upsert({
          where: { recipientId: recipient.id }, update: { state: "PENDING", availableAt: new Date(), lastError: null },
          create: {
            campaignId: id, deliveryId: delivery.id, recipientId: recipient.id,
            deterministicJobId: `send-${recipient.id}`
          }
        });
        await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "QUEUED" } });
      }
      await tx.campaign.update({ where: { id }, data: { state: "QUEUED", version: { increment: 1 } } });
      await tx.auditEvent.create({ data: { shopId: campaign.shopId, campaignId: id, eventType: "CAMPAIGN_CONFIRMED", payload: { selectedCount } } });
    });
    await this.queues.reconcile();
    return this.get(id);
  }

  async pause(id: string) {
    const campaign = await this.requiredCampaign(id);
    if (!["QUEUED", "RUNNING"].includes(campaign.state)) throw new BadRequestException("Campaign is not running");
    return this.prisma.campaign.update({ where: { id }, data: { state: "PAUSE_REQUESTED", version: { increment: 1 } } });
  }

  async resume(id: string) {
    const campaign = await this.requiredCampaign(id);
    if (!["PAUSED", "PAUSE_REQUESTED"].includes(campaign.state)) throw new BadRequestException("Campaign is not paused");
    const recipients = await this.prisma.campaignRecipient.findMany({ where: { campaignId: id, state: { in: ["QUEUED", "RESERVED"] } } });
    await this.prisma.campaign.update({ where: { id }, data: { state: "QUEUED", version: { increment: 1 } } });
    await this.queues.reconcile();
    return this.get(id);
  }
}
