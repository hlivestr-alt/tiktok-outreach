import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { lockCreatorEligibility, Prisma } from "@affiliate/db";
import type { CampaignCloneFromPreviewInput, CampaignCreateInput } from "@affiliate/contracts";
import { assertCampaignWithinLimit, renderMessage, type CreatorFilters } from "@affiliate/domain";
import { config, expireFrozenCampaigns, PrismaService, QueueService } from "../shared";
import { TikTokIntegrationService } from "../integrations/tiktok.service";
import { publicDiscoveryRun } from "./discovery-processor";
import { rebuildLocalPreview } from "./local-preview";

@Injectable()
export class OutreachService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly tiktok: TikTokIntegrationService
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
        maxRecipientsPerCampaign: shop.maxRecipientsPerCampaign
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

  private async rebuildFromCreatorDatabase(campaign: Awaited<ReturnType<OutreachService["requiredCampaign"]>>) {
    const allSnapshots = await this.prisma.creatorMetricSnapshot.findMany({
      where: { shopId: campaign.shopId, creator: { creatorOpenId: { not: null }, providerIdentities: { some: {
        provider: "TIKTOK_SHOP", identityType: "TIKTOK_CREATOR_OPEN_ID", linkState: "VERIFIED"
      } } } },
      include: { creator: { include: { providerIdentities: { where: {
        provider: "TIKTOK_SHOP", identityType: "TIKTOK_CREATOR_OPEN_ID", linkState: "VERIFIED"
      } } } } }, orderBy: { sourceFetchedAt: "desc" }
    });
    const seen = new Set<string>();
    const candidates = allSnapshots.flatMap((snapshot) => {
      const creatorOpenId = snapshot.creator.creatorOpenId;
      const exactIdentity = creatorOpenId && snapshot.creator.providerIdentities.some((identity) => identity.identifier === creatorOpenId);
      if (!creatorOpenId || !exactIdentity || seen.has(creatorOpenId)) return [];
      seen.add(creatorOpenId);
      const raw = snapshot.rawPayload as Record<string, unknown>;
      return [{
        creatorOpenId, creatorUserId: snapshot.creator.creatorUserId ?? undefined,
        username: snapshot.creator.username ?? undefined, nickname: snapshot.creator.nickname ?? undefined,
        avatarUrl: snapshot.creator.avatarUrl ?? undefined,
        categoryIds: Array.isArray(snapshot.categoryIds) ? snapshot.categoryIds.filter((value): value is string => typeof value === "string") : [],
        followerCount: snapshot.followerCount,
        gmv: snapshot.gmvAmount != null && snapshot.gmvCurrency ? { amount: String(snapshot.gmvAmount), currency: snapshot.gmvCurrency } : null,
        unitsSold: snapshot.unitsSold, avgVideoViews: snapshot.avgVideoViews, avgLiveViewers: snapshot.avgLiveViewers,
        engagementRate: snapshot.engagementRate == null ? undefined : Number(snapshot.engagementRate),
        selectionRegion: snapshot.creator.selectionRegion, discoveryOrdinal: seen.size - 1,
        databaseSnapshotId: snapshot.id,
        liveGmv: raw.liveGmv, videoGmv: raw.videoGmv, gmvRange: raw.gmvRange,
        topAgeRanges: raw.topAgeRanges, majorGender: raw.majorGender, majorGenderPercentage: raw.majorGenderPercentage
      }];
    });
    if (!candidates.length) throw new BadRequestException("Creator database is empty; import or sync creators before creating an Outreach preview");
    return this.prisma.$transaction(async (tx) => {
      await tx.discoveryRun.deleteMany({ where: { campaignId: campaign.id } });
      await tx.campaign.update({ where: { id: campaign.id }, data: { state: "DISCOVERING", version: { increment: 1 } } });
      const run = await tx.discoveryRun.create({ data: {
        campaignId: campaign.id, shopId: campaign.shopId, state: "RUNNING",
        requestedTarget: campaign.targetCount, candidateLimit: candidates.length,
        pagesFetched: 0, candidatesFetched: candidates.length, totalProviderRequests: 0, providerHasMore: false
      } });
      for (let offset = 0; offset < candidates.length; offset += 1000) await tx.discoveryCandidate.createMany({ data:
        candidates.slice(offset, offset + 1000).map((candidate) => ({ discoveryRunId: run.id, creatorOpenId: candidate.creatorOpenId,
          discoveryOrdinal: candidate.discoveryOrdinal, candidate: candidate as unknown as Prisma.InputJsonValue }))
      });
      await tx.auditEvent.create({ data: { shopId: campaign.shopId, campaignId: campaign.id, eventType: "LOCAL_CREATOR_DATABASE_FILTERED",
        payload: { creatorDatabaseSize: candidates.length, providerRequests: 0 } } });
      await rebuildLocalPreview(tx, run.id, new Date());
      return tx.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 120_000 });
  }

  async discover(id: string) {
    await expireFrozenCampaigns(this.prisma);
    const campaign = await this.requiredCampaign(id);
    const existing = await this.prisma.discoveryRun.findUnique({ where: { campaignId: id } });
    if (existing && existing.state === "COMPLETE" && campaign.state === "PREVIEW_READY") return publicDiscoveryRun(existing);
    if (!["DRAFT", "PREVIEW_READY", "PREVIEW_EXPIRED"].includes(campaign.state)) throw new BadRequestException("Campaign cannot be rediscovered in its current state");
    const run = await this.rebuildFromCreatorDatabase(campaign);
    return publicDiscoveryRun(run);
  }

  private validateCloneInput(input: CampaignCloneFromPreviewInput, shop: { maxRecipientsPerCampaign: number }) {
    try {
      assertCampaignWithinLimit(input.targetCount, shop);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid campaign target");
    }
    if (!input.name?.trim() || !input.productName?.trim() || !input.messageTemplate?.trim()) {
      throw new BadRequestException("Name, product, and message template are required");
    }
    if (input.messageTemplate.length > 2000) throw new BadRequestException("Message template exceeds the provider limit of 2,000 characters");
    try {
      renderMessage(input.messageTemplate, {
        creatorDisplayName: "Creator", productName: input.productName, campaignName: input.name
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid message template");
    }
  }

  async cloneFromPreview(id: string, input: CampaignCloneFromPreviewInput, idempotencyKey?: string) {
    const source = await this.prisma.campaign.findUnique({
      where: { id }, include: { shop: true, discoveryRun: { include: { candidates: { orderBy: { discoveryOrdinal: "asc" } } } } }
    });
    if (!source) throw new NotFoundException("Source campaign not found");
    if (source.state !== "PREVIEW_READY") throw new BadRequestException("Source campaign must be PREVIEW_READY");
    if (source.discoveryRun?.state !== "COMPLETE" || !source.discoveryRun.completedAt) {
      throw new BadRequestException("Source campaign must have a completed discovery run");
    }
    if (!source.discoveryRun.candidates.length) throw new BadRequestException("Source campaign must contain persisted discovery candidates");
    this.validateCloneInput(input, source.shop);
    const normalized = {
      name: input.name.trim(), productName: input.productName.trim(),
      messageTemplate: input.messageTemplate, targetCount: input.targetCount
    };
    const idempotencyDigest = createHash("sha256").update(JSON.stringify({
      sourceCampaignId: id, submissionKey: idempotencyKey?.trim() || "CONTENT_DERIVED", request: normalized
    })).digest("hex");
    const now = new Date();
    const campaignId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`clone-preview:${idempotencyDigest}`}))`;
      const duplicate = await tx.auditEvent.findFirst({
        where: { eventType: "CAMPAIGN_CLONED_FROM_PREVIEW", payload: { path: ["idempotencyDigest"], equals: idempotencyDigest } },
        select: { campaignId: true }
      });
      if (duplicate?.campaignId) return duplicate.campaignId;

      const campaign = await tx.campaign.create({ data: {
        shopId: source.shopId, name: normalized.name, productName: normalized.productName,
        targetCount: normalized.targetCount, candidateLimit: source.candidateLimit,
        cooldownDays: source.cooldownDays, messageTemplate: normalized.messageTemplate,
        filters: source.filters as Prisma.InputJsonValue, rankingMetric: source.rankingMetric,
        rankingDirection: source.rankingDirection, state: "DRAFT"
      } });
      const run = await tx.discoveryRun.create({ data: {
        campaignId: campaign.id, shopId: source.shopId, state: "RUNNING",
        requestedTarget: normalized.targetCount, candidateLimit: source.candidateLimit,
        pagesFetched: 0, candidatesFetched: source.discoveryRun!.candidates.length,
        totalProviderRequests: 0, providerHasMore: source.discoveryRun!.providerHasMore
      } });
      for (const row of source.discoveryRun!.candidates) {
        const candidate = row.candidate as Record<string, unknown>;
        if (!row.creatorOpenId || candidate.creatorOpenId !== row.creatorOpenId) {
          throw new BadRequestException("Persisted candidates must contain exact matching Creator Open IDs");
        }
        await tx.discoveryCandidate.create({ data: {
          discoveryRunId: run.id, creatorOpenId: row.creatorOpenId, discoveryOrdinal: row.discoveryOrdinal,
          candidate: {
            creatorOpenId: row.creatorOpenId, creatorUserId: candidate.creatorUserId,
            username: candidate.username, nickname: candidate.nickname,
            categoryIds: candidate.categoryIds, followerCount: candidate.followerCount,
            gmv: candidate.gmv, unitsSold: candidate.unitsSold,
            avgVideoViews: candidate.avgVideoViews, avgLiveViewers: candidate.avgLiveViewers,
            engagementRate: candidate.engagementRate, selectionRegion: candidate.selectionRegion,
            discoveryOrdinal: row.discoveryOrdinal
          } as Prisma.InputJsonValue
        } });
      }
      await tx.auditEvent.create({ data: {
        shopId: source.shopId, campaignId: campaign.id, eventType: "CAMPAIGN_CLONED_FROM_PREVIEW",
        payload: { sourceCampaignId: source.id, idempotencyDigest, candidateSource: "LOCAL_PERSISTED_PREVIEW", providerRequests: 0 }
      } });
      await rebuildLocalPreview(tx, run.id, now);
      return campaign.id;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 20_000 });

    const clone = await this.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, include: { discoveryRun: true } });
    const summary = clone.summary as Record<string, unknown>;
    return {
      id: clone.id, state: clone.state,
      fetched: Number(summary.fetchedOccurrences ?? clone.discoveryRun?.candidatesFetched ?? 0),
      eligible: Number(summary.eligible ?? 0), selected: Number(summary.selected ?? 0),
      warnings: Number(summary.shortfall ?? 0) > 0 ? ["Target shortfall; filters and safety rules were not weakened"] : []
    };
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
      shop: true, discoveryRun: true, recipients: { include: { creator: true, snapshot: true, delivery: true }, orderBy: { rankingValue: "desc" }, take: 250 },
      _count: { select: { recipients: true, deliveries: true } }
    }});
    if (!campaign) throw new NotFoundException("Campaign not found");
    const { discoveryRun, shop, ...publicCampaign } = campaign;
    const { shopCipher: _shopCipher, ...publicShop } = shop;
    const heartbeat = discoveryRun && ["QUEUED", "RUNNING", "BACKING_OFF"].includes(discoveryRun.state)
      ? await this.prisma.workerHeartbeat.findUnique({ where: { role: "discovery-worker" } }) : null;
    const discoveryWorkerState = heartbeat?.status === "RUNNING"
      ? (Date.now() - heartbeat.lastSeenAt.getTime() <= config.WORKER_STALE_AFTER_MS ? "RUNNING" : "STALE") : "STOPPED";
    return {
      ...publicCampaign, shop: publicShop, discovery: discoveryRun ? publicDiscoveryRun(discoveryRun) : null,
      discoveryWorkerState,
      outboundMode: config.OUTBOUND_MODE.toUpperCase(), outboundEnabled: config.OUTBOUND_MODE === "mock"
        || (config.OUTBOUND_MODE === "live" && config.ENABLE_LIVE_TIKTOK_OUTBOUND === "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES"),
      cooldownCapability: {
        appOriginated: "APP_ORIGINATED_DEDUPE_SAFE",
        historical: (publicCampaign.summary as Record<string, unknown> | null)?.historyIdentityCoverageIncomplete
          ? "HISTORICAL_COOLDOWN_COVERAGE_INCOMPLETE" : "FULL_HISTORICAL_COOLDOWN_SAFE"
      }
    };
  }

  async cancelDiscovery(id: string) {
    const campaign = await this.requiredCampaign(id);
    const run = await this.prisma.discoveryRun.findUnique({ where: { campaignId: id } });
    if (!run) throw new BadRequestException("Campaign has no discovery run");
    if (["COMPLETE", "FAILED", "CANCELLED"].includes(run.state)) return publicDiscoveryRun(run);
    const cancelled = await this.prisma.discoveryRun.update({ where: { id: run.id }, data: { state: "CANCELLED", nextAttemptAt: null, leaseId: null, leaseExpiresAt: null, completedAt: new Date() } });
    await this.prisma.campaign.updateMany({ where: { id: campaign.id, state: "DISCOVERING" }, data: { state: "DRAFT", version: { increment: 1 } } });
    return publicDiscoveryRun(cancelled);
  }

  async freeze(id: string, version: number) {
    if (config.OUTBOUND_MODE === "read_only") throw new BadRequestException("READ_ONLY_PREVIEW: outbound is physically unavailable until an outbound mode is explicitly enabled");
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
      for (const [frozenIndex, recipient] of selected.entries()) {
        const contact = recipient.creator.contacts[0];
        const activeReservation = await tx.outreachReservation.findFirst({
          where: { shopId: current.shopId, creatorId: recipient.creatorId, expiresAt: { gt: new Date() } }
        });
        let skipReason: "DO_NOT_CONTACT" | "DELIVERY_UNKNOWN" | "COOLDOWN" | "CONTACTED_BY_APP_WITHIN_COOLDOWN" | "ACTIVE_RESERVATION" | undefined;
        let skipDetail: string | undefined;
        if (contact?.doNotContact) skipReason = "DO_NOT_CONTACT";
        else if (contact?.unresolvedDelivery) skipReason = "DELIVERY_UNKNOWN";
        else if (contact?.lastContactedAt && contact.lastContactedAt > cutoff) {
          skipReason = contact.lastCampaignId ? "CONTACTED_BY_APP_WITHIN_COOLDOWN" : "COOLDOWN";
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
        if (!recipient.creator.creatorOpenId) throw new BadRequestException("Every frozen recipient requires an exact TikTok Creator Open ID");
        await tx.outreachReservation.create({ data: { shopId: campaign.shopId, creatorId: recipient.creatorId, campaignRecipientId: recipient.id, expiresAt } });
        await tx.campaignRecipient.update({ where: { id: recipient.id }, data: {
          frozenMessage, contentHash, state: "RESERVED", creatorOpenIdSnapshot: recipient.creator.creatorOpenId,
          frozenRank: frozenIndex + 1, recipientSnapshot: {
            creatorId: recipient.creatorId, creatorOpenId: recipient.creator.creatorOpenId,
            displayName: recipient.creator.nickname ?? recipient.creator.username ?? "there",
            username: recipient.creator.username, rankingValue: recipient.rankingValue.toString(), discoveryOrdinal: recipient.discoveryOrdinal
          }
        } });
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
          frozenFilters: current.filters as Prisma.InputJsonValue, frozenTemplate: current.messageTemplate,
          frozenContext: { campaignName: current.name, productName: current.productName, rankingMetric: current.rankingMetric, rankingDirection: current.rankingDirection },
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
    if (config.OUTBOUND_MODE === "read_only") throw new BadRequestException("OUTBOUND_DISABLED: outbound is physically unavailable until an outbound mode is explicitly enabled");
    if (config.OUTBOUND_MODE === "live" && config.ENABLE_LIVE_TIKTOK_OUTBOUND !== "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES") {
      throw new BadRequestException("LIVE_OUTBOUND_NOT_ACKNOWLEDGED: explicit live-send configuration is required");
    }
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
    if (!["PAUSED", "PAUSE_REQUESTED", "SAFETY_PAUSED"].includes(campaign.state)) throw new BadRequestException("Campaign is not paused");
    const quotaRecovery = campaign.state === "SAFETY_PAUSED" && campaign.safetyPauseReason?.includes("IM quota");
    if (campaign.state === "SAFETY_PAUSED" && !quotaRecovery) {
      throw new BadRequestException("This provider safety pause requires its authorization or permission issue to be resolved first");
    }
    await this.prisma.$transaction(async (tx) => {
      if (quotaRecovery) {
        await tx.providerOutboundLimiter.updateMany({ where: { shopId: campaign.shopId, state: "QUOTA_BLOCKED" }, data: {
          state: "RECOVERING", effectiveConcurrency: 1, healthySuccessCount: 0,
          consecutiveThrottleCount: 0, consecutiveFailureCount: 0,
          nextPermittedAt: null, quotaBlockedAt: null, quotaCode: null, quotaDetail: null
        } });
        await tx.queueOutbox.updateMany({ where: { campaignId: id, state: "SAFETY_PAUSED" }, data: { state: "PENDING", availableAt: new Date(), lastError: null } });
        await tx.auditEvent.create({ data: { shopId: campaign.shopId, campaignId: id, eventType: "OUTBOUND_PROVIDER_IM_QUOTA_OPERATOR_RETRY", payload: { recoveryConcurrency: 1 } } });
      }
      await tx.campaign.update({ where: { id }, data: { state: "QUEUED", safetyPauseReason: null, version: { increment: 1 } } });
    });
    await this.queues.reconcile();
    return this.get(id);
  }

  async cancel(id: string) {
    const campaign = await this.requiredCampaign(id);
    if (!["FROZEN", "QUEUED", "RUNNING", "PAUSE_REQUESTED", "PAUSED", "SAFETY_PAUSED"].includes(campaign.state)) {
      if (campaign.state === "CANCELLED") return this.get(id);
      throw new BadRequestException("Campaign cannot be cancelled in its current state");
    }
    await this.prisma.$transaction(async (tx) => {
      const unsent = await tx.campaignRecipient.findMany({ where: {
        campaignId: id, state: { in: ["RESERVED", "QUEUED"] }
      }, select: { id: true } });
      const ids = unsent.map((recipient) => recipient.id);
      if (ids.length) {
        await tx.outreachDelivery.updateMany({ where: { campaignRecipientId: { in: ids }, state: { in: ["PENDING", "FAILED_RETRYABLE"] } }, data: { state: "CANCELLED", lastErrorCode: "CAMPAIGN_CANCELLED", lastErrorDetail: "Cancelled before provider dispatch started" } });
        await tx.campaignRecipient.updateMany({ where: { id: { in: ids } }, data: { state: "CANCELLED" } });
        await tx.queueOutbox.updateMany({ where: { recipientId: { in: ids } }, data: { state: "COMPLETED", lastError: "Campaign cancelled before dispatch" } });
        await tx.outreachReservation.deleteMany({ where: { campaignRecipientId: { in: ids } } });
      }
      await tx.campaign.update({ where: { id }, data: { state: "CANCELLED", version: { increment: 1 } } });
      await tx.auditEvent.create({ data: { shopId: campaign.shopId, campaignId: id, eventType: "CAMPAIGN_CANCELLED", payload: { unsentRecipientsCancelled: ids.length } } });
    });
    return this.get(id);
  }
}
