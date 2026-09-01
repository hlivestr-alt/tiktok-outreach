import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@affiliate/db";
import { config, PrismaService } from "../shared";
import type { TikTokShopCategory } from "@affiliate/contracts";
import { TikTokIntegrationService } from "../integrations/tiktok.service";
import { followerRangeLabel, GMV_BUCKETS, PRODUCTION_PARTITION_TYPES, SPECIFIC_GMV_BUCKET_CODES, V3_ADAPTIVE_GENERATION,
  partitionKeyV2, specificGmvCombinationKey, v2BasePartitionRows } from "./marketplace-partitions";
import { TikTokApiError } from "@affiliate/tiktok-adapter";
import { DEFAULT_MARKETPLACE_RETRY_DELAY_SECONDS, MIN_MARKETPLACE_RETRY_DELAY_SECONDS, parseMarketplaceRetryDelaySeconds } from "./retry-settings";

@Injectable()
export class CreatorDatabaseService {
  constructor(private readonly prisma: PrismaService, private readonly tiktok: TikTokIntegrationService) {}

  async ensureJob() {
    const shop = await this.tiktok.activeShop();
    return this.prisma.creatorSyncJob.upsert({
      where: { shopId: shop.id }, update: {}, create: {
        shopId: shop.id, state: "PAUSED", privateNextPageToken: config.CREATOR_SYNC_INITIAL_PAGE_TOKEN,
        privateSearchKey: config.CREATOR_SYNC_INITIAL_SEARCH_KEY, pagesCompleted: config.CREATOR_SYNC_INITIAL_PAGES,
        creatorsFetched: config.CREATOR_SYNC_INITIAL_CREATORS, spreadsheetId: config.CREATOR_SYNC_SPREADSHEET_ID,
        marketplaceRetryDelaySeconds: DEFAULT_MARKETPLACE_RETRY_DELAY_SECONDS
      }
    });
  }

