import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@affiliate/db";
import type { CreatorCandidate } from "@affiliate/domain";
import { TikTokApiError } from "@affiliate/tiktok-adapter";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";
import { CreatorDatabaseService } from "../creator-database/creator-database.service";
import { CreatorSyncProcessor } from "../creator-database/creator-sync.processor";
import { GoogleSheetsError } from "../creator-database/creator-sheet.gateway";
import { OutreachService } from "./outreach.service";

const prisma = new PrismaClient();
const shopIds = new Set<string>();
const stamp = () => `creator_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const creatorRunId = stamp();

function creator(id: string, followers = 1_200): CreatorCandidate {
  return { creatorOpenId: `open_${creatorRunId}_${id}`, creatorUserId: `user_${creatorRunId}_${id}`, username: `creator_${id}`, nickname: `Creator ${id}`,
    categoryIds: ["beauty"], followerCount: followers, gmv: { amount: "100", currency: "USD" }, unitsSold: 5,
    avgVideoViews: 1_000, avgLiveViewers: 50, engagementRate: 0.1, selectionRegion: "ID", discoveryOrdinal: 0 };
}

async function fixture(state: "RUNNING" | "PAUSED" = "RUNNING", options: { creatorsFetched?: number } = {}) {
  const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK" } }); shopIds.add(shop.id);
  const job = await prisma.creatorSyncJob.create({ data: {
    shopId: shop.id, state, privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10,
    creatorsFetched: options.creatorsFetched ?? 200, creatorsFetchedThisRun: 0, spreadsheetId: "sheet-test", sheetImportedAt: new Date(), crawlerGeneration: 3
  } });
  const partition = await prisma.creatorSearchPartition.create({ data: {
    creatorSyncJobId: job.id, partitionKey: "v2:600001:600001-child:f1000-1499:g1", generation: 3, partitionType: "V2_SEED", categoryId: "600001", categoryName: "Beauty",
    categoryChildId: "600001-child", categoryChildName: "Skin Care", categoryChildIds: ["600001-child"], followerBucket: "F03", followersMin: 1_000, followersMax: 1_499, status: state === "PAUSED" ? "PAUSED" : "RUNNING",
    gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100", queuePosition: 0n, privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10
  } });
  await prisma.creatorMarketplaceCategory.create({ data: { shopId: shop.id, categoryId: "600001", categoryName: "Beauty",
    parentCategoryId: null, level: 1, enabledForCreatorCrawl: true, sortOrder: 0, isLeaf: false, fetchedAt: new Date() } });
  await prisma.creatorMarketplaceCategory.create({ data: { shopId: shop.id, categoryId: "600001-child", categoryName: "Skin Care",
    parentCategoryId: "600001", level: 2, enabledForCreatorCrawl: false, availableForCreatorFilter: true, sortOrder: 1, isLeaf: false, fetchedAt: new Date() } });
  await prisma.creatorSyncJob.update({ where: { id: job.id }, data: { currentPartitionId: partition.id } });
  const tiktok = { activeShop: async () => shop };
  const identities = new CreatorIdentityResolver(prisma as any);
  const processor = new CreatorSyncProcessor(prisma as any, {} as any, identities, {} as any, { now: () => new Date("2026-08-14T06:00:00Z"), random: () => 0 });
  const service = new CreatorDatabaseService(prisma as any, tiktok as any);
  const sheet = { readCreators: vi.fn(async () => []), reconcilePage: vi.fn(async () => undefined) };
  return { shop, job, processor, service, sheet };
}

afterEach(async () => {
  for (const id of shopIds) await prisma.shop.delete({ where: { id } }).catch(() => undefined);
  shopIds.clear();
  await prisma.creator.deleteMany({ where: { creatorOpenId: { startsWith: `open_${creatorRunId}_` } } });
});
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential("creator database continuation sync", () => {
  it("Resume uses the exact persisted cursor and advances only after the page is saved", async () => {
    const seed = await fixture("PAUSED"); await seed.service.resume();
    const adapter = { searchCreators: vi.fn(async (filters, cursor) => {
      expect(filters).toMatchObject({ marketplaceCategory: { parentCategoryId: "600001", childCategoryIds: ["600001-child"] },
        minFollowers: 1_000, maxFollowers: 1_499, marketplaceGmvRanges: ["GMV_RANGE_0_100"] });
      expect(cursor).toEqual({ pageSize: 20, pageToken: "token200", searchKey: "abc" });
      return { creators: [creator("220")], searchKey: "abc-next-ignored", nextPageToken: "token220", hasMore: true };
    }) };
    await seed.processor.processNext(adapter, seed.sheet);
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "RUNNING", currentStage: "PAGE_COMMITTED", privateNextPageToken: "token220", privateSearchKey: "abc",
      pagesCompleted: 11, creatorsFetched: 201, lastCreatorsReturned: 1, lastCreatorsAdded: 1, lastDuplicates: 0
    });
    expect(seed.sheet.reconcilePage).toHaveBeenCalledTimes(1);
    expect((await prisma.creatorSyncEvent.findMany({ where: { creatorSyncJobId: seed.job.id }, orderBy: { occurredAt: "asc" } })).map((event) => event.stage))
      .toEqual(expect.arrayContaining(["REQUESTING_TIKTOK", "TIKTOK_SUCCESS", "SAVING_DATABASE", "SAVING_SHEET", "COMMITTING_PAGE", "PAGE_COMMITTED", "CURSOR_ADVANCED"]));
  });

  it("a failed request preserves the previous cursor", async () => {
    const seed = await fixture();
    await seed.processor.processNext({ searchCreators: vi.fn(async () => { throw new TikTokApiError("PERMISSION", "SEARCH_CREATORS", 403, 105005, "r", "denied"); }) }, seed.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "ERROR", currentStage: "TIKTOK_ERROR", privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10,
      lastHttpStatus: 403, lastTikTokCode: "105005", lastAttemptPage: 11
    });
  });

  it("rejects an empty category-child snapshot locally without calling TikTok", async () => {
    const seed = await fixture();
    const partition = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: partition.id }, data: { categoryChildIds: [] } });
    const adapter = { searchCreators: vi.fn() };
    await seed.processor.processNext(adapter, seed.sheet);
    expect(adapter.searchCreators).not.toHaveBeenCalled();
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "ERROR", currentStage: "PARTITION_CONFIG_ERROR", privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10,
      lastSafeError: "V2 Marketplace partition must contain exactly one immediate child category"
    });
  });

  it("Pause lets an in-flight page commit and prevents the following request", async () => {
    const seed = await fixture();
    let release!: (value: { creators: CreatorCandidate[]; searchKey: string; nextPageToken: string; hasMore: boolean }) => void;
    let requested!: () => void;
    const started = new Promise<void>((resolve) => { requested = resolve; });
    const response = new Promise<{ creators: CreatorCandidate[]; searchKey: string; nextPageToken: string; hasMore: boolean }>((resolve) => { release = resolve; });
    const adapter = { searchCreators: vi.fn(async () => { requested(); return response; }) };
    const work = seed.processor.processNext(adapter, seed.sheet); await started; await seed.service.pause();
    release({ creators: [creator("pause")], searchKey: "abc", nextPageToken: "token220", hasMore: true });
    await work;
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({ state: "PAUSED", privateNextPageToken: "token220", pagesCompleted: 11 });
    expect(await seed.processor.processNext(adapter, seed.sheet)).toBe(false);
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
  });

  it("restart leaves PAUSED idle and RUNNING resumes from persisted state", async () => {
    const seed = await fixture("PAUSED"); const adapter = { searchCreators: vi.fn(async () => ({ creators: [], searchKey: "abc", hasMore: false })) };
    const restarted = new CreatorSyncProcessor(prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any);
    expect(await restarted.processNext(adapter, seed.sheet)).toBe(false); expect(adapter.searchCreators).not.toHaveBeenCalled();
    await seed.service.resume(); await restarted.processNext(adapter, seed.sheet);
    expect(adapter.searchCreators).toHaveBeenCalledWith(expect.objectContaining({ minFollowers: 1_000, maxFollowers: 1_499,
      marketplaceCategory: { parentCategoryId: "600001", childCategoryIds: ["600001-child"] } }),
      { pageSize: 20, pageToken: "token200", searchKey: "abc" });
  });

  it("has no total creator cap and marks genuine pagination exhaustion without a page-one search", async () => {
    const growing = await fixture("RUNNING", { creatorsFetched: 50_000 });
    const more = { searchCreators: vi.fn(async () => ({ creators: [creator("50001")], searchKey: "abc", nextPageToken: "token220", hasMore: true })) };
    await growing.processor.processNext(more, growing.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: growing.job.id } })).toMatchObject({ state: "RUNNING", creatorsFetched: 50_001, privateNextPageToken: "token220" });

    const exhausted = await fixture();
    const last = { searchCreators: vi.fn(async (_filters, cursor) => {
      expect(cursor.pageToken).toBe("token200"); return { creators: [], searchKey: "abc", hasMore: false };
    }) };
    await exhausted.processor.processNext(last, exhausted.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: exhausted.job.id } })).toMatchObject({ state: "EXHAUSTED", pagesCompleted: 11 });
    expect(last.searchCreators).toHaveBeenCalledTimes(1);
  });

  it("36009002 throttling retries in 3 seconds with the same cursor", async () => {
    const seed = await fixture(); const due = new Date("2026-08-14T06:00:03Z");
    await seed.processor.processNext({ searchCreators: vi.fn(async () => { throw new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", 429, 36009002, "r", "throttled", undefined, due); }) }, seed.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "WAITING", currentStage: "WAITING_RETRY", privateNextPageToken: "token200", privateSearchKey: "abc",
      pagesCompleted: 10, nextAttemptAt: due, lastHttpStatus: 429, lastTikTokCode: "36009002", lastAttemptPage: 11
    });
    const publicStatus = await seed.service.status();
    expect(publicStatus).toMatchObject({ currentStage: "WAITING_RETRY", lastHttpStatus: 429, lastTikTokCode: "36009002" });
    expect(publicStatus.recentActivity.find((event) => event.stage === "TIKTOK_THROTTLED")).toMatchObject({
      stage: "TIKTOK_THROTTLED",
      pageNumber: 11,
      tiktokCode: "36009002"
    });
    expect(JSON.stringify(publicStatus)).not.toContain("token200");
    expect(JSON.stringify(publicStatus)).not.toContain("\"abc\"");
    const retry = { searchCreators: vi.fn(async (_filters, cursor) => {
      expect(cursor).toEqual({ pageSize: 20, pageToken: "token200", searchKey: "abc" });
      return { creators: [], searchKey: "abc", hasMore: false };
    }) };
    const dueProcessor = new CreatorSyncProcessor(
      prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any,
      { now: () => due, random: () => 0 }
    );
    await dueProcessor.processNext(retry, seed.sheet);
    expect(retry.searchCreators).toHaveBeenCalledTimes(1);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "EXHAUSTED", pagesCompleted: 11
    });
  });

  it("retries 16032001 after 5 seconds on the exact same page and resets the counter after success", async () => {
    const seed = await fixture();
    const transient = new TikTokApiError("PROVIDER", "SEARCH_CREATORS", 200, 16032001, "r", "region mismatch");
    await seed.processor.processNext({ searchCreators: vi.fn(async () => { throw transient; }) }, seed.sheet);

    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "WAITING", currentStage: "WAITING_BUSINESS_RETRY", privateNextPageToken: "token200", privateSearchKey: "abc",
      pagesCompleted: 10, nextAttemptAt: new Date("2026-08-14T06:00:05Z"), lastHttpStatus: 200, lastTikTokCode: "16032001"
    });
    expect(await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } })).toMatchObject({
      status: "WAITING_RETRY", pagesCompleted: 10, privateNextPageToken: "token200", privateSearchKey: "abc",
      business16032001RetryCount: 1, business16032001RetryPage: 11
    });

    const retry = { searchCreators: vi.fn(async (filters, cursor) => {
      expect(filters).toMatchObject({ marketplaceCategory: { parentCategoryId: "600001", childCategoryIds: ["600001-child"] },
        minFollowers: 1_000, maxFollowers: 1_499 });
      expect(cursor).toEqual({ pageSize: 20, pageToken: "token200", searchKey: "abc" });
      return { creators: [creator("business-retry")], searchKey: "abc", nextPageToken: "token220", hasMore: true };
    }) };
    const dueProcessor = new CreatorSyncProcessor(
      prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any,
      { now: () => new Date("2026-08-14T06:00:05Z"), random: () => 0 }
    );
    await dueProcessor.processNext(retry, seed.sheet);

    expect(retry.searchCreators).toHaveBeenCalledTimes(1);
    expect(await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } })).toMatchObject({
      status: "RUNNING", pagesCompleted: 11, privateNextPageToken: "token220", privateSearchKey: "abc",
      business16032001RetryCount: 0, business16032001RetryPage: null
    });
  });

  it("pauses at ten consecutive 16032001 responses and manual Continue opens a fresh retry window", async () => {
    const seed = await fixture();
    const partition = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: partition.id }, data: {
      business16032001RetryCount: 9, business16032001RetryPage: 11
    } });
    await seed.processor.processNext({ searchCreators: vi.fn(async () => {
      throw new TikTokApiError("PROVIDER", "SEARCH_CREATORS", 200, 16032001, "r", "region mismatch");
    }) }, seed.sheet);

    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "PAUSED", currentStage: "TIKTOK_BUSINESS_RETRY_LIMIT", nextAttemptAt: null,
      privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10
    });
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: partition.id } })).toMatchObject({
      status: "PAUSED", pagesCompleted: 10, privateNextPageToken: "token200", privateSearchKey: "abc",
      business16032001RetryCount: 10, business16032001RetryPage: 11
    });
    expect(await prisma.creatorSyncEvent.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id, stage: "TIKTOK_BUSINESS_RETRY_LIMIT" } })).toMatchObject({
      pageNumber: 11, httpStatus: 200, tiktokCode: "16032001", nextAttemptAt: null
    });

    await seed.service.resume();
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: partition.id } })).toMatchObject({
      status: "RUNNING", pagesCompleted: 10, privateNextPageToken: "token200", privateSearchKey: "abc",
      business16032001RetryCount: 0, business16032001RetryPage: null
    });
  });

  it("honors a longer provider Retry-After without changing the cursor", async () => {
    const seed = await fixture(); const due = new Date("2026-08-14T06:02:00Z");
    await seed.processor.processNext({ searchCreators: vi.fn(async () => { throw new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", 429, 36009002, "r", "throttled", 120_000, due); }) }, seed.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "WAITING", privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10, nextAttemptAt: due
    });
  });

  it("Pause cancels a scheduled retry and Resume retains the persisted cursor", async () => {
    const seed = await fixture();
    await prisma.creatorSyncJob.update({ where: { id: seed.job.id }, data: { state: "WAITING", nextAttemptAt: new Date("2026-08-14T06:00:30Z") } });
    await seed.service.pause();
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "PAUSED", nextAttemptAt: null, privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10
    });
    expect(await seed.processor.processNext({ searchCreators: vi.fn() }, seed.sheet)).toBe(false);
    await seed.service.resume();
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "RUNNING", nextAttemptAt: null, privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10
    });
  });

  it("keeps continuation requests single-flight", async () => {
    const seed = await fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const adapter = { searchCreators: vi.fn(async () => {
      await pending;
      return { creators: [], searchKey: "abc", hasMore: false };
    }) };
    const first = seed.processor.processNext(adapter, seed.sheet);
    await vi.waitFor(() => expect(adapter.searchCreators).toHaveBeenCalledTimes(1));
    await seed.processor.processNext(adapter, seed.sheet);
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("retries a transient Google Sheets failure from the staged page without another Marketplace request", async () => {
    const sheetFailure = await fixture();
    const successfulPage = { searchCreators: vi.fn(async () => ({ creators: [creator("sheet-failure")], searchKey: "abc", nextPageToken: "token220", hasMore: true })) };
    const reconcilePage = vi.fn(async () => { throw new GoogleSheetsError({ httpStatus: 503, googleApiCode: "UNAVAILABLE (503)", retryable: true, safeReason: "backend unavailable" }); });
    await sheetFailure.processor.processNext(successfulPage, { ...sheetFailure.sheet, reconcilePage });
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: sheetFailure.job.id } })).toMatchObject({
      state: "WAITING", currentStage: "WAITING_SHEET_RETRY", pagesCompleted: 10, privateNextPageToken: "token200",
      nextAttemptAt: new Date("2026-08-14T06:00:05Z"), lastHttpStatus: 503, lastTikTokCode: null
    });
    expect(await prisma.creatorSyncPage.findFirstOrThrow({ where: { creatorSyncJobId: sheetFailure.job.id, state: "RECEIVED" } })).toMatchObject({
      pageNumber: 11, newUniqueCreators: 1, duplicateRows: 0, sheetsAttemptCount: 1,
      lastSheetsHttpStatus: 503, lastSheetsApiCode: "UNAVAILABLE (503)", lastSheetsRetryable: true
    });

    const recovered = new CreatorSyncProcessor(prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any,
      { now: () => new Date("2026-08-14T06:00:05Z"), random: () => 0 });
    const recoverySheet = { ...sheetFailure.sheet, reconcilePage: vi.fn(async () => undefined) };
    await recovered.processNext(successfulPage, recoverySheet);
    expect(successfulPage.searchCreators).toHaveBeenCalledTimes(1);
    expect(reconcilePage).toHaveBeenCalledTimes(1);
    expect(recoverySheet.reconcilePage).toHaveBeenCalledTimes(1);
    expect(await prisma.creatorSyncPage.findFirstOrThrow({ where: { creatorSyncJobId: sheetFailure.job.id, pageNumber: 11 } })).toMatchObject({ state: "COMMITTED", sheetsAttemptCount: 0 });
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: sheetFailure.job.id } })).toMatchObject({ state: "RUNNING", currentStage: "PAGE_COMMITTED", pagesCompleted: 11 });
    expect(await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: sheetFailure.job.id } }))
      .toMatchObject({ uniqueCreatorsAdded: 1, duplicates: 0 });
    expect((await prisma.creatorSyncEvent.findMany({ where: { creatorSyncJobId: sheetFailure.job.id }, orderBy: { occurredAt: "asc" } })).map((event) => event.stage))
      .toEqual(expect.arrayContaining(["SHEET_RETRY", "SHEET_RECOVERED", "PAGE_COMMITTED", "CURSOR_ADVANCED"]));

    const cursorFailure = await fixture();
    await cursorFailure.processor.processNext({ searchCreators: vi.fn(async () => ({ creators: [], searchKey: "abc", nextPageToken: "token200", hasMore: true })) }, cursorFailure.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: cursorFailure.job.id } })).toMatchObject({
      state: "ERROR", currentStage: "CURSOR_ERROR", pagesCompleted: 10, privateNextPageToken: "token200",
      lastSafeError: "Page commit failed; the cursor was not advanced"
    });
  });

  it("uses the persisted Marketplace retry delay for future 36009002 retries", async () => {
    const seed = await fixture();
    await prisma.creatorSyncJob.update({ where: { id: seed.job.id }, data: { marketplaceRetryDelaySeconds: 7 } });
    await seed.processor.processNext({ searchCreators: vi.fn(async () => {
      throw new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", 429, 36009002, "r", "throttled");
    }) }, seed.sheet);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "WAITING", currentStage: "WAITING_RETRY", nextAttemptAt: new Date("2026-08-14T06:00:07Z"),
      privateNextPageToken: "token200", privateSearchKey: "abc", pagesCompleted: 10
    });
  });

  it("pauses after ten Sheets attempts and Continue resets only the Sheets retry window", async () => {
    const seed = await fixture();
    const adapter = { searchCreators: vi.fn(async () => ({ creators: [creator("sheets-limit")], searchKey: "abc", nextPageToken: "token220", hasMore: true })) };
    const failure = new GoogleSheetsError({ httpStatus: 503, googleApiCode: "UNAVAILABLE (503)", retryable: true, safeReason: "backend unavailable" });
    let now = new Date("2026-08-14T06:00:00Z");
    for (let attempt = 0; attempt < 10; attempt++) {
      const processor = attempt === 0 ? seed.processor : new CreatorSyncProcessor(prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any,
        { now: () => now, random: () => 0 });
      await processor.processNext(adapter, { ...seed.sheet, reconcilePage: vi.fn(async () => { throw failure; }) });
      now = new Date(now.getTime() + 5_000);
    }
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({ state: "PAUSED", currentStage: "SHEET_RETRY_LIMIT", pagesCompleted: 10, nextAttemptAt: null });
    expect(await prisma.creatorSyncPage.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id, state: "RECEIVED" } })).toMatchObject({ sheetsAttemptCount: 10, nextSheetsAttemptAt: null });

    await seed.service.resume();
    expect(await prisma.creatorSyncPage.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id, state: "RECEIVED" } })).toMatchObject({ sheetsAttemptCount: 0 });
    const recovered = new CreatorSyncProcessor(prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any,
      { now: () => now, random: () => 0 });
    await recovered.processNext(adapter, { ...seed.sheet, reconcilePage: vi.fn(async () => undefined) });
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
    expect(await prisma.creatorSyncPage.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id, pageNumber: 11 } })).toMatchObject({ state: "COMMITTED" });
  });

  it("pauses immediately for a non-retryable Sheets error with safe provider details", async () => {
    const seed = await fixture();
    const adapter = { searchCreators: vi.fn(async () => ({ creators: [creator("sheets-permission")], searchKey: "abc", nextPageToken: "token220", hasMore: true })) };
    await seed.processor.processNext(adapter, { ...seed.sheet, reconcilePage: vi.fn(async () => {
      throw new GoogleSheetsError({ httpStatus: 403, googleApiCode: "PERMISSION_DENIED (403)", retryable: false, safeReason: "permission denied" });
    }) });
    const job = await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } });
    expect(job).toMatchObject({ state: "PAUSED", currentStage: "SHEET_ERROR", nextAttemptAt: null, lastHttpStatus: 403 });
    expect(job.lastSafeError).toContain("PERMISSION_DENIED (403)");
    expect(job.lastSafeError).toContain("non-retryable");
    expect(await prisma.creatorSyncPage.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id, state: "RECEIVED" } })).toMatchObject({ sheetsAttemptCount: 1, nextSheetsAttemptAt: null });
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
  });

  it("persists a PostgreSQL failure stage without exposing database details", async () => {
    const seed = await fixture();
    vi.spyOn(seed.processor as any, "persistCreators").mockRejectedValueOnce(new Error("private database detail"));
    await seed.processor.processNext({ searchCreators: vi.fn(async () => ({ creators: [creator("db-failure")], searchKey: "abc", nextPageToken: "token220", hasMore: true })) }, seed.sheet);
    const job = await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } });
    expect(job).toMatchObject({ state: "ERROR", currentStage: "DATABASE_ERROR", pagesCompleted: 10, privateNextPageToken: "token200" });
    expect(job.lastSafeError).toBe("PostgreSQL save failed; Page remains uncommitted");
    expect(JSON.stringify(job)).not.toContain("private database detail");
  });

  it("scopes staged receipt idempotency to the partition when provider page tokens repeat", async () => {
    const seed = await fixture();
    await prisma.creatorSyncPage.create({ data: {
      creatorSyncJobId: seed.job.id, state: "COMMITTED", pageNumber: 11, privateRequestToken: "token200",
      privateSearchKey: "legacy-search", providerHasMore: true, creatorsReturned: 0, payload: [], committedAt: new Date()
    } });
    const adapter = { searchCreators: vi.fn(async () => ({ creators: [creator("partition-token")], searchKey: "abc", nextPageToken: "token220", hasMore: true })) };

    await seed.processor.processNext(adapter, seed.sheet);

    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
    const receipts = await prisma.creatorSyncPage.findMany({ where: { creatorSyncJobId: seed.job.id }, orderBy: { receivedAt: "asc" } });
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toMatchObject({ state: "COMMITTED", pageNumber: 11 });
    expect(receipts[1].creatorSearchPartitionId).not.toBeNull();
    expect(await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id, partitionKey: "v2:600001:600001-child:f1000-1499:g1" } })).toMatchObject({
      pagesCompleted: 11, privateNextPageToken: "token220"
    });
  });

  it("rolls back every creator in the page when one creator reconciliation fails", async () => {
    const seed = await fixture();
    const conflictingUserId = `user_${stamp()}`;
    await prisma.creator.create({ data: { creatorOpenId: `existing_${stamp()}`, creatorUserId: conflictingUserId, selectionRegion: "ID" } });
    const first = creator(`rollback_first_${stamp()}`);
    const conflicting = { ...creator(`rollback_second_${stamp()}`), creatorUserId: conflictingUserId };

    await seed.processor.processNext({ searchCreators: vi.fn(async () => ({ creators: [first, conflicting], searchKey: "abc", nextPageToken: "token220", hasMore: true })) }, seed.sheet);

    expect(await prisma.creator.findUnique({ where: { creatorOpenId: first.creatorOpenId } })).toBeNull();
    expect(await prisma.creatorSyncPage.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id, state: "RECEIVED" } })).toMatchObject({ pageNumber: 11, creatorsReturned: 2 });
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      state: "ERROR", currentStage: "DATABASE_ERROR", pagesCompleted: 10, privateNextPageToken: "token200",
      lastSafeError: "PostgreSQL save failed; Record: 2/2; Page remains uncommitted"
    });
    expect(seed.sheet.reconcilePage).not.toHaveBeenCalled();
  });

  it("reconciles duplicate stable Creator Open IDs idempotently within one page", async () => {
    const seed = await fixture();
    const duplicate = creator(`duplicate_${stamp()}`);

    await seed.processor.processNext({ searchCreators: vi.fn(async () => ({ creators: [duplicate, { ...duplicate, nickname: "Updated duplicate" }], searchKey: "abc", nextPageToken: "token220", hasMore: true })) }, seed.sheet);

    expect(await prisma.creator.count({ where: { creatorOpenId: duplicate.creatorOpenId } })).toBe(1);
    const stored = await prisma.creator.findUniqueOrThrow({ where: { creatorOpenId: duplicate.creatorOpenId }, include: { snapshots: true } });
    expect(stored.nickname).toBe("Updated duplicate");
    expect(stored.snapshots.filter((snapshot) => snapshot.shopId === seed.shop.id)).toHaveLength(1);
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).toMatchObject({
      pagesCompleted: 11, lastCreatorsReturned: 2, lastCreatorsAdded: 1, lastDuplicates: 1
    });
    const metrics = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    expect(metrics).toMatchObject({ marketplaceRequests: 1, rowsReturned: 2, uniqueCreatorsAdded: 1, duplicates: 1 });
    expect(Number(metrics.newCreatorsPerRequest)).toBe(1); expect(Number(metrics.duplicateRate)).toBe(0.5);
  });

  it("replays a staged page without making another Marketplace request", async () => {
    const seed = await fixture();
    const partition = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    const stagedCreator = creator(`staged_replay_${stamp()}`);
    await prisma.creatorSyncPage.create({ data: {
      creatorSyncJobId: seed.job.id, creatorSearchPartitionId: partition.id, state: "RECEIVED", pageNumber: 11,
      privateRequestToken: `PARTITION:${partition.id}:token200`, privateNextToken: "token220", privateSearchKey: "abc",
      providerHasMore: true, creatorsReturned: 1, payload: [stagedCreator] as unknown as Prisma.InputJsonValue
    } });
    const adapter = { searchCreators: vi.fn() };

    await seed.processor.processNext(adapter, seed.sheet);

    expect(adapter.searchCreators).not.toHaveBeenCalled();
    expect(seed.sheet.reconcilePage).toHaveBeenCalledWith("sheet-test", [stagedCreator]);
    expect(await prisma.creatorSyncPage.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id, pageNumber: 11 } })).toMatchObject({ state: "COMMITTED" });
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: partition.id } })).toMatchObject({ pagesCompleted: 11, privateNextPageToken: "token220" });
  });

  it("automatically advances from an exhausted partition to the next queued partition", async () => {
    const seed = await fixture();
    const first = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: first.id }, data: { pagesCompleted: 0, privateSearchKey: null, privateNextPageToken: null } });
    await prisma.creatorSearchPartition.create({ data: { creatorSyncJobId: seed.job.id, partitionKey: "v2:600001:600001-child:f5000-7499:g1", generation: 3, partitionType: "V2_SEED", categoryId: "600001",
      categoryName: "Beauty", categoryChildId: "600001-child", categoryChildName: "Skin Care", categoryChildIds: ["600001-child"],
      followerBucket: "F08", followersMin: 5_000, followersMax: 7_499, gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100", queuePosition: 1_000_000n } });
    const adapter = { searchCreators: vi.fn()
      .mockResolvedValueOnce({ creators: [], searchKey: "a", hasMore: false })
      .mockResolvedValueOnce({ creators: [], searchKey: "b", nextPageToken: "b2", hasMore: true }) };
    await seed.processor.processNext(adapter, seed.sheet);
    const due = new CreatorSyncProcessor(prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any,
      { now: () => new Date("2026-08-14T06:00:01Z") });
    await due.processNext(adapter, seed.sheet);
    expect(adapter.searchCreators).toHaveBeenCalledTimes(2);
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "COMPLETE" });
    expect(await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id, followerBucket: "F08" } })).toMatchObject({ status: "RUNNING", privateNextPageToken: "b2" });
  });

  it("splits an observed-saturated Low-GMV follower range inside the same GMV branch", async () => {
    const seed = await fixture();
    const parent = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: parent.id }, data: { rowsReturned: 380, uniqueCreatorsAdded: 1,
      pagesCompleted: 29, privateSearchKey: "dense", privateNextPageToken: "p30" } });
    await seed.processor.processNext({ searchCreators: vi.fn(async () => ({ creators: [], searchKey: "dense", hasMore: false })) }, seed.sheet);
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({ status: "COMPLETE",
      observedSaturationState: "OBSERVED_SATURATED", followerSplitExplored: true, pagesCompleted: 30, marketplaceRequests: 1 });
    const children = await prisma.creatorSearchPartition.findMany({ where: { parentPartitionId: parent.id }, orderBy: { queuePosition: "asc" } });
    expect(children.map((child) => [child.followersMin, child.followersMax, child.gmvBucket])).toEqual([
      [1_000, 1_249, "G1"], [1_250, 1_499, "G1"]
    ]);
    expect(children.every((child) => child.gmvRange === "GMV_RANGE_0_100")).toBe(true);
  });

  it("does not generate GMV children after a specific-GMV branch reaches minimum follower width", async () => {
    const seed = await fixture();
    const parent = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: parent.id }, data: { partitionKey: "v2:600001:600001-child:f1000-1099:g1",
      followerBucket: null, followersMin: 1_000, followersMax: 1_099, rowsReturned: 380, uniqueCreatorsAdded: 38,
      pagesCompleted: 29, privateSearchKey: "dense", privateNextPageToken: "p30" } });
    await seed.processor.processNext({ searchCreators: vi.fn(async () => ({ creators: [], searchKey: "dense", hasMore: false })) }, seed.sheet);
    const children = await prisma.creatorSearchPartition.findMany({ where: { parentPartitionId: parent.id }, orderBy: { queuePosition: "asc" } });
    expect(children).toHaveLength(0);
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({ followerRecursionTerminal: true, gmvSplitCreated: false });
  });

  it("marks a saturated minimum-width GMV child deeply saturated and continues", async () => {
    const seed = await fixture();
    const partition = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: partition.id }, data: { partitionKey: "v2:600001:600001-child:f1000-1099:g1",
      generation: 3, partitionType: "ADAPTIVE_GMV", adaptiveDepth: 2, followerBucket: null, followersMin: 1_000, followersMax: 1_099,
      gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100", rowsReturned: 380, uniqueCreatorsAdded: 38,
      pagesCompleted: 29, privateSearchKey: "dense", privateNextPageToken: "p30" } });
    await seed.processor.processNext({ searchCreators: vi.fn(async () => ({ creators: [], searchKey: "dense", hasMore: false })) }, seed.sheet);
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: partition.id } })).toMatchObject({ status: "DEEPLY_SATURATED", mayStillBeDense: true });
  });

  it("does not invent an upper bound for an open-ended specific-GMV branch", async () => {
    const seed = await fixture();
    const parent = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: parent.id }, data: { partitionKey: "v2:600001:600001-child:f5000000-plus:g1",
      followerBucket: "F25", followersMin: 5_000_000, followersMax: null, rowsReturned: 380, uniqueCreatorsAdded: 38,
      pagesCompleted: 29, privateSearchKey: "dense", privateNextPageToken: "p30" } });
    await seed.processor.processNext({ searchCreators: vi.fn(async () => ({ creators: [], searchKey: "dense", hasMore: false })) }, seed.sheet);
    const children = await prisma.creatorSearchPartition.findMany({ where: { parentPartitionId: parent.id }, orderBy: { queuePosition: "asc" } });
    expect(children).toHaveLength(0);
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({ followerRecursionTerminal: true, gmvBucket: "G1" });
  });

  it("materializes deterministic fresh production children idempotently and never reuses experiment nodes", async () => {
    const seed = await fixture();
    const parent = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: parent.id }, data: { status: "COMPLETE", rowsReturned: 400,
      uniqueCreatorsAdded: 4, originalYield: new Prisma.Decimal(0.01), observedSaturationState: "OBSERVED_SATURATED",
      privateSearchKey: "parent-search", privateNextPageToken: null } });
    await prisma.creatorSearchPartition.create({ data: { creatorSyncJobId: seed.job.id,
      partitionKey: `experiment:split:${parent.partitionKey}:f1000-1249`, generation: 3, partitionType: "EXPERIMENT", adaptiveDepth: 1,
      categoryId: parent.categoryId, categoryName: parent.categoryName, categoryChildId: parent.categoryChildId,
      categoryChildName: parent.categoryChildName, categoryChildIds: parent.categoryChildIds, followersMin: 1_000, followersMax: 1_249,
      parentPartitionId: parent.id, status: "COMPLETE", queuePosition: 1n, rowsReturned: 400, uniqueCreatorsAdded: 200 } });
    await seed.processor.prepareAdaptiveQueue(seed.job.id);
    await seed.processor.prepareAdaptiveQueue(seed.job.id);
    const children = await prisma.creatorSearchPartition.findMany({ where: { parentPartitionId: parent.id }, orderBy: { partitionKey: "asc" } });
    expect(children.filter((child) => child.partitionType === "EXPERIMENT")).toHaveLength(1);
    const production = children.filter((child) => child.partitionType === "ADAPTIVE_FOLLOWER");
    expect(production).toHaveLength(2);
    expect(production.map((child) => child.partitionKey)).toEqual([
      `v3:${parent.partitionKey}:f1000-1249`, `v3:${parent.partitionKey}:f1250-1499`
    ]);
    expect(production.every((child) => child.privateSearchKey == null && child.privateNextPageToken == null)).toBe(true);
  });

  it("marks a below-five-percent first split terminal after both children complete", async () => {
    const seed = await fixture();
    const parent = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: parent.id }, data: { status: "COMPLETE", followerSplitExplored: true,
      observedSaturationState: "OBSERVED_SATURATED" } });
    for (const [min, max] of [[1_000, 1_249], [1_250, 1_499]] as const) await prisma.creatorSearchPartition.create({ data: {
      creatorSyncJobId: seed.job.id, partitionKey: `v3:${parent.partitionKey}:f${min}-${max}`, generation: 3,
      partitionType: "ADAPTIVE_FOLLOWER", adaptiveDepth: 1, categoryId: parent.categoryId, categoryName: parent.categoryName,
      categoryChildId: parent.categoryChildId, categoryChildName: parent.categoryChildName, categoryChildIds: parent.categoryChildIds,
      followersMin: min, followersMax: max, gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100", parentPartitionId: parent.id, status: "COMPLETE", queuePosition: BigInt(min),
      rowsReturned: min === 1_000 ? 403 : 401, uniqueCreatorsAdded: 4, incrementalYield: new Prisma.Decimal(min === 1_000 ? 4 / 403 : 4 / 401),
      observedSaturationState: "OBSERVED_SATURATED"
    } });
    await seed.processor.prepareAdaptiveQueue(seed.job.id);
    const stopped = await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: parent.id } });
    expect(Number(stopped.combinedChildIncrementalYield)).toBeCloseTo(8 / 804, 6);
    expect(stopped).toMatchObject({ branchClassification: "EFFECTIVELY_DEAD", followerRecursionTerminal: true });
    expect(await prisma.creatorSearchPartition.count({ where: { creatorSyncJobId: seed.job.id, adaptiveDepth: 2 } })).toBe(0);
  });

  it("a throttled first page keeps the same partition and leaves the next one queued", async () => {
    const seed = await fixture();
    const first = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: first.id }, data: { status: "QUEUED", pagesCompleted: 0, privateSearchKey: null, privateNextPageToken: null } });
    await prisma.creatorSyncJob.update({ where: { id: seed.job.id }, data: { currentPartitionId: null, privateSearchKey: null, privateNextPageToken: null } });
    const second = await prisma.creatorSearchPartition.create({ data: { creatorSyncJobId: seed.job.id, partitionKey: "v2:600001:600001-child:f5000-7499:g1", generation: 3, partitionType: "V2_SEED", categoryId: "600001",
      categoryName: "Beauty", categoryChildId: "600001-child", categoryChildName: "Skin Care", categoryChildIds: ["600001-child"],
      followerBucket: "F08", followersMin: 5_000, followersMax: 7_499, gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100", queuePosition: 1_000_000n } });
    await seed.processor.processNext({ searchCreators: vi.fn(async () => { throw new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", 429, 36009002, "r", "throttled"); }) }, seed.sheet);
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "WAITING_RETRY", privateSearchKey: null, privateNextPageToken: null });
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: "QUEUED" });
    expect((await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).currentPartitionId).toBe(first.id);
  });

  async function schedulerFixture(nextClaimSequence: number) {
    const seed = await fixture();
    const v2 = await prisma.creatorSearchPartition.findFirstOrThrow({ where: { creatorSyncJobId: seed.job.id } });
    await prisma.creatorSearchPartition.update({ where: { id: v2.id }, data: {
      status: "QUEUED", pagesCompleted: 0, privateSearchKey: null, privateNextPageToken: null, startedAt: null
    } });
    const parent = await prisma.creatorSearchPartition.create({ data: { creatorSyncJobId: seed.job.id,
      partitionKey: `v3:${v2.partitionKey}:f1000-1249`, generation: 3, partitionType: "ADAPTIVE_FOLLOWER", adaptiveDepth: 2,
      categoryId: v2.categoryId, categoryName: v2.categoryName, categoryChildId: v2.categoryChildId,
      categoryChildName: v2.categoryChildName, categoryChildIds: v2.categoryChildIds, followersMin: 1_000, followersMax: 1_249,
      gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100", status: "COMPLETE", queuePosition: 10n, rowsReturned: 400, uniqueCreatorsAdded: 180, pagesCompleted: 20,
      incrementalYield: new Prisma.Decimal(0.45), branchClassification: "STRONG", observedSaturationState: "OBSERVED_SATURATED",
      followerRecursionTerminal: true, lastSuccessAt: new Date("2026-08-14T05:00:00Z") } });
    const adaptive = await prisma.creatorSearchPartition.create({ data: { creatorSyncJobId: seed.job.id,
      partitionKey: `v3:${parent.partitionKey}:f1000-1124`, generation: 3, partitionType: "ADAPTIVE_FOLLOWER", adaptiveDepth: 3,
      categoryId: v2.categoryId, categoryName: v2.categoryName, categoryChildId: v2.categoryChildId,
      categoryChildName: v2.categoryChildName, categoryChildIds: v2.categoryChildIds, followersMin: 1_000, followersMax: 1_124,
      gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100", parentPartitionId: parent.id, status: "QUEUED", queuePosition: 11n } });
    await prisma.creatorSyncJob.update({ where: { id: seed.job.id }, data: {
      currentPartitionId: null, privateSearchKey: null, privateNextPageToken: null, partitionClaimSequence: nextClaimSequence
    } });
    return { ...seed, v2, adaptive };
  }

  it("persists a productive Depth 3 HIGH decision and does not let the V2 queue drown it", async () => {
    const seed = await schedulerFixture(0);
    const adapter = { searchCreators: vi.fn(async () => { throw new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", 429, 36009002, "r", "throttled"); }) };
    await seed.processor.processNext(adapter, seed.sheet);
    const job = await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } });
    const selected = await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: seed.adaptive.id } });
    expect(job).toMatchObject({ currentPartitionId: seed.adaptive.id, partitionClaimSequence: 1 });
    expect(selected).toMatchObject({ schedulerClass: "HIGH", schedulerClaimSequence: 1, status: "WAITING_RETRY" });
    expect(selected.priorityReason).toContain("Depth 3 productive branch");
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate a scheduler claim when workers race", async () => {
    const seed = await schedulerFixture(0);
    const adapter = { searchCreators: vi.fn(async () => { throw new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", 429, 36009002, "r", "throttled"); }) };
    await Promise.all([seed.processor.processNext(adapter, seed.sheet), seed.processor.processNext(adapter, seed.sheet)]);
    expect(await prisma.creatorSyncEvent.count({ where: { creatorSyncJobId: seed.job.id, stage: "PARTITION_STARTED" } })).toBe(1);
    expect((await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } })).partitionClaimSequence).toBe(1);
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
  });

  it("persists the claim cycle across restart and selects the FIFO V2 seed in the exploration slot", async () => {
    const seed = await schedulerFixture(6);
    const adapter = { searchCreators: vi.fn(async () => { throw new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", 429, 36009002, "r", "throttled"); }) };
    const restarted = new CreatorSyncProcessor(prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any,
      { now: () => new Date("2026-08-14T06:00:00Z") });
    await restarted.processNext(adapter, seed.sheet);
    const job = await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: seed.job.id } });
    const selected = await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: seed.v2.id } });
    expect(job).toMatchObject({ currentPartitionId: seed.v2.id, partitionClaimSequence: 7 });
    expect(selected).toMatchObject({ schedulerClass: "EXPLORATION", schedulerClaimSequence: 7, status: "WAITING_RETRY" });
    expect(selected.priorityReason).toContain("Specific-GMV exploration slot");
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: seed.adaptive.id } })).toMatchObject({ status: "QUEUED" });
  });
});

describe.sequential("partition initialization", () => {
  it("generates every immediate child times 25 times four documented GMV buckets idempotently while preserving V1", async () => {
    const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK" } }); shopIds.add(shop.id);
    let categories = [
      { id: "600001", parentId: "0", localName: "Beauty", isLeaf: false },
      { id: "700001", parentId: "0", localName: "Fashion", isLeaf: false },
      { id: "600002", parentId: "600001", localName: "Skin Care", isLeaf: false },
      { id: "700002", parentId: "700001", localName: "Women's Fashion", isLeaf: false }
    ];
    const tiktok = { activeShop: async () => shop, categoryMetadataAdapter: async () => ({ getCategories: async () => categories }) };
    const service = new CreatorDatabaseService(prisma as any, tiktok as any);
    await service.refreshCategories();
    const job = await prisma.creatorSyncJob.findUniqueOrThrow({ where: { shopId: shop.id } });
    const preservedCreator = await prisma.creator.create({ data: { creatorOpenId: `preserved_${stamp()}`, selectionRegion: "ID" } });
    const completeV1 = await prisma.creatorSearchPartition.create({ data: { creatorSyncJobId: job.id, partitionKey: `v1:complete:${stamp()}`,
      generation: 1, categoryName: "V1 complete", status: "COMPLETE", queuePosition: -2n, pagesCompleted: 3 } });
    const queuedV1 = await prisma.creatorSearchPartition.create({ data: { creatorSyncJobId: job.id, partitionKey: `v1:queued:${stamp()}`,
      generation: 1, categoryName: "V1 queued", status: "QUEUED", queuePosition: -1n } });
    await service.initializePartitions();
    expect(await prisma.creator.findUnique({ where: { id: preservedCreator.id } })).not.toBeNull();
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: completeV1.id } })).toMatchObject({ status: "COMPLETE", pagesCompleted: 3 });
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: queuedV1.id } })).toMatchObject({ status: "QUEUED" });
    expect(await prisma.creatorSearchPartition.count({ where: { creatorSyncJobId: job.id, generation: 3, followerBucket: { not: null }, gmvBucket: { not: null } } })).toBe(200);
    expect(await prisma.creatorMarketplaceCategory.count({ where: { shopId: shop.id, enabledForCreatorCrawl: true } })).toBe(2);
    const beautyF01 = await prisma.creatorSearchPartition.findUniqueOrThrow({ where: {
      creatorSyncJobId_partitionKey: { creatorSyncJobId: job.id, partitionKey: "v2:600001:600002:f600-799:g1" }
    } });
    expect(beautyF01).toMatchObject({ generation: 3, categoryChildId: "600002", categoryChildName: "Skin Care",
      categoryChildIds: ["600002"], followersMin: 600, followersMax: 799, gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100" });
    categories = [
      { id: "600001", parentId: "0", localName: "Beauty Updated", isLeaf: false },
      { id: "700001", parentId: "0", localName: "Fashion", isLeaf: false },
      { id: "600002", parentId: "600001", localName: "Skin Care", isLeaf: false },
      { id: "600003", parentId: "600001", localName: "Makeup", isLeaf: true },
      { id: "700002", parentId: "700001", localName: "Women's Fashion", isLeaf: false }
    ];
    await service.refreshCategories();
    expect(await prisma.creatorMarketplaceCategory.count({ where: { shopId: shop.id } })).toBe(5);
    expect(await prisma.creatorMarketplaceCategory.findUniqueOrThrow({ where: { shopId_categoryId: { shopId: shop.id, categoryId: "600001" } } }))
      .toMatchObject({ categoryName: "Beauty Updated", level: 1, enabledForCreatorCrawl: true });
    expect((await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: beautyF01.id } })).categoryChildIds).toEqual(["600002"]);
    const beforeFailure = await prisma.creatorMarketplaceCategory.findMany({ where: { shopId: shop.id }, orderBy: { categoryId: "asc" } });
    tiktok.categoryMetadataAdapter = async () => ({ getCategories: async () => { throw new Error("refresh failed"); } });
    await expect(service.refreshCategories()).rejects.toThrow(/refresh failed/);
    expect(await prisma.creatorMarketplaceCategory.findMany({ where: { shopId: shop.id }, orderBy: { categoryId: "asc" } })).toEqual(beforeFailure);
    await prisma.creator.delete({ where: { id: preservedCreator.id } });
  });

  it("disables an unfinished GMV-All root without losing its cursor and reuses an exact completed specific-GMV branch", async () => {
    const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK" } }); shopIds.add(shop.id);
    const job = await prisma.creatorSyncJob.create({ data: { shopId: shop.id, state: "PAUSED", spreadsheetId: "sheet-test",
      privateSearchKey: "job-search", privateNextPageToken: "job-token", pagesCompleted: 4, creatorsFetched: 80, sheetImportedAt: new Date() } });
    const oldRoot = await prisma.creatorSearchPartition.create({ data: { creatorSyncJobId: job.id,
      partitionKey: "v2:root:child:f600-799", generation: 2, partitionType: "V2_SEED", categoryId: "root", categoryName: "Root",
      categoryChildId: "child", categoryChildName: "Child", categoryChildIds: ["child"], followerBucket: "F01", followersMin: 600, followersMax: 799,
      status: "PAUSED", queuePosition: 1n, privateSearchKey: "old-search", privateNextPageToken: "old-token", pagesCompleted: 4, rowsReturned: 80 } });
    await prisma.creatorSyncJob.update({ where: { id: job.id }, data: { currentPartitionId: oldRoot.id } });
    const existingSpecific = await prisma.creatorSearchPartition.create({ data: { creatorSyncJobId: job.id,
      partitionKey: "v3:old-adaptive:f600-799:g1", generation: 3, partitionType: "ADAPTIVE_GMV", adaptiveDepth: 2,
      categoryId: "root", categoryName: "Root", categoryChildId: "child", categoryChildName: "Child", categoryChildIds: ["child"],
      followersMin: 600, followersMax: 799, gmvBucket: "G1", gmvRange: "GMV_RANGE_0_100", status: "COMPLETE", queuePosition: 2n,
      pagesCompleted: 2, rowsReturned: 40, uniqueCreatorsAdded: 4 } });
    await prisma.creatorMarketplaceCategory.createMany({ data: [
      { shopId: shop.id, categoryId: "root", categoryName: "Root", parentCategoryId: null, level: 1, enabledForCreatorCrawl: true, sortOrder: 0, fetchedAt: new Date() },
      { shopId: shop.id, categoryId: "child", categoryName: "Child", parentCategoryId: "root", level: 2, enabledForCreatorCrawl: false, sortOrder: 1, fetchedAt: new Date() }
    ] });
    const service = new CreatorDatabaseService(prisma as any, { activeShop: async () => shop } as any);
    await service.initializePartitions(job.id);

    const disabled = await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: oldRoot.id } });
    expect(disabled).toMatchObject({ status: "DISABLED_BY_STRATEGY", privateSearchKey: "old-search", privateNextPageToken: "old-token", pagesCompleted: 4 });
    expect(await prisma.creatorSearchPartition.count({ where: { creatorSyncJobId: job.id, gmvBucket: { not: null } } })).toBe(100);
    expect(await prisma.creatorSearchPartition.count({ where: { creatorSyncJobId: job.id, categoryId: "root", categoryChildId: "child", followersMin: 600, followersMax: 799, gmvBucket: "G1" } })).toBe(1);
    expect((await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: existingSpecific.id } })).status).toBe("COMPLETE");
    expect((await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: job.id } })).currentPartitionId).toBe(oldRoot.id);

    await service.resume();
    expect(await prisma.creatorSyncJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: "RUNNING", currentStage: "CLAIMING_PARTITION", currentPartitionId: null,
      privateSearchKey: null, privateNextPageToken: null, partitionClaimSequence: 0 });
    expect(await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: oldRoot.id } })).toMatchObject({ status: "DISABLED_BY_STRATEGY", privateSearchKey: "old-search", privateNextPageToken: "old-token" });
    const restartedService = new CreatorDatabaseService(prisma as any, { activeShop: async () => shop } as any);
    expect((await restartedService.status()).currentPartition?.gmv).not.toBe("All");
    const adapter = { searchCreators: vi.fn(async (filters) => {
      expect(filters.marketplaceGmvRanges).toEqual(["GMV_RANGE_100_1000"]);
      return { creators: [], searchKey: "specific-search", hasMore: false };
    }) };
    const processor = new CreatorSyncProcessor(prisma as any, {} as any, new CreatorIdentityResolver(prisma as any), {} as any,
      { now: () => new Date("2026-08-14T06:00:00Z") });
    await processor.processNext(adapter, { readCreators: vi.fn(async () => []), reconcilePage: vi.fn(async () => undefined) });
    expect(adapter.searchCreators).toHaveBeenCalledTimes(1);
    expect((await prisma.creatorSearchPartition.findUniqueOrThrow({ where: { id: oldRoot.id } })).status).toBe("DISABLED_BY_STRATEGY");
  });
});

describe.sequential("Outreach uses stored creator snapshots", () => {
  it("changing filters performs zero Marketplace searches and frozen recipients do not grow", async () => {
    const shop = await prisma.shop.create({ data: { name: stamp(), connectionMode: "MOCK", maxRecipientsPerCampaign: 10 } }); shopIds.add(shop.id);
    const identities = new CreatorIdentityResolver(prisma as any);
    const namespace = stamp(); const smallId = `small_${namespace}`; const largeId = `large_${namespace}`;
    const smallCandidate = creator(smallId, 1_200), largeCandidate = creator(largeId, 7_000);
    for (const item of [smallCandidate, largeCandidate]) {
      const stored = await identities.ensureMarketplaceCreator(item);
      await prisma.creatorMetricSnapshot.create({ data: { creatorId: stored.id, shopId: shop.id, sourcePageKey: `test:${item.creatorOpenId}`,
        followerCount: item.followerCount, categoryIds: item.categoryIds, gmvAmount: new Prisma.Decimal("100"), gmvCurrency: "USD",
        unitsSold: 5, avgVideoViews: 1000, avgLiveViewers: 50, sourceFetchedAt: new Date(), rawPayload: item as unknown as Prisma.InputJsonValue } });
    }
    const marketplaceSearch = vi.fn();
    const tiktok = { activeShop: async () => shop, discoveryAdapter: marketplaceSearch };
    const outreach = new OutreachService(prisma as any, {} as any, tiktok as any);
    const make = async (name: string, minFollowers: number, maxFollowers: number, keyword: string) => {
      const campaign = await outreach.create({ name, productName: "Product", targetCount: 1, candidateLimit: 1, cooldownDays: 0,
        messageTemplate: "Hi {{creator_display_name}}", filters: { keyword, minFollowers, maxFollowers }, rankingMetric: "FOLLOWERS" });
      await outreach.discover(campaign.id); return campaign;
    };
    const small = await make(stamp(), 1_000, 1_500, smallId); const large = await make(stamp(), 5_000, 10_000, largeId);
    expect(marketplaceSearch).not.toHaveBeenCalled();
    expect((await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: small.id, selected: true }, include: { creator: true } })).creator.creatorOpenId).toBe(smallCandidate.creatorOpenId);
    expect((await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: large.id, selected: true }, include: { creator: true } })).creator.creatorOpenId).toBe(largeCandidate.creatorOpenId);

    await prisma.campaign.update({ where: { id: small.id }, data: { state: "FROZEN", frozenAt: new Date(), freezeExpiresAt: new Date(Date.now() + 60_000) } });
    const before = await prisma.campaignRecipient.count({ where: { campaignId: small.id } });
    const added = creator(`later_${namespace}`, 1_300); const stored = await identities.ensureMarketplaceCreator(added);
    await prisma.creatorMetricSnapshot.create({ data: { creatorId: stored.id, shopId: shop.id, sourcePageKey: `test:later:${namespace}`, followerCount: 1_300,
      categoryIds: ["beauty"], sourceFetchedAt: new Date(), rawPayload: added as unknown as Prisma.InputJsonValue } });
    expect(await prisma.campaignRecipient.count({ where: { campaignId: small.id } })).toBe(before);
  });
});
