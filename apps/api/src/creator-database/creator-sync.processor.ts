import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Prisma } from "@affiliate/db";
import type { TikTokReadAdapter } from "@affiliate/contracts";
import type { CreatorCandidate } from "@affiliate/domain";
import { TikTokApiError } from "@affiliate/tiktok-adapter";
import { config, PrismaService } from "../shared";
import { TikTokIntegrationService } from "../integrations/tiktok.service";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";
import { GoogleSheetsCreatorGateway, type CreatorSheet } from "./creator-sheet.gateway";
import { CREATOR_MARKETPLACE_RETRY_MS } from "../integrations/tiktok-read-governor";

const LEASE_MS = 2 * 60_000;
type Options = { now?: () => Date; leaseMs?: number; random?: () => number };
type MarketplaceSearch = Pick<TikTokReadAdapter, "searchCreators">;
type Activity = {
  stage: string;
  pageNumber?: number;
  httpStatus?: number;
  tiktokCode?: string;
  safeMessage?: string;
  creatorsReturned?: number;
  creatorsAdded?: number;
  duplicates?: number;
  nextAttemptAt?: Date;
  occurredAt?: Date;
};

class CreatorSyncStageError extends Error {
  constructor(readonly stage: "CURSOR_ERROR", message: string) { super(message); }
}

@Injectable()
export class CreatorSyncProcessor {
  private readonly options: Options;
  constructor(
    private readonly prisma: PrismaService,
    private readonly tiktok: TikTokIntegrationService,
    private readonly identities: CreatorIdentityResolver,
    private readonly sheets: GoogleSheetsCreatorGateway,
    @Optional() @Inject("CREATOR_SYNC_PROCESSOR_OPTIONS") options?: Options
  ) { this.options = options ?? {}; }

  private now() { return this.options.now?.() ?? new Date(); }
  private log(event: string, fields: Record<string, unknown> = {}) {
    console.log(JSON.stringify({ level: "info", worker: "discovery-worker", event, ...fields }));
  }

  private safeTikTokMessage(error: TikTokApiError): string {
    if (error.providerCode === 36009002) return "Too many Marketplace requests";
    if (error.kind === "RATE_LIMIT") return "TikTok Marketplace rate limit";
    if (error.kind === "TEMPORARY") return "TikTok Marketplace is temporarily unavailable";
    if (error.kind === "AUTH_EXPIRED") return "TikTok authorization expired";
    if (error.kind === "PERMISSION") return "TikTok permission denied";
    if (error.kind === "INVALID_SHOP_CIPHER") return "TikTok shop selection is invalid";
    if (error.kind === "MALFORMED_RESPONSE") return "TikTok returned an invalid response";
    return "TikTok Marketplace request failed";
  }

