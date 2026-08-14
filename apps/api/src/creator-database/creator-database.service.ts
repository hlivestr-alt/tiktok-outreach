import { BadRequestException, Injectable } from "@nestjs/common";
import { config, PrismaService } from "../shared";
import { TikTokIntegrationService } from "../integrations/tiktok.service";

@Injectable()
export class CreatorDatabaseService {
  constructor(private readonly prisma: PrismaService, private readonly tiktok: TikTokIntegrationService) {}

  async ensureJob() {
    const shop = await this.tiktok.activeShop();
    return this.prisma.creatorSyncJob.upsert({
      where: { shopId: shop.id }, update: {}, create: {
        shopId: shop.id, state: "PAUSED",
        privateNextPageToken: config.CREATOR_SYNC_INITIAL_PAGE_TOKEN,
        privateSearchKey: config.CREATOR_SYNC_INITIAL_SEARCH_KEY,
        pagesCompleted: config.CREATOR_SYNC_INITIAL_PAGES,
        creatorsFetched: config.CREATOR_SYNC_INITIAL_CREATORS,
        spreadsheetId: config.CREATOR_SYNC_SPREADSHEET_ID
      }
    });
  }

  private async project(job: Awaited<ReturnType<CreatorDatabaseService["ensureJob"]>>) {
    const [storedCount, recentActivity] = await Promise.all([
      this.prisma.creator.count({ where: { creatorOpenId: { not: null }, snapshots: { some: { shopId: job.shopId } } } }),
      this.prisma.creatorSyncEvent.findMany({
        where: { creatorSyncJobId: job.id }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 10,
        select: {
          stage: true, pageNumber: true, httpStatus: true, tiktokCode: true, safeMessage: true,
          creatorsReturned: true, creatorsAdded: true, duplicates: true, nextAttemptAt: true, occurredAt: true
        }
      })
    ]);
    const totalCreatorsStored = job.sheetImportedAt ? storedCount : Math.max(storedCount, job.creatorsFetched);
    return {
      status: job.pauseRequested && job.state === "RUNNING" ? "PAUSING" : job.state,
      pagesCompleted: job.pagesCompleted,
      creatorsFetched: job.creatorsFetched,
      creatorsFetchedThisRun: job.creatorsFetchedThisRun,
      totalCreatorsStored,
      startedAt: job.startedAt, lastPageAt: job.lastPageAt, lastSuccessAt: job.lastSuccessAt,
      lastError: job.lastError, nextAttemptAt: job.nextAttemptAt,
      currentStage: job.currentStage,
      lastAttemptAt: job.lastAttemptAt,
      lastResponseAt: job.lastResponseAt,
      lastAttemptPage: job.lastAttemptPage,
      lastHttpStatus: job.lastHttpStatus,
      lastTikTokCode: job.lastTikTokCode,
      lastSafeError: job.lastSafeError,
      lastCreatorsReturned: job.lastCreatorsReturned,
      lastCreatorsAdded: job.lastCreatorsAdded,
      lastDuplicates: job.lastDuplicates,
      recentActivity,
      currentPage: job.pagesCompleted + 1, spreadsheetId: job.spreadsheetId,
      databaseStillPopulating: ["RUNNING", "WAITING"].includes(job.state)
    };
  }

  async status() { return this.project(await this.ensureJob()); }

  async pause() {
    const job = await this.ensureJob();
    if (["EXHAUSTED", "ERROR"].includes(job.state)) return this.project(job);
    const now = new Date();
    const stage = job.leaseId ? "PAUSE_REQUESTED" : "PAUSED";
    const updated = await this.prisma.$transaction(async (tx) => {
      const value = await tx.creatorSyncJob.update({ where: { id: job.id }, data: job.leaseId
        ? { pauseRequested: true, currentStage: "PAUSING" }
        : { state: "PAUSED", currentStage: "PAUSED", pauseRequested: false, nextAttemptAt: null }
      });
      await tx.creatorSyncEvent.create({ data: { creatorSyncJobId: job.id, stage, pageNumber: job.pagesCompleted + 1, occurredAt: now } });
      return value;
    });
    console.log(JSON.stringify({ level: "info", event: "creator_sync_paused", pagesCompleted: updated.pagesCompleted }));
    return this.project(updated);
  }

  async resume() {
    const job = await this.ensureJob();
    if (job.state === "EXHAUSTED") throw new BadRequestException("Current pagination sequence is exhausted; Resume cannot start a new search");
    if (!job.privateNextPageToken || !job.privateSearchKey) throw new BadRequestException("Stored continuation cursor is incomplete; a fresh search was not started");
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const value = await tx.creatorSyncJob.update({ where: { id: job.id }, data: {
        state: "RUNNING", currentStage: "RUNNING", pauseRequested: false, nextAttemptAt: null, lastError: null,
        creatorsFetchedThisRun: 0, startedAt: now
      } });
      await tx.creatorSyncEvent.create({ data: {
        creatorSyncJobId: job.id, stage: job.startedAt ? "SYNC_RESUMED" : "SYNC_STARTED",
        pageNumber: job.pagesCompleted + 1, occurredAt: now
      } });
      return value;
    });
    console.log(JSON.stringify({ level: "info", event: job.startedAt ? "creator_sync_resumed" : "creator_sync_started", page: updated.pagesCompleted + 1 }));
    return this.project(updated);
  }
}
