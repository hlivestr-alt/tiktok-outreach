import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Prisma } from "@affiliate/db";
import type { TikTokReadAdapter } from "@affiliate/contracts";
import type { CreatorCandidate } from "@affiliate/domain";
import { TikTokApiError } from "@affiliate/tiktok-adapter";
import { config, PrismaService } from "../shared";
import { TikTokIntegrationService } from "../integrations/tiktok.service";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";
import { GoogleSheetsCreatorGateway, googleSheetsFailure, type CreatorSheet } from "./creator-sheet.gateway";
import { CREATOR_MARKETPLACE_RETRY_MS, marketplaceRetryDelayMs } from "./retry-settings";
import { adaptiveExpansion, adaptiveFollowerPartitionKey, classifyIncrementalYield,
  combinedIncrementalYield, GMV_BUCKETS, isSpecificGmvPartition, observedSaturationState, partitionFilters, partitionLabel,
  PRODUCTION_PARTITION_TYPES, SPECIFIC_GMV_BUCKET_CODES, specificGmvCombinationKey,
  validateMarketplaceCategorySelection, validateV2CategorySelection, V3_ADAPTIVE_GENERATION,
  type FollowerWidthRules, type ProductionPartitionType } from "./marketplace-partitions";
import { aggregateEvidence, categoryEvidence, followerEvidence, schedulerSelectionMessage, schedulerSlot,
  scoreSchedulerPriority, selectSchedulerCandidate, type SchedulerObservation } from "./creator-scheduler";

const LEASE_MS = 2 * 60_000;
const BUSINESS_16032001_MAX_ATTEMPTS = 10;
const SHEETS_MAX_ATTEMPTS = 10;
const SHEETS_RETRY_MS = 5_000;
type Options = { now?: () => Date; leaseMs?: number; random?: () => number };
type MarketplaceSearch = Pick<TikTokReadAdapter, "searchCreators">;
type Activity = { stage: string; pageNumber?: number; httpStatus?: number; tiktokCode?: string; safeMessage?: string;
  googleApiCode?: string; retryable?: boolean; creatorsReturned?: number; creatorsAdded?: number; duplicates?: number; nextAttemptAt?: Date; occurredAt?: Date };
type DatabaseFailureDetails = { prismaCode?: string; model?: string; constraint?: string; field?: string; recordNumber?: number; totalRecords?: number };
type AdaptivePartition = {
  id: string; creatorSyncJobId: string; partitionKey: string; partitionType: string; adaptiveDepth: number; generation: number;
  categoryId: string | null; categoryName: string; categoryChildId: string | null; categoryChildName: string | null; categoryChildIds: string[];
  followerBucket: string | null; followersMin: number | null; followersMax: number | null; gmvBucket: string | null; gmvRange: string | null;
  parentPartitionId: string | null; queuePosition: bigint; observedSaturationState: string; originalYield: Prisma.Decimal | null;
  incrementalYield: Prisma.Decimal | null; combinedChildIncrementalYield: Prisma.Decimal | null; newCreatorsPerRequest: Prisma.Decimal | null;
  uniqueCreatorsAdded: number; marketplaceRequests: number; pagesCompleted: number;
  throttleAttempts: number; followerSplitExplored: boolean; followerRecursionTerminal: boolean; gmvSplitCreated: boolean;
  branchClassification: string; status: string; rowsReturned: number;
};

class CreatorPersistenceError extends Error {
  constructor(readonly details: DatabaseFailureDetails, options?: { cause?: unknown }) {
    super("Creator persistence failed", options);
  }
}

class CreatorSyncStageError extends Error {
  constructor(readonly stage: "CURSOR_ERROR" | "PARTITION_CONFIG_ERROR" | "SHEET_RETRY_LIMIT", message: string) { super(message); }
}

@Injectable()
export class CreatorSyncProcessor {
  private readonly options: Options;
  constructor(private readonly prisma: PrismaService, private readonly tiktok: TikTokIntegrationService,
    private readonly identities: CreatorIdentityResolver, private readonly sheets: GoogleSheetsCreatorGateway,
    @Optional() @Inject("CREATOR_SYNC_PROCESSOR_OPTIONS") options?: Options) { this.options = options ?? {}; }

