import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@affiliate/db";
import type { ProviderConversation, TikTokReadAdapter } from "@affiliate/contracts";
import { TikTokApiError } from "@affiliate/tiktok-adapter";
import { config, PrismaService } from "../shared";
import { TikTokIntegrationService } from "../integrations/tiktok.service";
import { CreatorIdentityResolver } from "../identity/creator-identity-resolver.service";
import { rebuildHistoricalContactState } from "./contact-state";

const RUN_LEASE_MS = 2 * 60_000;
const TEMPORARY_BASE_MS = 30_000;
const TEMPORARY_MAX_MS = 30 * 60_000;
const SOURCE = "PERSISTENT_TIKTOK_HISTORY";

type HistoryReadOnly = Pick<TikTokReadAdapter, "listConversations" | "listMessages">;
type Options = { now?: () => Date; random?: () => number; leaseMs?: number };

const contentHash = (value: string) => createHash("sha256").update(value).digest("hex");
const publicErrorCode = (error: TikTokApiError) => error.providerCode ? String(error.providerCode) : error.httpStatus ? `HTTP_${error.httpStatus}` : error.kind;

export function publicHistoryJob(job: {
  state: string; mode: string; passKind: string; pagesProcessed: number; conversationsDiscovered: number; conversationsImported: number;
  conversationsCompleted: number; messagesImported: number; totalProviderRequests: number; cursorRecoveryCount: number;
  lastProviderCode: string | null; lastErrorCategory: string | null; lastSuccessfulProviderRequestAt: Date | null;
  nextAttemptAt: Date | null; startedAt: Date | null; initialCompletedAt: Date | null; completedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    state: job.state, mode: job.mode, passKind: job.passKind, pagesProcessed: job.pagesProcessed,
    conversationsDiscovered: job.conversationsDiscovered, conversationsImported: job.conversationsImported,
    conversationsCompleted: job.conversationsCompleted,
    messagesImported: job.messagesImported, totalProviderRequests: job.totalProviderRequests,
    cursorRecoveryCount: job.cursorRecoveryCount, lastProviderCode: job.lastProviderCode,
    lastErrorCategory: job.lastErrorCategory, lastSuccessfulProviderRequestAt: job.lastSuccessfulProviderRequestAt,
    nextAttemptAt: job.nextAttemptAt, startedAt: job.startedAt, initialCompletedAt: job.initialCompletedAt,
    completedAt: job.completedAt, createdAt: job.createdAt, updatedAt: job.updatedAt
  };
}

@Injectable()
export class HistoryProcessor {
  private readonly options: Options;
  constructor(
    private readonly prisma: PrismaService,
    private readonly tiktok: TikTokIntegrationService,
    private readonly identities: CreatorIdentityResolver,
    @Optional() @Inject("HISTORY_PROCESSOR_OPTIONS") options?: Options
  ) { this.options = options ?? {}; }

  private now() { return this.options.now?.() ?? new Date(); }