  private async recordActivity(
    jobId: string,
    leaseId: string,
    activity: Activity,
    jobData: Prisma.CreatorSyncJobUpdateManyMutationInput = {}
  ) {
    const occurredAt = activity.occurredAt ?? this.now();
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.creatorSyncJob.updateMany({
        where: { id: jobId, leaseId },
        data: { currentStage: activity.stage, ...jobData }
      });
      if (updated.count !== 1) throw new Error("Creator sync lease changed before activity was recorded");
      await tx.creatorSyncEvent.create({ data: {
        creatorSyncJobId: jobId,
        stage: activity.stage,
        pageNumber: activity.pageNumber,
        httpStatus: activity.httpStatus,
        tiktokCode: activity.tiktokCode,
        safeMessage: activity.safeMessage,
        creatorsReturned: activity.creatorsReturned,
        creatorsAdded: activity.creatorsAdded,
        duplicates: activity.duplicates,
        nextAttemptAt: activity.nextAttemptAt,
        occurredAt
      } });
    });
  }

  async processNext(adapterOverride?: MarketplaceSearch, sheetOverride?: CreatorSheet): Promise<boolean> {
    const now = this.now();
    const candidate = await this.prisma.creatorSyncJob.findFirst({ where: {
      state: { in: ["RUNNING", "WAITING"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      AND: [{ OR: [{ leaseId: null }, { leaseExpiresAt: { lte: now } }] }]
    }, orderBy: { updatedAt: "asc" } });
    if (!candidate) return false;
    const leaseId = randomBytes(18).toString("base64url");
    const claimed = await this.prisma.creatorSyncJob.updateMany({ where: {
      id: candidate.id, state: { in: ["RUNNING", "WAITING"] },
      OR: [{ leaseId: null }, { leaseExpiresAt: { lte: now } }]
    }, data: { state: "RUNNING", currentStage: "RUNNING", leaseId, leaseExpiresAt: new Date(now.getTime() + (this.options.leaseMs ?? LEASE_MS)), nextAttemptAt: null } });
    if (claimed.count !== 1) return true;
    try { await this.processClaimed(candidate.id, leaseId, adapterOverride, sheetOverride ?? this.sheets); }
    catch (error) { await this.handleError(candidate.id, leaseId, error); }
    return true;
  }

  private async processClaimed(jobId: string, leaseId: string, adapterOverride: MarketplaceSearch | undefined, sheets: CreatorSheet) {
    let job = await this.prisma.creatorSyncJob.findFirstOrThrow({ where: { id: jobId, leaseId } });
    const pending = await this.prisma.creatorSyncPage.findFirst({ where: { creatorSyncJobId: jobId, state: "RECEIVED" }, orderBy: { pageNumber: "asc" } });
    if (pending) return this.commitPage(jobId, leaseId, pending.id, sheets);

    if (!job.sheetImportedAt) {
      const existing = await sheets.readCreators(job.spreadsheetId);
      await this.persistCreators(existing, job.shopId, `sheet-import:${job.id}`);
      await this.prisma.creatorSyncJob.updateMany({ where: { id: jobId, leaseId }, data: { sheetImportedAt: this.now() } });
      job = await this.prisma.creatorSyncJob.findFirstOrThrow({ where: { id: jobId, leaseId } });
    }
    if (job.pauseRequested) {
      const pausedAt = this.now();
      await this.prisma.$transaction([
        this.prisma.creatorSyncJob.update({ where: { id: jobId }, data: { state: "PAUSED", currentStage: "PAUSED", pauseRequested: false, leaseId: null, leaseExpiresAt: null } }),
        this.prisma.creatorSyncEvent.create({ data: { creatorSyncJobId: jobId, stage: "PAUSED", pageNumber: job.pagesCompleted + 1, occurredAt: pausedAt } })
      ]);
      this.log("creator_sync_paused", { pagesCompleted: job.pagesCompleted });
      return;
    }
    if (!job.privateNextPageToken || !job.privateSearchKey) throw new Error("Stored continuation cursor is incomplete; page-one search was not attempted");

    const adapter = adapterOverride ?? await this.tiktok.discoveryAdapter();
    const pageNumber = job.pagesCompleted + 1;
    const attemptedAt = this.now();
    await this.recordActivity(jobId, leaseId, { stage: "REQUESTING_TIKTOK", pageNumber, occurredAt: attemptedAt }, {
      lastAttemptAt: attemptedAt,
      lastAttemptPage: pageNumber,
      lastHttpStatus: null,
      lastTikTokCode: null,
      lastSafeError: null
    });
    this.log("creator_page_requested", { page: pageNumber });
    const started = Date.now();
    const page = await adapter.searchCreators({}, { pageSize: 20, pageToken: job.privateNextPageToken, searchKey: job.privateSearchKey });
    const respondedAt = this.now();
    await this.recordActivity(jobId, leaseId, {
      stage: "TIKTOK_SUCCESS", pageNumber, httpStatus: 200,
      creatorsReturned: page.creators.length, occurredAt: respondedAt
    }, {
      lastResponseAt: respondedAt,
      lastHttpStatus: 200,
      lastTikTokCode: "0",
      lastSafeError: null,
      lastCreatorsReturned: page.creators.length
    });
    if (page.hasMore && !page.nextPageToken) throw new CreatorSyncStageError("CURSOR_ERROR", "TikTok continuation response had has_more without a next page token");
    if (page.nextPageToken === job.privateNextPageToken) throw new CreatorSyncStageError("CURSOR_ERROR", "TikTok continuation response repeated the current page token");
    const searchKey = page.searchKey || job.privateSearchKey;
    if (!searchKey) throw new CreatorSyncStageError("CURSOR_ERROR", "TikTok continuation response omitted the search key");
    this.log("creator_page_received", { page: pageNumber, creatorsReturned: page.creators.length, durationMs: Date.now() - started });
    await this.recordActivity(jobId, leaseId, { stage: "SAVING_DATABASE", pageNumber, creatorsReturned: page.creators.length });
    const staged = await this.prisma.creatorSyncPage.upsert({
      where: { creatorSyncJobId_privateRequestToken: { creatorSyncJobId: jobId, privateRequestToken: job.privateNextPageToken } },
      update: {}, create: {
        creatorSyncJobId: jobId, pageNumber, privateRequestToken: job.privateNextPageToken,
        privateNextToken: page.nextPageToken, privateSearchKey: searchKey,
        providerHasMore: page.hasMore, creatorsReturned: page.creators.length,
        payload: page.creators as unknown as Prisma.InputJsonValue
      }
    });
    return this.commitPage(jobId, leaseId, staged.id, sheets);
  }

  private async persistCreators(creators: CreatorCandidate[], shopId: string, sourcePageKey: string) {
    for (const creator of creators) {
      const stored = await this.identities.ensureMarketplaceCreator(creator);
      await this.prisma.creatorMetricSnapshot.upsert({
        where: { creatorId_sourcePageKey: { creatorId: stored.id, sourcePageKey: `${sourcePageKey}:${creator.creatorOpenId}` } },
        update: {
          shopId, followerCount: creator.followerCount, categoryIds: creator.categoryIds,
          gmvAmount: creator.gmv ? new Prisma.Decimal(creator.gmv.amount) : null, gmvCurrency: creator.gmv?.currency,
          unitsSold: creator.unitsSold, avgVideoViews: creator.avgVideoViews, avgLiveViewers: creator.avgLiveViewers,
          engagementRate: creator.engagementRate == null ? null : new Prisma.Decimal(creator.engagementRate),
          metrics: { liveGmv: creator.liveGmv, videoGmv: creator.videoGmv, gmvRange: creator.gmvRange,
            topAgeRanges: creator.topAgeRanges, majorGender: creator.majorGender, majorGenderPercentage: creator.majorGenderPercentage } as Prisma.InputJsonValue,
          rawPayload: creator as unknown as Prisma.InputJsonValue, sourceFetchedAt: this.now()
        },
        create: {
          creatorId: stored.id, shopId, sourcePageKey: `${sourcePageKey}:${creator.creatorOpenId}`,
          followerCount: creator.followerCount, categoryIds: creator.categoryIds,
          gmvAmount: creator.gmv ? new Prisma.Decimal(creator.gmv.amount) : null, gmvCurrency: creator.gmv?.currency,
          unitsSold: creator.unitsSold, avgVideoViews: creator.avgVideoViews, avgLiveViewers: creator.avgLiveViewers,
          engagementRate: creator.engagementRate == null ? null : new Prisma.Decimal(creator.engagementRate),
          metrics: { liveGmv: creator.liveGmv, videoGmv: creator.videoGmv, gmvRange: creator.gmvRange,
            topAgeRanges: creator.topAgeRanges, majorGender: creator.majorGender, majorGenderPercentage: creator.majorGenderPercentage } as Prisma.InputJsonValue,
          rawPayload: creator as unknown as Prisma.InputJsonValue, sourceFetchedAt: this.now()
        }
      });
    }
  }

  private async commitPage(jobId: string, leaseId: string, pageId: string, sheets: CreatorSheet) {
    const page = await this.prisma.creatorSyncPage.findFirstOrThrow({ where: { id: pageId, creatorSyncJobId: jobId, state: "RECEIVED" } });
    const job = await this.prisma.creatorSyncJob.findFirstOrThrow({ where: { id: jobId, leaseId } });
    const creators = page.payload as unknown as CreatorCandidate[];
    const creatorOpenIds = [...new Set(creators.map((creator) => creator.creatorOpenId))];
    if (job.currentStage !== "SAVING_DATABASE") {
      await this.recordActivity(jobId, leaseId, { stage: "SAVING_DATABASE", pageNumber: page.pageNumber, creatorsReturned: creators.length });
    }
    const storedBefore = creatorOpenIds.length ? await this.prisma.creator.count({ where: {
      creatorOpenId: { in: creatorOpenIds }, snapshots: { some: { shopId: job.shopId } }
    } }) : 0;
    await this.persistCreators(creators, job.shopId, `creator-sync-page:${page.id}`);
    const storedAfter = creatorOpenIds.length ? await this.prisma.creator.count({ where: {
      creatorOpenId: { in: creatorOpenIds }, snapshots: { some: { shopId: job.shopId } }
    } }) : 0;
    const creatorsAdded = Math.min(creators.length, Math.max(0, storedAfter - storedBefore));
    const duplicates = Math.max(0, creators.length - creatorsAdded);
    await this.recordActivity(jobId, leaseId, {
      stage: "SAVING_SHEET", pageNumber: page.pageNumber,
      creatorsReturned: creators.length, creatorsAdded, duplicates
    });
    await sheets.reconcilePage(job.spreadsheetId, creators);
    const totalCreatorsStored = await this.prisma.creator.count({ where: { creatorOpenId: { not: null }, snapshots: { some: { shopId: job.shopId } } } });
    const now = this.now();
    await this.recordActivity(jobId, leaseId, {
      stage: "COMMITTING_PAGE", pageNumber: page.pageNumber,
      creatorsReturned: creators.length, creatorsAdded, duplicates, occurredAt: now
    });
    const committedState: { value: "EXHAUSTED" | "PAUSED" | "RUNNING" } = { value: !page.providerHasMore ? "EXHAUSTED" : "RUNNING" };
    await this.prisma.$transaction(async (tx) => {
      const common = {
        privateNextPageToken: page.privateNextToken,
        privateSearchKey: page.privateSearchKey, pagesCompleted: { increment: 1 },
        creatorsFetched: { increment: page.creatorsReturned }, creatorsFetchedThisRun: { increment: page.creatorsReturned },
        pauseRequested: false, lastPageAt: now, lastSuccessAt: now, lastError: null, lastProviderCode: "0",
        lastSafeError: null, lastCreatorsReturned: creators.length, lastCreatorsAdded: creatorsAdded, lastDuplicates: duplicates,
        leaseId: null, leaseExpiresAt: null
      } as const;
      let advanced;
      if (!page.providerHasMore) {
        advanced = await tx.creatorSyncJob.updateMany({ where: { id: jobId, leaseId, privateNextPageToken: page.privateRequestToken },
          data: { ...common, state: "EXHAUSTED", currentStage: "EXHAUSTED", nextAttemptAt: null } });
      } else {
        advanced = await tx.creatorSyncJob.updateMany({ where: { id: jobId, leaseId, privateNextPageToken: page.privateRequestToken, pauseRequested: true },
          data: { ...common, state: "PAUSED", currentStage: "PAUSED", nextAttemptAt: null } });
        if (advanced.count) committedState.value = "PAUSED";
        else advanced = await tx.creatorSyncJob.updateMany({ where: { id: jobId, leaseId, privateNextPageToken: page.privateRequestToken, pauseRequested: false },
          data: { ...common, state: "RUNNING", currentStage: "PAGE_COMMITTED", nextAttemptAt: new Date(now.getTime() + config.MARKETPLACE_SUCCESS_SPACING_MS) } });
      }
      if (advanced.count !== 1) throw new Error("Creator cursor changed before page commit");
      await tx.creatorSyncPage.update({ where: { id: page.id }, data: { state: "COMMITTED", committedAt: now } });
      await tx.creatorSyncEvent.create({ data: {
        creatorSyncJobId: jobId, stage: "PAGE_COMMITTED", pageNumber: page.pageNumber,
        creatorsReturned: creators.length, creatorsAdded, duplicates, occurredAt: now
      } });
      if (page.providerHasMore) await tx.creatorSyncEvent.create({ data: {
        creatorSyncJobId: jobId, stage: "CURSOR_ADVANCED", pageNumber: page.pageNumber + 1,
        safeMessage: `Cursor advanced to page ${page.pageNumber + 1}`, occurredAt: new Date(now.getTime() + 1)
      } });
      if (committedState.value === "PAUSED") await tx.creatorSyncEvent.create({ data: {
        creatorSyncJobId: jobId, stage: "PAUSED", pageNumber: page.pageNumber + 1, occurredAt: new Date(now.getTime() + 2)
      } });
    });
    this.log("creator_page_saved", { page: page.pageNumber, creatorsReturned: creators.length, creatorsAdded, duplicates, totalCreatorsStored });
    this.log("creator_cursor_updated", { page: page.pageNumber, hasMore: page.providerHasMore });
    if (committedState.value === "PAUSED") this.log("creator_sync_paused", { pagesCompleted: page.pageNumber });
    if (committedState.value === "EXHAUSTED") this.log("creator_sync_exhausted", { pagesCompleted: page.pageNumber, totalCreatorsStored });
  }

  private async handleError(jobId: string, leaseId: string, error: unknown) {
    const job = await this.prisma.creatorSyncJob.findFirst({ where: { id: jobId, leaseId } });
    if (!job) return;
    const now = this.now();
    if (error instanceof TikTokApiError && ["RATE_LIMIT", "TEMPORARY"].includes(error.kind)) {
      const retryDelayMs = Math.max(CREATOR_MARKETPLACE_RETRY_MS, error.retryAfterMs ?? 0);
      const localRetryAt = new Date(now.getTime() + retryDelayMs);
      const nextAttemptAt = error.nextPermittedAt && error.nextPermittedAt > localRetryAt
        ? error.nextPermittedAt
        : localRetryAt;
      const tiktokCode = error.providerCode ? String(error.providerCode) : undefined;
      const safeMessage = this.safeTikTokMessage(error);
      const eventStage = error.kind === "RATE_LIMIT" ? "TIKTOK_THROTTLED" : "TIKTOK_ERROR";
      if (job.pauseRequested) {
        await this.prisma.$transaction([
          this.prisma.creatorSyncJob.update({ where: { id: jobId }, data: {
            state: "PAUSED", currentStage: "PAUSED", pauseRequested: false, nextAttemptAt: null,
            lastProviderCode: tiktokCode ?? error.kind, lastError: safeMessage,
            lastResponseAt: error.httpStatus == null ? job.lastResponseAt : now,
            lastHttpStatus: error.httpStatus, lastTikTokCode: tiktokCode, lastSafeError: safeMessage,
            leaseId: null, leaseExpiresAt: null
          } }),
          this.prisma.creatorSyncEvent.create({ data: {
            creatorSyncJobId: jobId, stage: eventStage, pageNumber: job.pagesCompleted + 1,
            httpStatus: error.httpStatus, tiktokCode, safeMessage, occurredAt: now
          } }),
          this.prisma.creatorSyncEvent.create({ data: {
            creatorSyncJobId: jobId, stage: "PAUSED", pageNumber: job.pagesCompleted + 1,
            occurredAt: new Date(now.getTime() + 1)
          } })
        ]);
        this.log("creator_sync_paused", { pagesCompleted: job.pagesCompleted });
        return;
      }
      await this.prisma.$transaction([
        this.prisma.creatorSyncJob.update({ where: { id: jobId }, data: {
          state: "WAITING", currentStage: "WAITING_RETRY", nextAttemptAt,
          lastProviderCode: tiktokCode ?? error.kind,
          lastError: safeMessage,
          lastResponseAt: error.httpStatus == null ? job.lastResponseAt : now,
          lastHttpStatus: error.httpStatus,
          lastTikTokCode: tiktokCode,
          lastSafeError: safeMessage,
          leaseId: null, leaseExpiresAt: null
        } }),
        this.prisma.creatorSyncEvent.create({ data: {
          creatorSyncJobId: jobId, stage: eventStage, pageNumber: job.pagesCompleted + 1,
          httpStatus: error.httpStatus, tiktokCode, safeMessage, nextAttemptAt, occurredAt: now
        } })
      ]);
      this.log("creator_sync_waiting", {
        page: job.pagesCompleted + 1,
        providerCode: error.providerCode ?? error.kind,
        nextAttemptAt,
        retryIntervalMs: retryDelayMs,
        mandatoryRetryAfterMs: error.retryAfterMs && error.retryAfterMs > CREATOR_MARKETPLACE_RETRY_MS ? error.retryAfterMs : undefined
      });
      return;
    }
    const stage = error instanceof TikTokApiError ? "TIKTOK_ERROR"
      : error instanceof CreatorSyncStageError ? error.stage
      : job.currentStage === "SAVING_DATABASE" ? "DATABASE_ERROR"
      : job.currentStage === "SAVING_SHEET" ? "SHEET_ERROR"
      : job.currentStage === "COMMITTING_PAGE" ? "CURSOR_ERROR"
      : "SYNC_ERROR";
    const safe = error instanceof TikTokApiError ? this.safeTikTokMessage(error)
      : stage === "DATABASE_ERROR" ? "PostgreSQL save failed; the page was not committed"
      : stage === "SHEET_ERROR" ? "Google Sheets save failed; the page was not committed"
      : stage === "CURSOR_ERROR" ? "Page commit failed; the cursor was not advanced"
      : "Creator synchronization failed before the page was committed";
    const tiktokCode = error instanceof TikTokApiError && error.providerCode ? String(error.providerCode) : undefined;
    await this.prisma.$transaction([
      this.prisma.creatorSyncJob.update({ where: { id: jobId }, data: {
        state: "ERROR", currentStage: stage, lastError: safe, lastSafeError: safe,
        lastProviderCode: tiktokCode ?? (error instanceof TikTokApiError ? error.kind : null),
        lastResponseAt: error instanceof TikTokApiError && error.httpStatus != null ? now : job.lastResponseAt,
        lastHttpStatus: error instanceof TikTokApiError ? error.httpStatus : job.lastHttpStatus,
        lastTikTokCode: tiktokCode,
        nextAttemptAt: null, leaseId: null, leaseExpiresAt: null
      } }),
      this.prisma.creatorSyncEvent.create({ data: {
        creatorSyncJobId: jobId, stage, pageNumber: job.pagesCompleted + 1,
        httpStatus: error instanceof TikTokApiError ? error.httpStatus : undefined,
        tiktokCode, safeMessage: safe, occurredAt: now
      } })
    ]);
    this.log("creator_sync_error", { page: job.pagesCompleted + 1, providerCode: error instanceof TikTokApiError ? error.providerCode : undefined, category: error instanceof TikTokApiError ? error.kind : "LOCAL_COMMIT" });
  }
}