  private now() { return this.options.now?.() ?? new Date(); }
  private followerWidthRules(): FollowerWidthRules {
    return { from600: config.CREATOR_FOLLOWER_MIN_WIDTH_600_999, from1000: config.CREATOR_FOLLOWER_MIN_WIDTH_1000_9999,
      from10000: config.CREATOR_FOLLOWER_MIN_WIDTH_10000_99999, from100000: config.CREATOR_FOLLOWER_MIN_WIDTH_100000_999999,
      from1000000: config.CREATOR_FOLLOWER_MIN_WIDTH_1000000_PLUS };
  }
  private numericYield(partition: Pick<AdaptivePartition, "incrementalYield" | "originalYield">) {
    const value = partition.incrementalYield ?? partition.originalYield;
    return value == null ? null : Number(value);
  }
  private childPriority(parent: AdaptivePartition, depth: number, partitionType: "ADAPTIVE_FOLLOWER" | "ADAPTIVE_GMV") {
    const emptyEvidence = { rows: 0, newCreators: 0, yield: null };
    return scoreSchedulerPriority({ partitionType, adaptiveDepth: depth,
      branchClassification: (parent.partitionType === "V2_SEED" ? "UNCLASSIFIED" : parent.branchClassification) as any,
      expectedYield: this.numericYield(parent),
      expectedNewPerSuccessfulPage: parent.pagesCompleted ? parent.uniqueCreatorsAdded / parent.pagesCompleted : null,
      observedSaturated: parent.observedSaturationState === "OBSERVED_SATURATED",
      gmvBucket: parent.gmvBucket,
      categoryEvidence: emptyEvidence, followerEvidence: emptyEvidence, globalEvidence: emptyEvidence });
  }
  private async createFollowerChildren(tx: Prisma.TransactionClient, parent: AdaptivePartition,
    bounds: readonly [{ min: number; max: number }, { min: number; max: number }], reason: string) {
    const depth = parent.adaptiveDepth + 1, priority = this.childPriority(parent, depth, "ADAPTIVE_FOLLOWER"), now = this.now();
    if (!isSpecificGmvPartition(parent)) throw new Error("Follower recursion requires a specific documented GMV branch");
    const existing = await tx.creatorSearchPartition.findMany({ where: {
      creatorSyncJobId: parent.creatorSyncJobId, categoryId: parent.categoryId, categoryChildId: parent.categoryChildId,
      gmvBucket: parent.gmvBucket, followersMin: { in: bounds.map((bound) => bound.min) }, followersMax: { in: bounds.map((bound) => bound.max) }
    }, select: { categoryId: true, categoryChildId: true, followersMin: true, followersMax: true, gmvBucket: true } });
    const existingKeys = new Set(existing.map((partition) => specificGmvCombinationKey(partition)));
    const missing = bounds.filter((bound) => !existingKeys.has(specificGmvCombinationKey({ categoryId: parent.categoryId,
      categoryChildId: parent.categoryChildId, followersMin: bound.min, followersMax: bound.max, gmvBucket: parent.gmvBucket })));
    const created = await tx.creatorSearchPartition.createMany({ skipDuplicates: true, data: missing.map((bound) => ({
      creatorSyncJobId: parent.creatorSyncJobId, partitionKey: adaptiveFollowerPartitionKey(parent.partitionKey, bound.min, bound.max),
      generation: V3_ADAPTIVE_GENERATION, partitionType: "ADAPTIVE_FOLLOWER", adaptiveDepth: depth,
      categoryId: parent.categoryId, categoryName: parent.categoryName, categoryChildId: parent.categoryChildId,
      categoryChildName: parent.categoryChildName, categoryChildIds: parent.categoryChildIds,
      followersMin: bound.min, followersMax: bound.max, parentPartitionId: parent.id,
      queuePosition: parent.queuePosition * 100n + BigInt(bounds.indexOf(bound) + 1), privateSearchKey: null, privateNextPageToken: null,
      gmvBucket: parent.gmvBucket, gmvRange: parent.gmvRange,
      priorityScore: new Prisma.Decimal(priority.score), priorityReason: priority.reason, priorityUpdatedAt: now
    })) });
    await tx.creatorSearchPartition.update({ where: { id: parent.id }, data: { followerSplitExplored: true } });
    if (created.count) await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: parent.creatorSyncJobId,
      creatorSearchPartitionId: parent.id, partitionKey: parent.partitionKey, partitionLabel: partitionLabel(parent),
      stage: "ADAPTIVE_SPLIT_CREATED", safeMessage: `${reason}: ${bounds.map((bound) => `${bound.min.toLocaleString("en-US")}–${bound.max.toLocaleString("en-US")}`).join(" → ")}`,
      occurredAt: now } });
    return created.count;
  }
  private expansionFor(partition: AdaptivePartition) {
    if (partition.followersMin == null || !PRODUCTION_PARTITION_TYPES.includes(partition.partitionType as ProductionPartitionType)) return { kind: "NONE" as const };
    return adaptiveExpansion({ partitionType: partition.partitionType as ProductionPartitionType,
      observedSaturationState: partition.observedSaturationState as any, followersMin: partition.followersMin,
      followersMax: partition.followersMax, yield: this.numericYield(partition), followerSplitExplored: partition.followerSplitExplored,
      followerRecursionTerminal: partition.followerRecursionTerminal, gmvSplitCreated: partition.gmvSplitCreated,
      gmvBucket: partition.gmvBucket, gmvRange: partition.gmvRange },
      this.followerWidthRules(), config.CREATOR_FIRST_SPLIT_MIN_WIDTH, config.CREATOR_DEEP_SPLIT_MIN_INCREMENTAL_YIELD);
  }
  private async expandReadyBranches(tx: Prisma.TransactionClient, jobId: string) {
    const completedSeeds = await tx.creatorSearchPartition.findMany({ where: { creatorSyncJobId: jobId, partitionType: "V2_SEED",
      gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES }, status: { in: ["COMPLETE", "SPLIT"] }, followerSplitExplored: false,
      followerRecursionTerminal: false, gmvSplitCreated: false } });
    for (const seed of completedSeeds as AdaptivePartition[]) {
      const expansion = this.expansionFor(seed);
      if (expansion.kind === "FOLLOWER") await this.createFollowerChildren(tx, seed, expansion.bounds, "Specific-GMV branch exploratory split created");
      else await tx.creatorSearchPartition.update({ where: { id: seed.id }, data: { followerRecursionTerminal: true } });
    }

    const completedFollowerChildren = await tx.creatorSearchPartition.findMany({ where: { creatorSyncJobId: jobId,
      partitionType: "ADAPTIVE_FOLLOWER", gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES },
      status: { in: ["COMPLETE", "SPLIT", "DEEPLY_SATURATED"] },
      followerSplitExplored: false, followerRecursionTerminal: false, gmvSplitCreated: false, parentPartitionId: { not: null } } });
    const parentIds = [...new Set(completedFollowerChildren.map((partition) => partition.parentPartitionId!))];
    for (const parentId of parentIds) {
      const siblings = await tx.creatorSearchPartition.findMany({ where: { creatorSyncJobId: jobId, parentPartitionId: parentId,
        partitionType: "ADAPTIVE_FOLLOWER" }, orderBy: [{ followersMin: "asc" }, { id: "asc" }] });
      if (siblings.length !== 2 || siblings.some((sibling) => !["COMPLETE", "SPLIT", "DEEPLY_SATURATED"].includes(sibling.status))) continue;
      const combined = combinedIncrementalYield(siblings), classification = classifyIncrementalYield(combined), lowValue = combined < config.CREATOR_LOW_VALUE_COMBINED_YIELD;
      const parent = await tx.creatorSearchPartition.update({ where: { id: parentId }, data: {
        combinedChildIncrementalYield: new Prisma.Decimal(combined), branchClassification: classification,
        followerRecursionTerminal: lowValue
      } });
      if (lowValue) {
        await tx.creatorSearchPartition.updateMany({ where: { id: { in: siblings.map((sibling) => sibling.id) } }, data: { followerRecursionTerminal: true } });
        await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, creatorSearchPartitionId: parent.id,
          partitionKey: parent.partitionKey, partitionLabel: partitionLabel(parent), stage: "ADAPTIVE_BRANCH_LOW_VALUE",
          safeMessage: `Branch low-value — follower recursion stopped (${(combined * 100).toFixed(2)}% combined incremental yield)`, occurredAt: this.now() } });
        continue;
      }
      for (const sibling of siblings as AdaptivePartition[]) {
        const expansion = this.expansionFor(sibling);
        if (expansion.kind === "FOLLOWER") await this.createFollowerChildren(tx, sibling, expansion.bounds, "Specific-GMV branch productive — deeper split queued");
        else await tx.creatorSearchPartition.update({ where: { id: sibling.id }, data: { followerRecursionTerminal: true } });
      }
    }
  }
  async prepareAdaptiveQueue(jobId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('creator-marketplace-adaptive-expansion'))`;
      await this.expandReadyBranches(tx, jobId);
    });
  }
  private receiptRequestKey(partitionId: string, providerRequestToken: string) {
    // Provider page tokens are not globally unique across independent Marketplace searches.
    // Namespacing preserves the existing database uniqueness constraint while making the
    // receipt idempotency key correctly partition-scoped.
    return `PARTITION:${partitionId}:${providerRequestToken}`;
  }
  private databaseFailureDetails(error: unknown): DatabaseFailureDetails {
    if (error instanceof CreatorPersistenceError) return error.details;
    const value = error && typeof error === "object" ? error as { code?: unknown; meta?: unknown; name?: unknown } : {};
    const meta = value.meta && typeof value.meta === "object" ? value.meta as Record<string, unknown> : {};
    const target = Array.isArray(meta.target) ? meta.target.filter((item): item is string => typeof item === "string") : [];
    return {
      prismaCode: typeof value.code === "string" ? value.code : undefined,
      model: typeof meta.modelName === "string" ? meta.modelName : undefined,
      constraint: typeof meta.constraint === "string" ? meta.constraint : undefined,
      field: target.length ? target.join(",") : typeof meta.field_name === "string" ? meta.field_name : undefined
    };
  }
  private safeDatabaseMessage(error: unknown) {
    const details = this.databaseFailureDetails(error);
    const context = [
      details.constraint ? `Constraint: ${details.constraint}` : details.field ? `Field: ${details.field}` : undefined,
      details.recordNumber && details.totalRecords ? `Record: ${details.recordNumber}/${details.totalRecords}` : undefined
    ].filter(Boolean);
    return `PostgreSQL save failed${context.length ? `; ${context.join("; ")}` : ""}; Page remains uncommitted`;
  }
  private safeTikTokMessage(error: TikTokApiError) {
    if (error.providerCode === 36009002) return "Too many Marketplace requests";
    if (error.kind === "RATE_LIMIT") return "TikTok Marketplace rate limit";
    if (error.kind === "TEMPORARY") return "TikTok Marketplace is temporarily unavailable";
    if (error.kind === "AUTH_EXPIRED") return "TikTok authorization expired";
    if (error.kind === "PERMISSION") return "TikTok permission denied";
    if (error.kind === "INVALID_SHOP_CIPHER") return "TikTok shop selection is invalid";
    if (error.kind === "MALFORMED_RESPONSE") return "TikTok returned an invalid response";
    return "TikTok Marketplace request failed";
  }

  private async recordActivity(jobId: string, leaseId: string, partition: { id: string; partitionKey: string; categoryName: string; categoryChildName: string | null; followersMin: number | null; followersMax: number | null;
      followerBucket: string | null; gmvBucket: string | null } | null,
    activity: Activity, jobData: Prisma.CreatorSyncJobUpdateManyMutationInput = {}) {
    const occurredAt = activity.occurredAt ?? this.now();
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.creatorSyncJob.updateMany({ where: { id: jobId, leaseId }, data: { currentStage: activity.stage, ...jobData } });
      if (updated.count !== 1) throw new Error("Creator sync lease changed before activity was recorded");
      await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, creatorSearchPartitionId: partition?.id,
        partitionKey: partition?.partitionKey, partitionLabel: partition ? partitionLabel(partition) : undefined,
        stage: activity.stage, pageNumber: activity.pageNumber, httpStatus: activity.httpStatus, tiktokCode: activity.tiktokCode,
        googleApiCode: activity.googleApiCode, retryable: activity.retryable,
        safeMessage: activity.safeMessage, creatorsReturned: activity.creatorsReturned, creatorsAdded: activity.creatorsAdded,
        duplicates: activity.duplicates, nextAttemptAt: activity.nextAttemptAt, occurredAt } });
    });
  }

  async processNext(adapterOverride?: MarketplaceSearch, sheetOverride?: CreatorSheet): Promise<boolean> {
    const now = this.now();
    const activeShopId = adapterOverride ? undefined : (await this.tiktok.activeShop()).id;
    const candidate = await this.prisma.creatorSyncJob.findFirst({ where: { ...(activeShopId ? { shopId: activeShopId } : {}), state: { in: ["RUNNING", "WAITING"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }], AND: [{ OR: [{ leaseId: null }, { leaseExpiresAt: { lte: now } }] }] },
      orderBy: { updatedAt: "asc" } });
    if (!candidate) return false;
    const leaseId = randomBytes(18).toString("base64url");
    const claimed = await this.prisma.creatorSyncJob.updateMany({ where: { id: candidate.id, state: { in: ["RUNNING", "WAITING"] },
      OR: [{ leaseId: null }, { leaseExpiresAt: { lte: now } }] }, data: { state: "RUNNING", leaseId,
        leaseExpiresAt: new Date(now.getTime() + (this.options.leaseMs ?? LEASE_MS)), nextAttemptAt: null } });
    if (claimed.count !== 1) return true;
    try { await this.processClaimed(candidate.id, leaseId, adapterOverride, sheetOverride ?? this.sheets); }
    catch (error) { await this.handleError(candidate.id, leaseId, error); }
    return true;
  }

  private async claimPartition(jobId: string, leaseId: string) {
    const job = await this.prisma.creatorSyncJob.findFirstOrThrow({ where: { id: jobId, leaseId } });
    if (job.currentPartitionId) {
      const current = await this.prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: job.currentPartitionId } });
      if (isSpecificGmvPartition(current) && ["STARTING", "RUNNING", "WAITING_RETRY", "PAUSED"].includes(current.status)) return current;
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('creator-marketplace-partition-crawler'))`;
      await this.expandReadyBranches(tx, jobId);
      const lockedJob = await tx.creatorSyncJob.findFirstOrThrow({ where: { id: jobId, leaseId } });
      if (lockedJob.currentPartitionId) {
        const current = await tx.creatorSearchPartition.findUnique({ where: { id: lockedJob.currentPartitionId } });
        if (current && isSpecificGmvPartition(current) && ["STARTING", "RUNNING", "WAITING_RETRY", "PAUSED"].includes(current.status)) return current;
        // A migrated GMV-All continuation is intentionally retained on its
        // partition, but it must not be resumed or claimed as future work.
        await tx.creatorSyncJob.updateMany({ where: { id: jobId, leaseId, currentPartitionId: lockedJob.currentPartitionId }, data: {
          currentPartitionId: null, privateSearchKey: null, privateNextPageToken: null, currentStage: "CLAIMING_PARTITION"
        } });
      }
      const nextSequence = lockedJob.partitionClaimSequence + 1, now = this.now();
      const [seed, adaptiveCandidates, historical] = await Promise.all([
        tx.creatorSearchPartition.findFirst({ where: { creatorSyncJobId: jobId, partitionType: "V2_SEED", gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES }, status: "QUEUED" },
          orderBy: [{ queuePosition: "asc" }, { id: "asc" }] }),
        tx.creatorSearchPartition.findMany({ where: { creatorSyncJobId: jobId,
          partitionType: { in: ["ADAPTIVE_FOLLOWER", "ADAPTIVE_GMV"] }, gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES }, status: "QUEUED" }, include: { parentPartition: true } }),
        tx.creatorSearchPartition.findMany({ where: { creatorSyncJobId: jobId, partitionType: { in: [...PRODUCTION_PARTITION_TYPES] },
          gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES },
          status: { in: ["COMPLETE", "SPLIT", "DEEPLY_SATURATED"] }, rowsReturned: { gt: 0 } },
          select: { categoryChildId: true, followersMin: true, followersMax: true, rowsReturned: true,
            uniqueCreatorsAdded: true, lastSuccessAt: true, gmvBucket: true } })
      ]);
      const observations = historical as SchedulerObservation[];
      const scoreCandidate = (candidate: typeof adaptiveCandidates[number] | NonNullable<typeof seed>) => {
        const parent = "parentPartition" in candidate ? candidate.parentPartition : null;
        const localYield = candidate.incrementalYield ?? candidate.originalYield;
        const parentYield = parent?.incrementalYield ?? parent?.originalYield ?? parent?.combinedChildIncrementalYield;
        const expectedYield = localYield == null ? parentYield == null ? null : Number(parentYield) : Number(localYield);
        const expectedNewPerSuccessfulPage = candidate.pagesCompleted > 0
          ? candidate.uniqueCreatorsAdded / candidate.pagesCompleted
          : parent && parent.pagesCompleted > 0 ? parent.uniqueCreatorsAdded / parent.pagesCompleted : null;
        const inheritedClassification = candidate.branchClassification === "UNCLASSIFIED" && parent && parent.partitionType !== "V2_SEED"
          ? parent.branchClassification : candidate.branchClassification;
        const branchObservations = candidate.gmvBucket ? observations.filter((observation) => observation.gmvBucket === candidate.gmvBucket) : [];
        const globalEvidence = aggregateEvidence(branchObservations, now);
        const category = categoryEvidence(observations, candidate.categoryChildId, now, candidate.gmvBucket);
        const follower = followerEvidence(observations, candidate.followersMin, candidate.followersMax, now, candidate.gmvBucket);
        const priority = scoreSchedulerPriority({ partitionType: candidate.partitionType as ProductionPartitionType,
          adaptiveDepth: candidate.adaptiveDepth, branchClassification: inheritedClassification as any,
          expectedYield, expectedNewPerSuccessfulPage,
          gmvBucket: candidate.gmvBucket,
          observedSaturated: (parent?.observedSaturationState ?? candidate.observedSaturationState) === "OBSERVED_SATURATED",
          categoryEvidence: category, followerEvidence: follower, globalEvidence });
        return { candidate, priority, category, follower, expectedYield, expectedNewPerSuccessfulPage,
          queuePosition: candidate.queuePosition, id: candidate.id, gmvBucket: candidate.gmvBucket };
      };
      const scored = adaptiveCandidates.map(scoreCandidate);
      if (seed) scored.push(scoreCandidate(seed) as typeof scored[number]);
      const slot = schedulerSlot(nextSequence, config.CREATOR_V2_EXPLORATION_INTERVAL);
      const explorationIndex = Math.floor((nextSequence - 1) / config.CREATOR_V2_EXPLORATION_INTERVAL) % GMV_BUCKETS.length;
      const selected = selectSchedulerCandidate(scored, slot, slot === "EXPLORATION" ? GMV_BUCKETS[explorationIndex].code : undefined);
      if (!selected) {
        await tx.creatorSyncJob.updateMany({ where: { id: jobId, leaseId }, data: { state: "EXHAUSTED", currentStage: "ALL_PARTITIONS_COMPLETE", leaseId: null, leaseExpiresAt: null } });
        return null;
      }
      const next = selected.candidate, startedAt = now;
      const claimed = await tx.creatorSearchPartition.updateMany({ where: { id: next.id, status: "QUEUED" }, data: {
        status: "STARTING", startedAt, priorityScore: new Prisma.Decimal(selected.priority.score),
        priorityReason: selected.priority.reason, priorityUpdatedAt: startedAt, schedulerClass: selected.priority.schedulerClass,
        schedulerClaimSequence: nextSequence, schedulerCategoryRows: new Prisma.Decimal(selected.category.rows),
        schedulerCategoryYield: selected.category.yield == null ? null : new Prisma.Decimal(selected.category.yield),
        schedulerCategoryWeight: new Prisma.Decimal(selected.priority.categoryWeight),
        schedulerFollowerRows: new Prisma.Decimal(selected.follower.rows),
        schedulerFollowerYield: selected.follower.yield == null ? null : new Prisma.Decimal(selected.follower.yield),
        schedulerFollowerWeight: new Prisma.Decimal(selected.priority.followerWeight),
        schedulerAncestorYield: selected.expectedYield == null ? null : new Prisma.Decimal(selected.expectedYield),
        schedulerNewPerSuccessfulPage: selected.expectedNewPerSuccessfulPage == null ? null : new Prisma.Decimal(selected.expectedNewPerSuccessfulPage)
      } });
      if (claimed.count !== 1) throw new Error("Marketplace partition claim raced");
      await tx.creatorSyncJob.updateMany({ where: { id: jobId, leaseId }, data: { currentPartitionId: next.id,
        privateSearchKey: null, privateNextPageToken: null, partitionClaimSequence: nextSequence, currentStage: "STARTING_PARTITION" } });
      await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, creatorSearchPartitionId: next.id,
        partitionKey: next.partitionKey, partitionLabel: partitionLabel(next), stage: "PARTITION_STARTED", pageNumber: 1,
        safeMessage: schedulerSelectionMessage(selected.priority, next.partitionType as ProductionPartitionType, next.adaptiveDepth), occurredAt: startedAt } });
      return { ...next, status: "STARTING" as const, startedAt, priorityScore: new Prisma.Decimal(selected.priority.score),
        priorityReason: selected.priority.reason, schedulerClass: selected.priority.schedulerClass };
    });
  }

  private async processClaimed(jobId: string, leaseId: string, adapterOverride: MarketplaceSearch | undefined, sheets: CreatorSheet) {
    let job = await this.prisma.creatorSyncJob.findFirstOrThrow({ where: { id: jobId, leaseId } });
    const pending = await this.prisma.creatorSyncPage.findFirst({ where: { creatorSyncJobId: jobId, state: "RECEIVED",
      creatorSearchPartition: { partitionType: { in: [...PRODUCTION_PARTITION_TYPES] } } }, orderBy: { receivedAt: "asc" } });
    if (pending) return this.commitPage(jobId, leaseId, pending.id, sheets);
    if (!job.sheetImportedAt) {
      const existing = await sheets.readCreators(job.spreadsheetId);
      await this.persistCreators(existing, job.shopId, `sheet-import:${job.id}`);
      await this.prisma.creatorSyncJob.updateMany({ where: { id: jobId, leaseId }, data: { sheetImportedAt: this.now() } });
      job = await this.prisma.creatorSyncJob.findFirstOrThrow({ where: { id: jobId, leaseId } });
    }
    if (job.pauseRequested) return this.pauseClaimed(job, leaseId, null);
    const partition = await this.claimPartition(jobId, leaseId);
    if (!partition) return;
    job = await this.prisma.creatorSyncJob.findFirstOrThrow({ where: { id: jobId, leaseId } });
    if (job.pauseRequested) return this.pauseClaimed(job, leaseId, partition);
    const pageNumber = partition.pagesCompleted + 1, attemptedAt = this.now();
    const categoryCatalog = await this.prisma.creatorMarketplaceCategory.findMany({ where: { shopId: job.shopId },
      select: { categoryId: true, parentCategoryId: true, enabledForCreatorCrawl: true, availableForCreatorFilter: true } });
    try {
      if (!isSpecificGmvPartition(partition)) throw new Error("Future Marketplace partitions must specify one documented GMV bucket");
      const requiresOneImmediateChild = PRODUCTION_PARTITION_TYPES.includes(partition.partitionType as ProductionPartitionType);
      (requiresOneImmediateChild ? validateV2CategorySelection : validateMarketplaceCategorySelection)(partition.categoryId!, partition.categoryChildIds, categoryCatalog);
      if (requiresOneImmediateChild && partition.categoryChildIds[0] !== partition.categoryChildId) {
        throw new Error("V2 Marketplace partition child identity does not match its one-child request snapshot");
      }
    }
    catch (error) {
      throw new CreatorSyncStageError("PARTITION_CONFIG_ERROR", error instanceof Error ? error.message : "Marketplace partition category configuration is invalid");
    }
    const filters = partitionFilters(partition);
    await this.recordActivity(jobId, leaseId, partition, { stage: partition.pagesCompleted ? "REQUESTING_TIKTOK" : "STARTING_MARKETPLACE_SEARCH", pageNumber, occurredAt: attemptedAt },
      { lastAttemptAt: attemptedAt, lastAttemptPage: pageNumber, lastHttpStatus: null, lastTikTokCode: null, lastSafeError: null });
    await this.prisma.creatorSearchPartition.updateMany({ where: { id: partition.id }, data: { status: partition.pagesCompleted ? "RUNNING" : "STARTING", lastRequestAt: attemptedAt } });
    const adapter = adapterOverride ?? await this.tiktok.discoveryAdapter();
    await this.prisma.creatorSearchPartition.update({ where: { id: partition.id }, data: { marketplaceRequests: { increment: 1 } } });
    const page = await adapter.searchCreators(filters, { pageSize: 20,
      ...(partition.privateNextPageToken ? { pageToken: partition.privateNextPageToken } : {}),
      ...(partition.privateSearchKey ? { searchKey: partition.privateSearchKey } : {}) });
    const respondedAt = this.now();
    await this.prisma.creatorSearchPartition.updateMany({ where: { id: partition.id },
      data: { business16032001RetryCount: 0, business16032001RetryPage: null } });
    await this.recordActivity(jobId, leaseId, partition, { stage: "TIKTOK_SUCCESS", pageNumber, httpStatus: 200, creatorsReturned: page.creators.length, occurredAt: respondedAt },
      { lastResponseAt: respondedAt, lastHttpStatus: 200, lastTikTokCode: "0", lastSafeError: null, lastCreatorsReturned: page.creators.length });
    if (page.hasMore && !page.nextPageToken) throw new CreatorSyncStageError("CURSOR_ERROR", "TikTok response had has_more without a next page token");
    if (partition.privateNextPageToken && page.nextPageToken === partition.privateNextPageToken) throw new CreatorSyncStageError("CURSOR_ERROR", "TikTok repeated the current page token");
    const searchKey = partition.privateSearchKey || page.searchKey;
    if (!searchKey) throw new CreatorSyncStageError("CURSOR_ERROR", "TikTok omitted the search key");
    await this.recordActivity(jobId, leaseId, partition, { stage: "STAGING_PAGE", pageNumber, creatorsReturned: page.creators.length });
    const providerRequestToken = partition.privateNextPageToken ?? "FIRST";
    const requestToken = this.receiptRequestKey(partition.id, providerRequestToken);
    const uniqueOpenIds = [...new Set(page.creators.map((creator) => creator.creatorOpenId))];
    const existingOpenIds = uniqueOpenIds.length ? await this.prisma.creator.findMany({ where: { creatorOpenId: { in: uniqueOpenIds } }, select: { creatorOpenId: true } }) : [];
    const existingSet = new Set(existingOpenIds.flatMap((creator) => creator.creatorOpenId ? [creator.creatorOpenId] : []));
    const newCreatorOpenIds = uniqueOpenIds.filter((creatorOpenId) => !existingSet.has(creatorOpenId));
    const staged = await this.prisma.creatorSyncPage.upsert({ where: { creatorSyncJobId_privateRequestToken: { creatorSyncJobId: jobId, privateRequestToken: requestToken } }, update: {},
      create: { creatorSyncJobId: jobId, creatorSearchPartitionId: partition.id, pageNumber, privateRequestToken: requestToken,
        privateNextToken: page.nextPageToken, privateSearchKey: searchKey, providerHasMore: page.hasMore,
        creatorsReturned: page.creators.length, newUniqueCreators: newCreatorOpenIds.length,
        duplicateRows: Math.max(0, page.creators.length - newCreatorOpenIds.length), newCreatorOpenIds,
        payload: page.creators as unknown as Prisma.InputJsonValue } });
    return this.commitPage(jobId, leaseId, staged.id, sheets);
  }

  private async pauseClaimed(job: { id: string; pagesCompleted: number; currentPartitionId: string | null }, leaseId: string, partition: { id: string } | null) {
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.creatorSyncJob.updateMany({ where: { id: job.id, leaseId }, data: { state: "PAUSED", currentStage: "PAUSED", pauseRequested: false, nextAttemptAt: null, leaseId: null, leaseExpiresAt: null } });
      if (partition) await tx.creatorSearchPartition.update({ where: { id: partition.id }, data: { status: "PAUSED" } });
      await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: job.id, creatorSearchPartitionId: partition?.id ?? job.currentPartitionId, stage: "PAUSED", occurredAt: now } });
    });
  }

  private async persistCreators(creators: CreatorCandidate[], shopId: string, sourcePageKey: string) {
    const batchSize = 20;
    for (let offset = 0; offset < creators.length; offset += batchSize) await this.prisma.$transaction(async (tx) => {
      const batch = creators.slice(offset, offset + batchSize);
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
        const index = offset + batchIndex, creator = batch[batchIndex];
        try {
          const stored = await this.identities.ensureMarketplaceCreatorInTransaction(tx, creator);
          const data = { shopId, followerCount: creator.followerCount, categoryIds: creator.categoryIds,
            gmvAmount: creator.gmv ? new Prisma.Decimal(creator.gmv.amount) : null, gmvCurrency: creator.gmv?.currency,
            unitsSold: creator.unitsSold, avgVideoViews: creator.avgVideoViews, avgLiveViewers: creator.avgLiveViewers,
            engagementRate: creator.engagementRate == null ? null : new Prisma.Decimal(creator.engagementRate),
            metrics: { liveGmv: creator.liveGmv, videoGmv: creator.videoGmv, gmvRange: creator.gmvRange, topAgeRanges: creator.topAgeRanges,
              majorGender: creator.majorGender, majorGenderPercentage: creator.majorGenderPercentage } as Prisma.InputJsonValue,
            rawPayload: creator as unknown as Prisma.InputJsonValue, sourceFetchedAt: this.now() };
          await tx.creatorMetricSnapshot.upsert({ where: { creatorId_sourcePageKey: { creatorId: stored.id, sourcePageKey: `${sourcePageKey}:${creator.creatorOpenId}` } },
            update: data, create: { creatorId: stored.id, sourcePageKey: `${sourcePageKey}:${creator.creatorOpenId}`, ...data } });
        } catch (error) {
          throw new CreatorPersistenceError({ ...this.databaseFailureDetails(error), recordNumber: index + 1, totalRecords: creators.length }, { cause: error });
        }
      }
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private safeSheetsFailureMessage(details: ReturnType<typeof googleSheetsFailure>) {
    const http = details.httpStatus == null ? "HTTP unavailable" : `HTTP ${details.httpStatus}`;
    const code = details.googleApiCode ? `Google API error code ${details.googleApiCode}` : "Google API error code unavailable";
    const classification = details.retryable ? "retryable" : "non-retryable";
    return `${http}; ${code}; ${classification}${details.safeReason ? `: ${details.safeReason}` : ""}`;
  }

  private async commitPage(jobId: string, leaseId: string, pageId: string, sheets: CreatorSheet) {
    const page = await this.prisma.creatorSyncPage.findFirstOrThrow({ where: { id: pageId, creatorSyncJobId: jobId, state: "RECEIVED" } });
    if (!page.creatorSearchPartitionId) throw new Error("Pending structured page has no partition");
    if (page.sheetsAttemptCount >= SHEETS_MAX_ATTEMPTS) {
      throw new CreatorSyncStageError("SHEET_RETRY_LIMIT", `Google Sheets retry limit reached (${SHEETS_MAX_ATTEMPTS}/${SHEETS_MAX_ATTEMPTS})`);
    }
    const [job, partition] = await Promise.all([
      this.prisma.creatorSyncJob.findFirstOrThrow({ where: { id: jobId, leaseId } }),
      this.prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: page.creatorSearchPartitionId } })
    ]);
    const creators = page.payload as unknown as CreatorCandidate[], ids = [...new Set(creators.map((creator) => creator.creatorOpenId))];
    const fallbackStoredBefore = page.newUniqueCreators == null && ids.length
      ? await this.prisma.creator.count({ where: { creatorOpenId: { in: ids } } }) : 0;
    await this.recordActivity(jobId, leaseId, partition, { stage: "SAVING_DATABASE", pageNumber: page.pageNumber, creatorsReturned: creators.length });
    await this.persistCreators(creators, job.shopId, `creator-sync-page:${page.id}`);
    const creatorsAdded = page.newUniqueCreators ?? Math.min(creators.length, Math.max(0, ids.length - fallbackStoredBefore));
    const duplicates = page.duplicateRows ?? Math.max(0, creators.length - creatorsAdded);
    await this.recordActivity(jobId, leaseId, partition, { stage: "SAVING_SHEET", pageNumber: page.pageNumber, creatorsReturned: creators.length, creatorsAdded, duplicates });
    const sheetAttempt = page.sheetsAttemptCount + 1;
    await this.prisma.creatorSyncPage.update({ where: { id: page.id }, data: { sheetsAttemptCount: sheetAttempt, nextSheetsAttemptAt: null } });
    await sheets.reconcilePage(job.spreadsheetId, creators);
    await this.recordActivity(jobId, leaseId, partition, { stage: "COMMITTING_PAGE", pageNumber: page.pageNumber, creatorsReturned: creators.length, creatorsAdded, duplicates });
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      const pause = job.pauseRequested;
      const strategyDisabled = !isSpecificGmvPartition(partition);
      const marketplaceRequests = Math.max(1, partition.marketplaceRequests);
      const rowsReturned = partition.rowsReturned + page.creatorsReturned;
      const uniqueCreatorsAdded = partition.uniqueCreatorsAdded + creatorsAdded;
      const totalDuplicates = partition.duplicates + duplicates;
      const newCreatorsPerRequest = new Prisma.Decimal(uniqueCreatorsAdded).div(marketplaceRequests);
      const duplicateRate = rowsReturned ? new Prisma.Decimal(totalDuplicates).div(rowsReturned) : new Prisma.Decimal(0);
      const yieldValue = rowsReturned ? uniqueCreatorsAdded / rowsReturned : 0;
      const originalYield = partition.partitionType === "V2_SEED" ? new Prisma.Decimal(yieldValue) : partition.originalYield;
      const incrementalYield = ["ADAPTIVE_FOLLOWER", "ADAPTIVE_GMV"].includes(partition.partitionType)
        ? new Prisma.Decimal(yieldValue) : partition.incrementalYield;
      await tx.creatorSyncPage.update({ where: { id: page.id }, data: { state: "COMMITTED", committedAt: now, sheetsAttemptCount: 0,
        nextSheetsAttemptAt: null, lastSheetsHttpStatus: null, lastSheetsApiCode: null, lastSheetsRetryable: null, lastSheetsError: null } });
      if (sheetAttempt > 1) await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, creatorSearchPartitionId: partition.id,
        partitionKey: partition.partitionKey, partitionLabel: partitionLabel(partition), stage: "SHEET_RECOVERED", pageNumber: page.pageNumber,
        safeMessage: "Google Sheets save recovered", creatorsReturned: creators.length, creatorsAdded, duplicates, occurredAt: new Date(now.getTime() - 2) } });
      if (page.providerHasMore) {
        await tx.creatorSearchPartition.update({ where: { id: partition.id }, data: { status: strategyDisabled ? "DISABLED_BY_STRATEGY" : pause ? "PAUSED" : "RUNNING", privateSearchKey: page.privateSearchKey,
          privateNextPageToken: page.privateNextToken, pagesCompleted: { increment: 1 }, rowsReturned: { increment: page.creatorsReturned },
          uniqueCreatorsAdded: { increment: creatorsAdded }, duplicates: { increment: duplicates }, newCreatorsPerRequest, duplicateRate,
          originalYield, incrementalYield,
          lastSuccessAt: now, lastError: null } });
        await tx.creatorSyncJob.updateMany({ where: { id: jobId, leaseId, currentPartitionId: partition.id }, data: { state: strategyDisabled || pause ? "PAUSED" : "RUNNING",
          currentStage: strategyDisabled ? "GMV_ALL_DISABLED_BY_STRATEGY" : pause ? "PAUSED" : "PAGE_COMMITTED", privateSearchKey: page.privateSearchKey, privateNextPageToken: page.privateNextToken,
          pagesCompleted: { increment: 1 }, creatorsFetched: { increment: page.creatorsReturned }, creatorsFetchedThisRun: { increment: page.creatorsReturned },
          pauseRequested: false, lastPageAt: now, lastSuccessAt: now, lastError: null, lastProviderCode: "0", lastSafeError: null,
          lastCreatorsReturned: creators.length, lastCreatorsAdded: creatorsAdded, lastDuplicates: duplicates,
          nextAttemptAt: strategyDisabled || pause ? null : new Date(now.getTime() + config.MARKETPLACE_SUCCESS_SPACING_MS), leaseId: null, leaseExpiresAt: null } });
        if (!strategyDisabled && !pause) await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, creatorSearchPartitionId: partition.id,
           partitionKey: partition.partitionKey, partitionLabel: partitionLabel(partition), stage: "CURSOR_ADVANCED", pageNumber: page.pageNumber + 1,
          safeMessage: `Continuing to page ${page.pageNumber + 1}`, occurredAt: new Date(now.getTime() + 1) } });
      } else {
        const saturation = observedSaturationState(true, rowsReturned, config.CREATOR_OBSERVED_SATURATION_MIN_ROWS, config.CREATOR_OBSERVED_SATURATION_MAX_ROWS);
        const saturated = saturation === "OBSERVED_SATURATED";
        const classification = classifyIncrementalYield(yieldValue);
        const finalStatus: "COMPLETE" | "DEEPLY_SATURATED" | "DISABLED_BY_STRATEGY" = strategyDisabled
          ? "DISABLED_BY_STRATEGY" : partition.partitionType === "ADAPTIVE_GMV" && saturated ? "DEEPLY_SATURATED" : "COMPLETE";
        await tx.creatorSearchPartition.update({ where: { id: partition.id }, data: { status: finalStatus, privateSearchKey: page.privateSearchKey,
          privateNextPageToken: null, pagesCompleted: { increment: 1 }, rowsReturned: { increment: page.creatorsReturned }, uniqueCreatorsAdded: { increment: creatorsAdded },
          duplicates: { increment: duplicates }, newCreatorsPerRequest, duplicateRate, originalYield, incrementalYield,
          observedSaturationState: saturation, branchClassification: classification, mayStillBeDense: saturated,
          lastSuccessAt: now, completedAt: now, lastError: null } });
        if (!strategyDisabled) await this.expandReadyBranches(tx, jobId);
        const queuedAfter = await tx.creatorSearchPartition.count({ where: { creatorSyncJobId: jobId,
          partitionType: { in: [...PRODUCTION_PARTITION_TYPES] }, gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES }, status: "QUEUED" } });
        await tx.creatorSyncJob.updateMany({ where: { id: jobId, leaseId, currentPartitionId: partition.id }, data: { state: strategyDisabled || pause ? "PAUSED" : queuedAfter ? "RUNNING" : "EXHAUSTED",
          currentStage: strategyDisabled ? "GMV_ALL_DISABLED_BY_STRATEGY" : pause ? "PAUSED" : finalStatus === "DEEPLY_SATURATED" ? "DEEPLY_SATURATED" : "PARTITION_COMPLETE",
          currentPartitionId: strategyDisabled ? partition.id : null, privateSearchKey: strategyDisabled ? page.privateSearchKey : null, privateNextPageToken: null, pagesCompleted: { increment: 1 }, creatorsFetched: { increment: page.creatorsReturned },
          creatorsFetchedThisRun: { increment: page.creatorsReturned }, pauseRequested: false, lastPageAt: now, lastSuccessAt: now, lastError: null,
          lastProviderCode: "0", lastSafeError: null, lastCreatorsReturned: creators.length, lastCreatorsAdded: creatorsAdded,
          lastDuplicates: duplicates, nextAttemptAt: strategyDisabled || pause || !queuedAfter ? null : new Date(now.getTime() + config.MARKETPLACE_SUCCESS_SPACING_MS), leaseId: null, leaseExpiresAt: null } });
        if (saturated) await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, creatorSearchPartitionId: partition.id, partitionKey: partition.partitionKey,
          partitionLabel: partitionLabel(partition), stage: "OBSERVED_SATURATED", pageNumber: page.pageNumber,
          safeMessage: `${rowsReturned} rows — empirically observed saturated`, occurredAt: new Date(now.getTime() + 1) } });
      }
      await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, creatorSearchPartitionId: partition.id, partitionKey: partition.partitionKey,
        partitionLabel: partitionLabel(partition), stage: page.providerHasMore ? "PAGE_COMMITTED" : "PARTITION_EXHAUSTED", pageNumber: page.pageNumber,
        creatorsReturned: creators.length, creatorsAdded, duplicates, occurredAt: now } });
    });
  }

  private async handleSheetsFailure(job: { id: string; pauseRequested: boolean }, partition: { id: string; partitionKey: string; categoryName: string; categoryChildName: string | null; followersMin: number | null; followersMax: number | null; followerBucket: string | null; gmvBucket: string | null; gmvRange: string | null } | null, error: unknown) {
    const page = await this.prisma.creatorSyncPage.findFirst({ where: { creatorSyncJobId: job.id, state: "RECEIVED" }, orderBy: { receivedAt: "asc" }, include: { creatorSearchPartition: true } });
    if (!page) return false;
    const targetPartition = partition ?? page.creatorSearchPartition;
    const strategyDisabled = !targetPartition || !isSpecificGmvPartition(targetPartition);
    const details = googleSheetsFailure(error);
    const limitReached = error instanceof CreatorSyncStageError && error.stage === "SHEET_RETRY_LIMIT"
      ? true : details.retryable && page.sheetsAttemptCount >= SHEETS_MAX_ATTEMPTS;
    const pause = strategyDisabled || job.pauseRequested || !details.retryable || limitReached;
    const nextAttemptAt = new Date(this.now().getTime() + SHEETS_RETRY_MS);
    const attempt = Math.max(1, page.sheetsAttemptCount);
    const detail = this.safeSheetsFailureMessage(details);
    const safe = !details.retryable
      ? `Google Sheets save failed — ${detail}; crawler paused`
      : strategyDisabled
        ? `Google Sheets save failed — staged GMV-All page retained; crawler paused by strategy; ${detail}`
      : limitReached
        ? `Google Sheets save failed — retry limit reached (${SHEETS_MAX_ATTEMPTS}/${SHEETS_MAX_ATTEMPTS}); ${detail}; crawler paused`
        : job.pauseRequested
          ? `Google Sheets save failed — retry ${attempt + 1}/${SHEETS_MAX_ATTEMPTS} canceled because the crawler is paused; ${detail}`
          : `Google Sheets save failed — retry ${attempt + 1}/${SHEETS_MAX_ATTEMPTS} in 5s; ${detail}`;
    const currentStage = strategyDisabled ? "GMV_ALL_DISABLED_BY_STRATEGY" : limitReached ? "SHEET_RETRY_LIMIT" : pause ? "SHEET_ERROR" : "WAITING_SHEET_RETRY";
    const eventStage = strategyDisabled ? "GMV_ALL_DISABLED_BY_STRATEGY" : limitReached ? "SHEET_RETRY_LIMIT" : !details.retryable || job.pauseRequested ? "SHEET_ERROR" : "SHEET_RETRY";
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.creatorSyncPage.update({ where: { id: page.id }, data: {
        sheetsAttemptCount: attempt, nextSheetsAttemptAt: pause ? null : nextAttemptAt,
        lastSheetsHttpStatus: details.httpStatus ?? null, lastSheetsApiCode: details.googleApiCode ?? null,
        lastSheetsRetryable: details.retryable, lastSheetsError: safe
      } });
      await tx.creatorSyncJob.update({ where: { id: job.id }, data: {
        state: pause ? "PAUSED" : "WAITING", currentStage, pauseRequested: false, nextAttemptAt: pause ? null : nextAttemptAt,
        lastError: safe, lastSafeError: safe, lastHttpStatus: details.httpStatus ?? null, lastTikTokCode: null,
        lastProviderCode: details.googleApiCode ?? "GOOGLE_SHEETS", leaseId: null, leaseExpiresAt: null
      } });
      if (targetPartition) await tx.creatorSearchPartition.update({ where: { id: targetPartition.id }, data: {
        status: strategyDisabled ? "DISABLED_BY_STRATEGY" : pause ? "PAUSED" : "WAITING_RETRY", lastError: safe
      } });
      await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: job.id, creatorSearchPartitionId: targetPartition?.id,
        partitionKey: targetPartition?.partitionKey, partitionLabel: targetPartition ? partitionLabel(targetPartition) : undefined,
        stage: eventStage, pageNumber: page.pageNumber, httpStatus: details.httpStatus, googleApiCode: details.googleApiCode,
        retryable: details.retryable, safeMessage: safe, creatorsReturned: page.creatorsReturned,
        nextAttemptAt: pause ? undefined : nextAttemptAt, occurredAt: now } });
    });
    return true;
  }

  private async handleError(jobId: string, leaseId: string, error: unknown) {
    const job = await this.prisma.creatorSyncJob.findFirst({ where: { id: jobId, leaseId } });
    if (!job) return;
    const partition = job.currentPartitionId ? await this.prisma.creatorSearchPartition.findUnique({ where: { id: job.currentPartitionId } }) : null;
    const now = this.now();
    const pendingSheet = await this.prisma.creatorSyncPage.findFirst({ where: { creatorSyncJobId: jobId, state: "RECEIVED" }, select: { id: true } });
    if (pendingSheet && (job.currentStage === "SAVING_SHEET" || job.currentStage === "WAITING_SHEET_RETRY"
      || (error instanceof CreatorSyncStageError && error.stage === "SHEET_RETRY_LIMIT"))) {
      if (await this.handleSheetsFailure(job, partition, error)) return;
    }
    if (error instanceof TikTokApiError && error.operation === "SEARCH_CREATORS" && error.providerCode === 16032001 && partition) {
      const pageNumber = partition.pagesCompleted + 1;
      const attempt = partition.business16032001RetryPage === pageNumber ? partition.business16032001RetryCount + 1 : 1;
      const limitReached = attempt >= BUSINESS_16032001_MAX_ATTEMPTS;
      const nextAttemptAt = new Date(now.getTime() + CREATOR_MARKETPLACE_RETRY_MS);
      const safe = limitReached
        ? `TikTok business error — 16032001 — retry limit reached (${attempt}/${BUSINESS_16032001_MAX_ATTEMPTS})`
        : `TikTok business error — 16032001 — transient retry ${attempt}/${BUSINESS_16032001_MAX_ATTEMPTS} in 5s`;
      const pause = job.pauseRequested || limitReached;
      await this.prisma.$transaction(async (tx) => {
        await tx.creatorSyncJob.update({ where: { id: jobId }, data: {
          state: pause ? "PAUSED" : "WAITING", currentStage: limitReached ? "TIKTOK_BUSINESS_RETRY_LIMIT" : pause ? "PAUSED" : "WAITING_BUSINESS_RETRY",
          pauseRequested: false, nextAttemptAt: pause ? null : nextAttemptAt, lastProviderCode: "16032001", lastError: safe,
          lastResponseAt: now, lastHttpStatus: error.httpStatus, lastTikTokCode: "16032001", lastSafeError: safe,
          lastCreatorsReturned: null, lastCreatorsAdded: null, lastDuplicates: null, leaseId: null, leaseExpiresAt: null
        } });
        await tx.creatorSearchPartition.update({ where: { id: partition.id }, data: {
          status: pause ? "PAUSED" : "WAITING_RETRY", lastError: safe,
          business16032001RetryCount: attempt, business16032001RetryPage: pageNumber
        } });
        await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, creatorSearchPartitionId: partition.id,
          partitionKey: partition.partitionKey, partitionLabel: partitionLabel(partition),
          stage: limitReached ? "TIKTOK_BUSINESS_RETRY_LIMIT" : "TIKTOK_BUSINESS_RETRY", pageNumber,
          httpStatus: error.httpStatus, tiktokCode: "16032001", safeMessage: safe,
          nextAttemptAt: pause ? undefined : nextAttemptAt, occurredAt: now } });
      });
      return;
    }
    if (error instanceof TikTokApiError && ["RATE_LIMIT", "TEMPORARY"].includes(error.kind)) {
      const marketplaceThrottle = error.operation === "SEARCH_CREATORS" && error.kind === "RATE_LIMIT"
        && (error.httpStatus === 429 || error.providerCode === 36009002);
      const retryDelayMs = marketplaceThrottle ? marketplaceRetryDelayMs(job.marketplaceRetryDelaySeconds) : CREATOR_MARKETPLACE_RETRY_MS;
      const localRetryAt = new Date(now.getTime() + Math.max(retryDelayMs, error.retryAfterMs ?? 0));
      const nextAttemptAt = error.nextPermittedAt && error.nextPermittedAt > localRetryAt ? error.nextPermittedAt : localRetryAt;
      const code = error.providerCode ? String(error.providerCode) : undefined, safe = this.safeTikTokMessage(error), pause = job.pauseRequested;
      await this.prisma.$transaction(async (tx) => {
        await tx.creatorSyncJob.update({ where: { id: jobId }, data: { state: pause ? "PAUSED" : "WAITING", currentStage: pause ? "PAUSED" : "WAITING_RETRY",
          pauseRequested: false, nextAttemptAt: pause ? null : nextAttemptAt, lastProviderCode: code ?? error.kind, lastError: safe,
          lastResponseAt: error.httpStatus == null ? job.lastResponseAt : now, lastHttpStatus: error.httpStatus, lastTikTokCode: code,
          lastSafeError: safe, leaseId: null, leaseExpiresAt: null } });
        if (partition) await tx.creatorSearchPartition.update({ where: { id: partition.id }, data: {
          status: pause ? "PAUSED" : "WAITING_RETRY", lastError: safe,
          ...(error.kind === "RATE_LIMIT" ? { throttleAttempts: { increment: 1 } } : {})
        } });
        await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, creatorSearchPartitionId: partition?.id, partitionKey: partition?.partitionKey,
          partitionLabel: partition ? partitionLabel(partition) : undefined, stage: error.kind === "RATE_LIMIT" ? "TIKTOK_THROTTLED" : "TIKTOK_ERROR",
          pageNumber: (partition?.pagesCompleted ?? 0) + 1, httpStatus: error.httpStatus, tiktokCode: code, safeMessage: safe,
          nextAttemptAt: pause ? undefined : nextAttemptAt, occurredAt: now } });
      });
      return;
    }
    const stage = error instanceof CreatorSyncStageError ? error.stage : error instanceof TikTokApiError ? "TIKTOK_ERROR"
      : ["STAGING_PAGE", "SAVING_DATABASE"].includes(job.currentStage) ? "DATABASE_ERROR" : job.currentStage === "SAVING_SHEET" ? "SHEET_ERROR"
      : job.currentStage === "COMMITTING_PAGE" ? "CURSOR_ERROR" : "SYNC_ERROR";
    const safe = error instanceof TikTokApiError ? this.safeTikTokMessage(error)
      : stage === "PARTITION_CONFIG_ERROR" ? error instanceof Error ? error.message : "Marketplace partition category configuration is invalid"
      : stage === "DATABASE_ERROR" ? this.safeDatabaseMessage(error)
      : stage === "SHEET_ERROR" ? "Google Sheets save failed; the page was not committed"
      : stage === "CURSOR_ERROR" ? "Page commit failed; the cursor was not advanced" : "Creator synchronization failed before the page was committed";
    if (stage === "DATABASE_ERROR") {
      const details = this.databaseFailureDetails(error);
      console.error(JSON.stringify({ level: "error", worker: "discovery-worker", event: "creator_sync_database_failure",
        pageNumber: (partition?.pagesCompleted ?? 0) + 1, ...details }));
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.creatorSyncJob.update({ where: { id: jobId }, data: { state: "ERROR", currentStage: stage, lastError: safe, lastSafeError: safe,
        lastResponseAt: error instanceof TikTokApiError && error.httpStatus != null ? now : job.lastResponseAt,
        lastHttpStatus: error instanceof TikTokApiError ? error.httpStatus : job.lastHttpStatus,
        lastTikTokCode: error instanceof TikTokApiError && error.providerCode ? String(error.providerCode) : null,
        lastProviderCode: error instanceof TikTokApiError ? String(error.providerCode ?? error.kind) : job.lastProviderCode,
        nextAttemptAt: null, leaseId: null, leaseExpiresAt: null } });
      if (partition) await tx.creatorSearchPartition.update({ where: { id: partition.id }, data: { status: "ERROR", lastError: safe } });
      await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, creatorSearchPartitionId: partition?.id, partitionKey: partition?.partitionKey,
        partitionLabel: partition ? partitionLabel(partition) : undefined, stage, pageNumber: (partition?.pagesCompleted ?? 0) + 1,
        safeMessage: safe, occurredAt: now } });
    });
  }
}