  async processNext(adapterOverride?: HistoryReadOnly): Promise<boolean> {
    const now = this.now();
    const candidate = await this.prisma.historySyncJob.findFirst({
      where: {
        state: { in: ["QUEUED", "RUNNING", "BACKING_OFF", "COMPLETE"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        AND: [{ OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: now } }] }]
      },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }]
    });
    if (!candidate) return false;
    if (candidate.state === "COMPLETE" && candidate.mode !== "INCREMENTAL") return false;
    const leaseOwner = randomBytes(18).toString("base64url");
    const claimed = await this.prisma.historySyncJob.updateMany({
      where: { id: candidate.id, state: { in: ["QUEUED", "RUNNING", "BACKING_OFF", "COMPLETE"] }, OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: now } }] },
      data: {
        state: "RUNNING", leaseOwner, leaseExpiresAt: new Date(now.getTime() + (this.options.leaseMs ?? RUN_LEASE_MS)),
        nextAttemptAt: null, startedAt: candidate.startedAt ?? now,
        ...(candidate.state === "COMPLETE" ? { passKind: "INCREMENTAL", phase: "LIST", privateIncrementalPageToken: null, incrementalPageIndex: 0 } : {})
      }
    });
    if (claimed.count !== 1) return true;
    if (candidate.state === "BACKING_OFF") await this.prisma.auditEvent.create({
      data: { shopId: candidate.shopId, eventType: "HISTORY_BACKOFF_EXITED", payload: { resumedAt: now.toISOString() } }
    });
    try {
      const adapter = adapterOverride ?? await this.tiktok.historyAdapter();
      await this.processClaimed(candidate.id, leaseOwner, adapter);
    } catch (error) {
      await this.handleError(candidate.id, leaseOwner, error);
    }
    return true;
  }

  private async processClaimed(jobId: string, leaseOwner: string, adapter: HistoryReadOnly) {
    const job = await this.prisma.historySyncJob.findFirstOrThrow({ where: { id: jobId, leaseOwner } });
    if (job.phase === "LIST") return this.fetchConversationPage(job, leaseOwner, adapter);
    const work = await this.prisma.historySyncConversationWork.findFirst({
      where: { historySyncJobId: job.id, pageSequence: job.pageSequence, state: { not: "COMPLETE" } }, orderBy: { createdAt: "asc" }
    });
    if (work) return this.fetchMessagePage(job, work, leaseOwner, adapter);
    return this.advanceCompletedPage(job, leaseOwner);
  }

  private listCursor(job: { passKind: string; privateBackfillPageToken: string | null; privateIncrementalPageToken: string | null }) {
    if (job.passKind === "BACKFILL") return job.privateBackfillPageToken ?? undefined;
    return job.privateIncrementalPageToken ?? undefined;
  }

  private async fetchConversationPage(job: any, leaseOwner: string, adapter: HistoryReadOnly) {
    const pageToken = this.listCursor(job);
    const page = await adapter.listConversations({ pageSize: 50, ...(pageToken ? { pageToken } : {}) });
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      for (const item of page.items) await tx.historySyncConversationWork.upsert({
        where: { historySyncJobId_pageSequence_externalConversationId: { historySyncJobId: job.id, pageSequence: job.pageSequence, externalConversationId: item.id } },
        update: {},
        create: {
          historySyncJobId: job.id, pageSequence: job.pageSequence, externalConversationId: item.id,
          creatorImId: item.creatorImId, username: item.username, avatarUrl: item.avatarUrl, unreadCount: item.unreadCount ?? 0
        }
      });
      await tx.historySyncJob.updateMany({ where: { id: job.id, leaseOwner }, data: {
        phase: "MESSAGES", privatePendingNextPageToken: page.nextPageToken ?? null, privatePendingHasMore: page.hasMore,
        conversationsDiscovered: { increment: page.items.length }, totalProviderRequests: { increment: 1 },
        lastSuccessfulProviderRequestAt: now, consecutiveFailureCount: 0, lastProviderCode: "0", lastErrorCategory: null,
        leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date(now.getTime() + config.HISTORY_SYNC_SUCCESS_SPACING_MS)
      } });
    });
  }

  private async ensureConversation(item: ProviderConversation, shopId: string) {
    const creator = await this.identities.ensureConversationCreator(item);
    const existed = await this.prisma.conversation.findUnique({ where: { externalConversationId: item.id }, select: { id: true } });
    const conversation = await this.prisma.conversation.upsert({
      where: { externalConversationId: item.id },
      update: { unreadCount: item.unreadCount ?? 0, lastSyncedAt: this.now() },
      create: { shopId, creatorId: creator.id, externalConversationId: item.id, unreadCount: item.unreadCount ?? 0, lastSyncedAt: this.now() }
    });
    return { creator, conversation, imported: !existed };
  }

  private async fetchMessagePage(job: any, work: any, leaseOwner: string, adapter: HistoryReadOnly) {
    const item: ProviderConversation = {
      id: work.externalConversationId, creatorImId: work.creatorImId, username: work.username ?? undefined,
      avatarUrl: work.avatarUrl ?? undefined, unreadCount: work.unreadCount
    };
    const { creator, conversation, imported } = await this.ensureConversation(item, job.shopId);
    const page = await adapter.listMessages(item.id, {
      pageSize: 20, creatorImId: item.creatorImId,
      ...(work.privateMessagePageToken ? { pageToken: work.privateMessagePageToken } : {})
    });
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      let newlyImported = 0;
      for (const message of page.items) {
        const inserted = await tx.conversationMessage.createMany({ data: [{
          conversationId: conversation.id, externalMessageId: message.id, direction: message.direction,
          content: message.content, contentHash: contentHash(message.content), providerCreatedAt: message.createdAt,
          importSource: SOURCE, rawPayload: {}
        }], skipDuplicates: true });
        newlyImported += inserted.count;
      }
      await rebuildHistoricalContactState(tx, job.shopId, creator.id);
      await tx.historySyncConversationWork.update({ where: { id: work.id }, data: {
        state: page.hasMore ? "RUNNING" : "COMPLETE", privateMessagePageToken: page.nextPageToken ?? null,
        messagesImported: { increment: newlyImported }, providerRequests: { increment: 1 }, completedAt: page.hasMore ? null : now
      } });
      await tx.historySyncJob.updateMany({ where: { id: job.id, leaseOwner }, data: {
        messagesImported: { increment: newlyImported }, conversationsImported: imported ? { increment: 1 } : undefined,
        conversationsCompleted: page.hasMore ? undefined : { increment: 1 },
        totalProviderRequests: { increment: 1 }, lastSuccessfulProviderRequestAt: now,
        consecutiveFailureCount: 0, lastProviderCode: "0", lastErrorCategory: null,
        leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date(now.getTime() + config.HISTORY_SYNC_SUCCESS_SPACING_MS)
      } });
      if (newlyImported > 0) await tx.auditEvent.create({ data: {
        shopId: job.shopId, eventType: "HISTORY_MESSAGES_IMPORTED",
        payload: { conversationId: work.externalConversationId, imported: newlyImported }
      } });
    });
  }

  private async advanceCompletedPage(job: any, leaseOwner: string) {
    const now = this.now();
    const nextToken = job.privatePendingNextPageToken;
    const hasMore = job.privatePendingHasMore === true;
    const common = {
      pagesProcessed: { increment: 1 } as const, pageSequence: { increment: 1 } as const, phase: "LIST" as const,
      privatePendingNextPageToken: null, privatePendingHasMore: null, leaseOwner: null, leaseExpiresAt: null,
      nextAttemptAt: new Date(now.getTime() + config.HISTORY_SYNC_SUCCESS_SPACING_MS)
    };
    if (job.passKind === "HEAD") {
      await this.prisma.$transaction([
        this.prisma.historySyncJob.updateMany({ where: { id: job.id, leaseOwner }, data: {
          ...common, passKind: "BACKFILL", privateIncrementalPageToken: null, backfillPagesSinceHead: 0
        } }),
        this.prisma.auditEvent.create({ data: { shopId: job.shopId, eventType: "HISTORY_HEAD_RECONCILED", payload: { conversationsCompleted: job.conversationsCompleted } } })
      ]);
      return;
    }
    if (job.passKind === "BACKFILL") {
      if (hasMore && !nextToken) throw new TikTokApiError("MALFORMED_RESPONSE", "LIST_CONVERSATIONS", undefined, undefined, undefined, "Missing continuation cursor");
      if (hasMore) {
        const pagesSinceHead = job.backfillPagesSinceHead + 1;
        const runHead = pagesSinceHead >= config.HISTORY_SYNC_HEAD_EVERY_BACKFILL_PAGES;
        await this.prisma.historySyncJob.updateMany({ where: { id: job.id, leaseOwner }, data: {
          ...common, privateBackfillPageToken: nextToken,
          backfillPagesSinceHead: pagesSinceHead,
          ...(runHead ? { passKind: "HEAD", privateIncrementalPageToken: null } : {})
        } });
        await this.auditPage(job.shopId, job.pagesProcessed + 1, "BACKFILL");
        return;
      }
      await this.prisma.$transaction([
        this.prisma.historySyncJob.updateMany({ where: { id: job.id, leaseOwner }, data: {
          ...common, state: "COMPLETE", mode: "INCREMENTAL", passKind: "INCREMENTAL",
          privateBackfillPageToken: null, privateIncrementalPageToken: null,
          initialCompletedAt: job.initialCompletedAt ?? now, completedAt: now,
          nextAttemptAt: new Date(now.getTime() + config.HISTORY_SYNC_INCREMENTAL_INTERVAL_MS)
        } }),
        this.prisma.contactHistorySyncRun.create({ data: {
          shopId: job.shopId, source: SOURCE, state: "COMPLETE", cursor: Prisma.DbNull,
          conversationsScanned: job.conversationsCompleted, messagesImported: job.messagesImported,
          startedAt: job.startedAt ?? now, completedAt: now
        } }),
        this.prisma.auditEvent.create({ data: { shopId: job.shopId, eventType: "HISTORY_INITIAL_BACKFILL_COMPLETE", payload: {
          pagesProcessed: job.pagesProcessed + 1, conversationsCompleted: job.conversationsCompleted, messagesImported: job.messagesImported
        } } })
      ]);
      return;
    }
    const nextIndex = job.incrementalPageIndex + 1;
    if (hasMore && nextToken && nextIndex < config.HISTORY_SYNC_INCREMENTAL_PAGES) {
      await this.prisma.historySyncJob.updateMany({ where: { id: job.id, leaseOwner }, data: {
        ...common, privateIncrementalPageToken: nextToken, incrementalPageIndex: nextIndex
      } });
      return;
    }
    await this.prisma.$transaction([
      this.prisma.historySyncJob.updateMany({ where: { id: job.id, leaseOwner }, data: {
        ...common, state: "COMPLETE", passKind: "INCREMENTAL", privateIncrementalPageToken: null,
        incrementalPageIndex: 0, completedAt: now,
        nextAttemptAt: new Date(now.getTime() + config.HISTORY_SYNC_INCREMENTAL_INTERVAL_MS)
      } }),
      this.prisma.auditEvent.create({ data: { shopId: job.shopId, eventType: "HISTORY_INCREMENTAL_PASS_COMPLETE", payload: {
        pagesRead: nextIndex, conversationsCompleted: job.conversationsCompleted, messagesImported: job.messagesImported
      } } })
    ]);
  }

  private async auditPage(shopId: string, pagesProcessed: number, passKind: string) {
    if (pagesProcessed === 1 || pagesProcessed % 10 === 0) await this.prisma.auditEvent.create({
      data: { shopId, eventType: "HISTORY_PROVIDER_PAGE_COMPLETED", payload: { pagesProcessed, passKind } }
    });
  }

  private isCursorInvalid(job: any, error: unknown) {
    return error instanceof TikTokApiError && error.operation === "LIST_CONVERSATIONS" && Boolean(this.listCursor(job)) &&
      error.kind === "PROVIDER" && (error.httpStatus === 400 || error.providerCode === 100004 || error.providerCode === 11012003);
  }

  private async handleError(jobId: string, leaseOwner: string, error: unknown) {
    const now = this.now();
    const job = await this.prisma.historySyncJob.findFirst({ where: { id: jobId, leaseOwner } });
    if (!job) return;
    if (this.isCursorInvalid(job, error)) {
      await this.prisma.$transaction([
        this.prisma.historySyncConversationWork.deleteMany({ where: { historySyncJobId: job.id, pageSequence: job.pageSequence } }),
        this.prisma.historySyncJob.update({ where: { id: job.id }, data: {
          state: "QUEUED", passKind: job.mode === "INITIAL_BACKFILL" ? "BACKFILL" : "INCREMENTAL", phase: "LIST",
          privateBackfillPageToken: null, privateIncrementalPageToken: null, privatePendingNextPageToken: null,
          privatePendingHasMore: null, cursorRecoveryCount: { increment: 1 }, pageSequence: { increment: 1 },
          lastProviderCode: publicErrorCode(error as TikTokApiError), lastErrorCategory: "CURSOR_INVALID_RECOVERING",
          totalProviderRequests: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + 30_000), leaseOwner: null, leaseExpiresAt: null
        } }),
        this.prisma.auditEvent.create({ data: { shopId: job.shopId, eventType: "HISTORY_CURSOR_RECOVERY_STARTED", payload: { recoveryCount: job.cursorRecoveryCount + 1 } } })
      ]);
      return;
    }
    if (error instanceof TikTokApiError && (error.kind === "RATE_LIMIT" || error.kind === "TEMPORARY")) {
      const physical = !error.locallyBlocked;
      const count = job.consecutiveFailureCount + (physical ? 1 : 0);
      const exponential = Math.min(TEMPORARY_MAX_MS, TEMPORARY_BASE_MS * 2 ** Math.min(Math.max(0, count - 1), 20));
      const nextAttemptAt = error.nextPermittedAt ?? new Date(now.getTime() + Math.max(error.retryAfterMs ?? 0, exponential));
      await this.prisma.$transaction([
        this.prisma.historySyncJob.update({ where: { id: job.id }, data: {
          state: "BACKING_OFF", nextAttemptAt, consecutiveFailureCount: count,
          totalProviderRequests: physical ? { increment: 1 } : undefined,
          lastProviderCode: publicErrorCode(error), lastErrorCategory: error.kind,
          leaseOwner: null, leaseExpiresAt: null
        } }),
        this.prisma.auditEvent.create({ data: { shopId: job.shopId, eventType: "HISTORY_BACKOFF_ENTERED", payload: {
          category: error.kind, providerCode: publicErrorCode(error), nextAttemptAt: nextAttemptAt.toISOString()
        } } })
      ]);
      return;
    }
    const category = error instanceof TikTokApiError ? error.kind : "HISTORY_WORKER_FAILURE";
    const physical = error instanceof TikTokApiError && !error.locallyBlocked && (error.httpStatus != null || error.requestId != null);
    await this.prisma.$transaction([
      this.prisma.historySyncJob.update({ where: { id: job.id }, data: {
        state: "FAILED", lastErrorCategory: category,
        lastProviderCode: error instanceof TikTokApiError ? publicErrorCode(error) : null,
        totalProviderRequests: physical ? { increment: 1 } : undefined,
        nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null
      } }),
      this.prisma.auditEvent.create({ data: { shopId: job.shopId, eventType: "HISTORY_SYNC_FAILED", payload: { category } } })
    ]);
  }
}