  async refreshCategories() {
    const job = await this.ensureJob();
    if (job.state !== "PAUSED") throw new BadRequestException("Pause the Creator Database crawler before refreshing category metadata");
    await this.prisma.creatorSyncEvent.create({ data: { creatorSyncJobId: job.id, stage: "CATEGORY_REFRESH_STARTED", occurredAt: new Date() } });
    let categories: TikTokShopCategory[];
    try {
      const adapter = await this.tiktok.categoryMetadataAdapter();
      categories = await adapter.getCategories!();
    } catch (error) {
      const tiktok = error instanceof TikTokApiError ? error : null;
      await this.prisma.creatorSyncEvent.create({ data: { creatorSyncJobId: job.id, stage: "CATEGORY_REFRESH_FAILED",
        httpStatus: tiktok?.httpStatus, tiktokCode: tiktok?.providerCode == null ? undefined : String(tiktok.providerCode),
        safeMessage: tiktok ? `Category refresh failed (${tiktok.kind})` : "Category refresh is not configured", occurredAt: new Date() } });
      throw error;
    }
    if (!categories.length) throw new BadRequestException("TikTok returned no Marketplace-compatible categories");
    const byId = new Map(categories.map((category) => [category.id, category]));
    if (byId.size !== categories.length) throw new BadRequestException("TikTok returned duplicate category IDs");
    for (const category of categories) if (category.parentId !== "0" && !byId.has(category.parentId)) {
      throw new BadRequestException("TikTok returned an incomplete category hierarchy");
    }
    for (const category of categories) {
      const seen = new Set([category.id]); let current = category;
      while (current.parentId !== "0") {
        if (seen.has(current.parentId)) throw new BadRequestException("TikTok returned a cyclic category hierarchy");
        seen.add(current.parentId); current = byId.get(current.parentId)!;
      }
    }
    const levelOf = (id: string) => {
      let level = 1, current = byId.get(id); const seen = new Set<string>();
      while (current && current.parentId !== "0" && byId.has(current.parentId) && !seen.has(current.parentId)) {
        seen.add(current.parentId); level++; current = byId.get(current.parentId);
      }
      return level;
    };
    const existing = await this.prisma.creatorMarketplaceCategory.findMany({ where: { shopId: job.shopId } });
    const existingById = new Map(existing.map((category) => [category.categoryId, category]));
    let added = 0, updated = 0;
    for (const category of categories) {
      const before = existingById.get(category.id), root = category.parentId === "0";
      if (!before) added++;
      else if (before.categoryName !== category.localName || before.parentCategoryId !== (root ? null : category.parentId)
        || before.level !== levelOf(category.id) || before.isLeaf !== category.isLeaf) updated++;
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.creatorMarketplaceCategory.updateMany({ where: { shopId: job.shopId, categoryId: { notIn: categories.map((category) => category.id) } },
        data: { enabledForCreatorCrawl: false, availableForCreatorFilter: false } });
      for (let index = 0; index < categories.length; index++) {
        const category = categories[index], root = category.parentId === "0";
        await tx.creatorMarketplaceCategory.upsert({
          where: { shopId_categoryId: { shopId: job.shopId, categoryId: category.id } },
          update: { categoryName: category.localName, parentCategoryId: root ? null : category.parentId, level: levelOf(category.id), isLeaf: category.isLeaf,
            sortOrder: index, availableForCreatorFilter: true, fetchedAt: now },
          create: { shopId: job.shopId, categoryId: category.id, categoryName: category.localName, parentCategoryId: root ? null : category.parentId,
            level: levelOf(category.id), enabledForCreatorCrawl: root, availableForCreatorFilter: true, sortOrder: index, isLeaf: category.isLeaf, fetchedAt: now }
        });
      }
    });
    await this.initializePartitions(job.id);
    const parents = categories.filter((category) => category.parentId === "0").length;
    await this.prisma.creatorSyncEvent.create({ data: { creatorSyncJobId: job.id, stage: "CATEGORY_REFRESH_SUCCESS",
      safeMessage: `${categories.length} categories loaded (${added} added, ${updated} updated)`, occurredAt: now } });
    return { ...(await this.status()), categoryRefresh: { parents, children: categories.length - parents, added, updated } };
  }

  private async ensureSpecificGmvPartitions(tx: Prisma.TransactionClient, jobId: string, catalog: Array<{
    categoryId: string; categoryName: string; parentCategoryId: string | null; enabledForCreatorCrawl: boolean;
    availableForCreatorFilter: boolean; sortOrder: number;
  }>) {
    const rows = v2BasePartitionRows(catalog);
    const historicalRoots = await tx.creatorSearchPartition.findMany({ where: { creatorSyncJobId: jobId,
      partitionType: "V2_SEED", gmvBucket: null }, select: { id: true, partitionKey: true, categoryId: true, categoryChildId: true,
      followersMin: true, followersMax: true } });
    const rootByKey = new Map(historicalRoots.map((root) => [root.partitionKey, root.id]));
    const existing = await tx.creatorSearchPartition.findMany({ where: { creatorSyncJobId: jobId, gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES } },
      select: { categoryId: true, categoryChildId: true, followersMin: true, followersMax: true, gmvBucket: true } });
    const existingKeys = new Set(existing.map((partition) => specificGmvCombinationKey(partition)));
    const missing = rows.filter((row) => !existingKeys.has(specificGmvCombinationKey({ categoryId: row.parentCategoryId,
      categoryChildId: row.childCategoryId, followersMin: row.followersMin, followersMax: row.followersMax, gmvBucket: row.gmvBucket })));
    const now = new Date();
    const created = await tx.creatorSearchPartition.createMany({ skipDuplicates: true, data: missing.map((row) => ({
      creatorSyncJobId: jobId, partitionKey: row.partitionKey, generation: V3_ADAPTIVE_GENERATION, partitionType: "V2_SEED", adaptiveDepth: 0,
      categoryId: row.parentCategoryId, categoryName: row.parentCategoryName, categoryChildId: row.childCategoryId,
      categoryChildName: row.childCategoryName, categoryChildIds: [row.childCategoryId], followerBucket: row.followerBucket,
      followersMin: row.followersMin, followersMax: row.followersMax, gmvBucket: row.gmvBucket, gmvRange: row.gmvRange,
      parentPartitionId: rootByKey.get(partitionKeyV2(row.parentCategoryId, row.childCategoryId, row.followersMin, row.followersMax)),
      status: "QUEUED", queuePosition: row.queuePosition, priorityScore: 100,
      priorityReason: "Untested specific-GMV seed exploration", priorityUpdatedAt: now
    })) });
    return { generated: rows.length, created: created.count, skippedExisting: rows.length - missing.length };
  }

  async initializePartitions(jobId?: string) {
    const job = jobId ? await this.prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: jobId } }) : await this.ensureJob();
    if (job.state !== "PAUSED" && job.state !== "EXHAUSTED") throw new BadRequestException("Pause the Creator Database crawler before initializing V2");
    const pendingPage = await this.prisma.creatorSyncPage.findFirst({ where: { creatorSyncJobId: job.id, state: "RECEIVED" } });
    if (pendingPage) throw new BadRequestException("A staged Marketplace page is awaiting Google Sheets reconciliation; Continue it before reinitializing partitions");
    const catalog = await this.prisma.creatorMarketplaceCategory.findMany({ where: { shopId: job.shopId }, select: {
      categoryId: true, categoryName: true, parentCategoryId: true, enabledForCreatorCrawl: true, availableForCreatorFilter: true, sortOrder: true
    } });
    if (!v2BasePartitionRows(catalog).length) throw new BadRequestException("No valid immediate Marketplace child categories are available for specific-GMV discovery");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('creator-marketplace-v2-initialization'))`;
      const disabled = await tx.creatorSearchPartition.updateMany({ where: { creatorSyncJobId: job.id, partitionType: { in: [...PRODUCTION_PARTITION_TYPES] }, gmvBucket: null,
        status: { in: ["QUEUED", "STARTING", "RUNNING", "WAITING_RETRY", "SATURATED", "PAUSED", "ERROR"] } },
        data: { status: "DISABLED_BY_STRATEGY" } });
      const generated = await this.ensureSpecificGmvPartitions(tx, job.id, catalog);
      if (disabled.count || generated.created || generated.skippedExisting) await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: job.id,
        stage: "GMV_STRATEGY_MIGRATED", safeMessage: `GMV-All disabled: ${disabled.count}; specific-GMV generated: ${generated.created}; exact combinations reused: ${generated.skippedExisting}`,
        occurredAt: new Date() } });
      await tx.creatorSyncJob.update({ where: { id: job.id }, data: { crawlerGeneration: V3_ADAPTIVE_GENERATION, state: "PAUSED", currentStage: "PAUSED",
        pauseRequested: false, nextAttemptAt: null,
        leaseId: null, leaseExpiresAt: null } });
      return generated;
    });
    return result.generated;
  }

  private async project(job: Awaited<ReturnType<CreatorDatabaseService["ensureJob"]>>) {
    const [storedCount, recentActivity, active, next, remaining, structuredCount, categoryCatalog, pendingPage] = await Promise.all([
      this.prisma.creator.count({ where: { creatorOpenId: { not: null }, snapshots: { some: { shopId: job.shopId } } } }),
      this.prisma.creatorSyncEvent.findMany({ where: { creatorSyncJobId: job.id }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 10,
        select: { stage: true, pageNumber: true, httpStatus: true, tiktokCode: true, googleApiCode: true, retryable: true, safeMessage: true, creatorsReturned: true,
          creatorsAdded: true, duplicates: true, nextAttemptAt: true, occurredAt: true, partitionKey: true, partitionLabel: true } }),
      job.currentPartitionId ? this.prisma.creatorSearchPartition.findUnique({ where: { id: job.currentPartitionId } }) : null,
      this.prisma.creatorSearchPartition.findFirst({ where: { creatorSyncJobId: job.id, partitionType: { in: [...PRODUCTION_PARTITION_TYPES] },
        gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES }, status: "QUEUED" },
        orderBy: [{ priorityScore: "desc" }, { queuePosition: "asc" }, { id: "asc" }] }),
      this.prisma.creatorSearchPartition.count({ where: { creatorSyncJobId: job.id, partitionType: { in: [...PRODUCTION_PARTITION_TYPES] },
        gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES }, status: { in: ["QUEUED", "STARTING", "RUNNING", "WAITING_RETRY", "SATURATED", "PAUSED"] } } }),
      this.prisma.creatorSearchPartition.count({ where: { creatorSyncJobId: job.id, partitionType: { in: [...PRODUCTION_PARTITION_TYPES] },
        gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES } } }),
      this.prisma.creatorMarketplaceCategory.aggregate({ where: { shopId: job.shopId }, _count: { _all: true }, _max: { fetchedAt: true } }),
      this.prisma.creatorSyncPage.findFirst({ where: { creatorSyncJobId: job.id, state: "RECEIVED",
        creatorSearchPartition: { partitionType: { in: [...PRODUCTION_PARTITION_TYPES] } } },
        orderBy: { receivedAt: "asc" }, select: { pageNumber: true, sheetsAttemptCount: true, nextSheetsAttemptAt: true,
          lastSheetsHttpStatus: true, lastSheetsApiCode: true, lastSheetsRetryable: true, lastSheetsError: true } })
    ]);
    const partition = active ?? next;
    const gmv = GMV_BUCKETS.find((bucket) => bucket.code === partition?.gmvBucket);
    return {
      status: job.pauseRequested && job.state === "RUNNING" ? "PAUSING" : (structuredCount > 0 && remaining === 0 && !partition ? "ALL_PARTITIONS_COMPLETE" : job.state),
      marketplaceRetryDelaySeconds: job.marketplaceRetryDelaySeconds,
      pagesCompleted: job.pagesCompleted, creatorsFetched: job.creatorsFetched, creatorsFetchedThisRun: job.creatorsFetchedThisRun,
      totalCreatorsStored: job.sheetImportedAt ? storedCount : Math.max(storedCount, job.creatorsFetched),
      startedAt: job.startedAt, lastPageAt: job.lastPageAt, lastSuccessAt: job.lastSuccessAt, lastError: job.lastError,
      nextAttemptAt: job.nextAttemptAt, currentStage: job.currentStage, lastAttemptAt: job.lastAttemptAt,
      lastResponseAt: job.lastResponseAt, lastAttemptPage: job.lastAttemptPage, lastHttpStatus: job.lastHttpStatus,
      lastTikTokCode: job.lastTikTokCode, lastSafeError: job.lastSafeError, lastCreatorsReturned: job.lastCreatorsReturned,
      lastCreatorsAdded: job.lastCreatorsAdded, lastDuplicates: job.lastDuplicates, recentActivity,
      currentPage: pendingPage?.pageNumber ?? (active?.pagesCompleted ?? 0) + 1, spreadsheetId: job.spreadsheetId,
      business16032001RetryCount: active?.business16032001RetryCount ?? 0,
      sheetsRetryCount: pendingPage?.sheetsAttemptCount ?? 0, sheetsRetryPage: pendingPage?.pageNumber ?? null,
      sheetsNextAttemptAt: pendingPage?.nextSheetsAttemptAt ?? null, sheetsHttpStatus: pendingPage?.lastSheetsHttpStatus ?? null,
      sheetsApiCode: pendingPage?.lastSheetsApiCode ?? null, sheetsRetryable: pendingPage?.lastSheetsRetryable ?? null,
      sheetsError: pendingPage?.lastSheetsError ?? null,
      databaseStillPopulating: ["RUNNING", "WAITING"].includes(job.state), partitionsRemaining: remaining,
      crawlerGeneration: job.crawlerGeneration, categoryMetadataReady: categoryCatalog._count._all > 0 && structuredCount > 0,
      categoryCatalog: { loaded: categoryCatalog._count._all > 0, count: categoryCatalog._count._all, lastRefreshedAt: categoryCatalog._max.fetchedAt },
      currentPartition: partition ? { key: partition.partitionKey, category: partition.categoryName, childCategory: partition.categoryChildName,
        followers: followerRangeLabel(partition.followersMin, partition.followersMax), gmv: gmv?.label ?? "All", page: partition.pagesCompleted + 1,
        status: partition.status, type: partition.partitionType === "V2_SEED" ? "Base" : "Adaptive", partitionType: partition.partitionType,
        depth: partition.adaptiveDepth, observedSaturated: partition.observedSaturationState === "OBSERVED_SATURATED",
        observedSaturationState: partition.observedSaturationState, branchClassification: partition.branchClassification,
        schedulerClass: partition.schedulerClass, priority: Number(partition.priorityScore), priorityReason: partition.priorityReason,
        marketplaceRequests: partition.marketplaceRequests,
        throttleAttempts: partition.throttleAttempts, rowsReturned: partition.rowsReturned,
        uniqueCreatorsAdded: partition.uniqueCreatorsAdded, duplicates: partition.duplicates,
        originalYield: partition.originalYield == null ? null : Number(partition.originalYield),
        incrementalYield: partition.incrementalYield == null ? null : Number(partition.incrementalYield),
        combinedChildIncrementalYield: partition.combinedChildIncrementalYield == null ? null : Number(partition.combinedChildIncrementalYield),
        newCreatorsPerRequest: partition.newCreatorsPerRequest == null ? null : Number(partition.newCreatorsPerRequest),
        duplicateRate: partition.duplicateRate == null ? null : Number(partition.duplicateRate) } : null
    };
  }

  async status() { return this.project(await this.ensureJob()); }

  async updateMarketplaceRetryDelay(value: unknown) {
    const seconds = parseMarketplaceRetryDelaySeconds(value);
    if (seconds == null || seconds < MIN_MARKETPLACE_RETRY_DELAY_SECONDS) {
      throw new BadRequestException("Marketplace retry delay must be an integer of at least 1 second");
    }
    const job = await this.ensureJob();
    const updated = await this.prisma.creatorSyncJob.update({ where: { id: job.id }, data: { marketplaceRetryDelaySeconds: seconds } });
    return this.project(updated);
  }

  async pause() {
    const job = await this.ensureJob(), now = new Date(), stage = job.leaseId ? "PAUSE_REQUESTED" : "PAUSED";
    const updated = await this.prisma.$transaction(async (tx) => {
      const value = await tx.creatorSyncJob.update({ where: { id: job.id }, data: job.leaseId
        ? { pauseRequested: true, currentStage: "PAUSING", nextAttemptAt: null }
        : { state: "PAUSED", currentStage: "PAUSED", pauseRequested: false, nextAttemptAt: null } });
      await tx.creatorSyncPage.updateMany({ where: { creatorSyncJobId: job.id, state: "RECEIVED" }, data: { nextSheetsAttemptAt: null } });
      if (!job.leaseId && job.currentPartitionId) await tx.creatorSearchPartition.updateMany({ where: { id: job.currentPartitionId, status: { in: ["STARTING", "RUNNING", "WAITING_RETRY", "ERROR"] } }, data: { status: "PAUSED" } });
      await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: job.id, creatorSearchPartitionId: job.currentPartitionId, stage, occurredAt: now } });
      return value;
    });
    return this.project(updated);
  }

  async resume() {
    const job = await this.ensureJob();
    const pendingPage = await this.prisma.creatorSyncPage.findFirst({ where: { creatorSyncJobId: job.id, state: "RECEIVED",
      creatorSearchPartition: { partitionType: { in: [...PRODUCTION_PARTITION_TYPES] } } }, select: { id: true } });
    const eligible = await this.prisma.creatorSearchPartition.count({ where: { creatorSyncJobId: job.id,
      partitionType: { in: [...PRODUCTION_PARTITION_TYPES] }, gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES },
      status: { in: ["QUEUED", "PAUSED", "STARTING", "RUNNING", "WAITING_RETRY"] } } });
    if (!eligible && !pendingPage) throw new BadRequestException("No structured Marketplace partitions are queued; refresh category metadata first");
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = job.currentPartitionId ? await tx.creatorSearchPartition.findUnique({ where: { id: job.currentPartitionId } }) : null;
      const releaseDisabledPointer = !pendingPage && current?.status === "DISABLED_BY_STRATEGY";
      if (job.currentPartitionId && !releaseDisabledPointer) await tx.creatorSearchPartition.updateMany({ where: { id: job.currentPartitionId, gmvBucket: { in: SPECIFIC_GMV_BUCKET_CODES }, status: { in: ["PAUSED", "ERROR"] } }, data: {
        status: "RUNNING",
        ...(job.currentStage === "TIKTOK_BUSINESS_RETRY_LIMIT" ? { business16032001RetryCount: 0, business16032001RetryPage: null } : {})
      } });
      if (pendingPage && job.currentStage === "SHEET_RETRY_LIMIT") await tx.creatorSyncPage.updateMany({ where: { id: pendingPage.id, state: "RECEIVED" }, data: {
        sheetsAttemptCount: 0, nextSheetsAttemptAt: null, lastSheetsHttpStatus: null, lastSheetsApiCode: null, lastSheetsRetryable: null, lastSheetsError: null
      } });
      if (releaseDisabledPointer) await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: job.id, creatorSearchPartitionId: current.id,
        partitionKey: current.partitionKey, partitionLabel: `${current.categoryName} / historical GMV-All`, stage: "GMV_ALL_DISABLED_BY_STRATEGY",
        safeMessage: "Historical GMV-All partition released from the active pointer; cursor and history preserved", occurredAt: new Date(now.getTime() - 1) } });
      const value = await tx.creatorSyncJob.update({ where: { id: job.id }, data: { state: "RUNNING",
        currentStage: pendingPage ? "RECONCILING_SHEET" : releaseDisabledPointer ? "CLAIMING_PARTITION" : job.currentPartitionId ? "RUNNING" : "CLAIMING_PARTITION",
        ...(releaseDisabledPointer ? { currentPartitionId: null, privateSearchKey: null, privateNextPageToken: null } : {}),
        pauseRequested: false, nextAttemptAt: null, lastError: null, lastSafeError: null, lastHttpStatus: null, lastTikTokCode: null,
        creatorsFetchedThisRun: 0, startedAt: now } });
      await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: job.id, creatorSearchPartitionId: job.currentPartitionId, stage: job.startedAt ? "SYNC_RESUMED" : "SYNC_STARTED", occurredAt: now } });
      return value;
    });
    return this.project(updated);
  }
}
