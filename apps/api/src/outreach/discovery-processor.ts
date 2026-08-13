import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Prisma } from "@affiliate/db";
import type { TikTokReadAdapter } from "@affiliate/contracts";
import type { CreatorCandidate, CreatorFilters } from "@affiliate/domain";
import { TikTokApiError } from "@affiliate/tiktok-adapter";
import { config, PrismaService } from "../shared";
import { TikTokIntegrationService } from "../integrations/tiktok.service";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";
import { rebuildLocalPreview } from "./local-preview";

const RUN_LEASE_MS = 2 * 60_000;
const TEMPORARY_BASE_MS = 5 * 60_000;
const TEMPORARY_MAX_MS = 60 * 60_000;

type Options = { now?: () => Date; random?: () => number; leaseMs?: number };
export type MarketplaceSearchOnly = Pick<TikTokReadAdapter, "searchCreators">;

export function temporaryBackoffMs(count: number, random = Math.random): number {
  const base = Math.min(TEMPORARY_MAX_MS, TEMPORARY_BASE_MS * 2 ** Math.min(Math.max(0, count - 1), 20));
  return base + Math.floor(base * 0.2 * random());
}

export function publicDiscoveryRun(run: {
  state: string; requestedTarget: number; candidateLimit: number; pagesFetched: number; candidatesFetched: number;
  nextAttemptAt: Date | null; consecutiveThrottleCount: number; totalProviderRequests: number; lastProviderCode: string | null;
  failureCategory: string | null; createdAt: Date; updatedAt: Date; completedAt: Date | null;
}) {
  return {
    state: run.state, requestedTarget: run.requestedTarget, candidateLimit: run.candidateLimit,
    pagesFetched: run.pagesFetched, candidatesFetched: run.candidatesFetched,
    nextAttemptAt: run.nextAttemptAt, consecutiveThrottleCount: run.consecutiveThrottleCount,
    totalProviderRequests: run.totalProviderRequests, lastProviderCode: run.lastProviderCode,
    failureCategory: run.failureCategory, createdAt: run.createdAt, updatedAt: run.updatedAt, completedAt: run.completedAt
  };
}

@Injectable()
export class DiscoveryProcessor {
  private readonly options: Options;
  constructor(
    private readonly prisma: PrismaService,
    private readonly tiktok: TikTokIntegrationService,
    private readonly identities: CreatorIdentityResolver,
    @Optional() @Inject("DISCOVERY_PROCESSOR_OPTIONS") options?: Options
  ) { this.options = options ?? {}; }

  private now() { return this.options.now?.() ?? new Date(); }

  async processNext(adapterOverride?: MarketplaceSearchOnly): Promise<boolean> {
    const now = this.now();
    const candidate = await this.prisma.discoveryRun.findFirst({
      where: {
        state: { in: ["QUEUED", "RUNNING", "BACKING_OFF"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        AND: [{ OR: [{ leaseId: null }, { leaseExpiresAt: { lte: now } }] }]
      },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }]
    });
    if (!candidate) return false;
    const leaseId = randomBytes(18).toString("base64url");
    const claimed = await this.prisma.discoveryRun.updateMany({
      where: { id: candidate.id, state: { in: ["QUEUED", "RUNNING", "BACKING_OFF"] }, OR: [{ leaseId: null }, { leaseExpiresAt: { lte: now } }] },
      data: { state: "RUNNING", leaseId, leaseExpiresAt: new Date(now.getTime() + (this.options.leaseMs ?? RUN_LEASE_MS)), nextAttemptAt: null }
    });
    if (claimed.count !== 1) return true;
    try { await this.processClaimed(candidate.id, leaseId, adapterOverride); }
    catch (error) { await this.handleError(candidate.id, leaseId, error); }
    return true;
  }

  private async processClaimed(runId: string, leaseId: string, adapterOverride?: MarketplaceSearchOnly) {
    const run = await this.prisma.discoveryRun.findFirstOrThrow({ where: { id: runId, leaseId }, include: { campaign: true } });
    if (!run.providerHasMore || run.candidatesFetched >= run.candidateLimit) return this.finalize(runId, leaseId);
    const adapter: MarketplaceSearchOnly = adapterOverride ?? await this.tiktok.discoveryAdapter();
    const page = await adapter.searchCreators(run.campaign.filters as CreatorFilters, {
      pageSize: 20,
      ...(run.providerNextPageToken ? { pageToken: run.providerNextPageToken } : {}),
      ...(run.providerSearchKey ? { searchKey: run.providerSearchKey } : {})
    });
    const requestedAt = this.now();
    const remaining = run.candidateLimit - run.candidatesFetched;
    const pageCandidates = page.creators.slice(0, remaining);
    await this.prisma.$transaction(async (tx) => {
      for (const [index, creator] of pageCandidates.entries()) {
        await tx.discoveryCandidate.upsert({
          where: { discoveryRunId_creatorOpenId: { discoveryRunId: runId, creatorOpenId: creator.creatorOpenId } },
          update: {},
          create: {
            discoveryRunId: runId, creatorOpenId: creator.creatorOpenId,
            discoveryOrdinal: run.candidatesFetched + index,
            candidate: { ...creator, discoveryOrdinal: run.candidatesFetched + index } as unknown as Prisma.InputJsonValue
          }
        });
      }
      await tx.discoveryRun.updateMany({ where: { id: runId, leaseId }, data: {
        pagesFetched: { increment: 1 }, candidatesFetched: { increment: pageCandidates.length },
        totalProviderRequests: { increment: 1 }, lastProviderRequestAt: requestedAt,
        consecutiveThrottleCount: 0, lastProviderCode: "0", failureCategory: null,
        providerSearchKey: page.searchKey || run.providerSearchKey,
        providerNextPageToken: page.nextPageToken ?? null,
        providerHasMore: page.hasMore,
        leaseId: null, leaseExpiresAt: null,
        nextAttemptAt: page.hasMore && run.candidatesFetched + pageCandidates.length < run.candidateLimit
          ? new Date(requestedAt.getTime() + config.MARKETPLACE_SUCCESS_SPACING_MS) : null
      } });
    });
    if (!page.hasMore || run.candidatesFetched + pageCandidates.length >= run.candidateLimit) {
      const reacquired = await this.prisma.discoveryRun.updateMany({ where: { id: runId, leaseId: null, state: "RUNNING" }, data: { leaseId, leaseExpiresAt: new Date(this.now().getTime() + RUN_LEASE_MS) } });
      if (reacquired.count) await this.finalize(runId, leaseId);
    }
  }

  private async finalize(runId: string, leaseId: string) {
    const run = await this.prisma.discoveryRun.findFirstOrThrow({ where: { id: runId, leaseId }, include: { campaign: true, candidates: { orderBy: { discoveryOrdinal: "asc" } } } });
    const creators = run.candidates.map((row) => row.candidate as unknown as CreatorCandidate);
    for (const creator of creators) await this.identities.ensureMarketplaceCreator(creator);
    await this.prisma.$transaction(async (tx) => {
      await rebuildLocalPreview(tx, runId, this.now());
    });
  }

  private async handleError(runId: string, leaseId: string, error: unknown) {
    const now = this.now();
    const run = await this.prisma.discoveryRun.findFirst({ where: { id: runId, leaseId } });
    if (!run) return;
    if (error instanceof TikTokApiError && error.kind === "RATE_LIMIT") {
      const providerPerformed = !error.locallyBlocked;
      await this.prisma.discoveryRun.update({ where: { id: runId }, data: {
        state: "BACKING_OFF", nextAttemptAt: error.nextPermittedAt ?? new Date(now.getTime() + 15 * 60_000),
        consecutiveThrottleCount: providerPerformed ? { increment: 1 } : undefined,
        totalProviderRequests: providerPerformed ? { increment: 1 } : undefined,
        lastProviderRequestAt: providerPerformed ? now : undefined,
        lastProviderCode: error.providerCode ? String(error.providerCode) : error.httpStatus === 429 ? "HTTP_429" : "LOCAL_PACING",
        failureCategory: error.providerCode === 45101004 ? "DAILY_QUOTA" : "MARKETPLACE_THROTTLED",
        leaseId: null, leaseExpiresAt: null
      } });
      return;
    }
    if (error instanceof TikTokApiError && error.kind === "TEMPORARY") {
      const count = run.consecutiveThrottleCount + 1;
      await this.prisma.discoveryRun.update({ where: { id: runId }, data: {
        state: "BACKING_OFF", nextAttemptAt: new Date(now.getTime() + temporaryBackoffMs(count, this.options.random)),
        consecutiveThrottleCount: count, totalProviderRequests: { increment: 1 }, lastProviderRequestAt: now,
        lastProviderCode: error.providerCode ? String(error.providerCode) : "TEMPORARY", failureCategory: "PROVIDER_TEMPORARY",
        leaseId: null, leaseExpiresAt: null
      } });
      return;
    }
    const category = error instanceof TikTokApiError ? error.kind : "READ_PROVIDER_FAILURE";
    const providerPerformed = error instanceof TikTokApiError && !error.locallyBlocked && (error.httpStatus != null || error.requestId != null);
    await this.prisma.$transaction([
      this.prisma.discoveryRun.update({ where: { id: runId }, data: {
        state: "FAILED", failureCategory: category,
        totalProviderRequests: providerPerformed ? { increment: 1 } : undefined,
        lastProviderRequestAt: providerPerformed ? now : undefined,
        lastProviderCode: error instanceof TikTokApiError && error.providerCode ? String(error.providerCode) : null,
        leaseId: null, leaseExpiresAt: null
      } }),
      this.prisma.campaign.updateMany({ where: { id: run.campaignId, state: "DISCOVERING" }, data: { state: "DRAFT", version: { increment: 1 } } })
    ]);
  }
}
