import { createHash, randomUUID } from "node:crypto";
import { DelayedError, Job, Queue, Worker } from "bullmq";
import { lockCreatorEligibility, Prisma, PrismaClient } from "@affiliate/db";
import { configuredOutboundCapability, loadConfig } from "@affiliate/config";
import type { TikTokOutboundAdapter } from "@affiliate/contracts";
import { reconcileUnknownDelivery } from "@affiliate/domain";
import { decryptTikTokToken, MockTikTokAffiliateAdapter, RealTikTokOutboundAdapter, TikTokOutboundError } from "@affiliate/tiktok-adapter";
import { reserveDispatchSlot } from "./dispatch-safety";
import { deliveryAction, recoverDispatchingDelivery } from "./delivery-policy";
import { allFrozenRecipientsTerminal, campaignCompletionSummary } from "./campaign-completion";
import { isProviderThrottle, OutboundProviderGovernor } from "./outbound-throttle";

const config = loadConfig();
const redisUrl = new URL(config.REDIS_URL);
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), password: redisUrl.password || undefined };
const prisma = new PrismaClient();
const workerInstanceId = randomUUID();
const providerAppScope = createHash("sha256").update(config.TIKTOK_APP_KEY ?? "mock-outbound-app").digest("hex").slice(0, 24);
const providerGovernor = new OutboundProviderGovernor(prisma, {
  provider: "TIKTOK_SHOP",
  appScope: providerAppScope,
  initialConcurrency: config.OUTBOUND_PROVIDER_INITIAL_CONCURRENCY,
  technicalMaxConcurrency: config.OUTBOUND_PROVIDER_MAX_CONCURRENCY,
  permitLeaseMs: config.OUTBOUND_PROVIDER_PERMIT_LEASE_MS,
  sendMessageIntervalMs: config.OUTBOUND_SEND_MESSAGE_INTERVAL_MS
});
function required(name: "TIKTOK_APP_KEY" | "TIKTOK_APP_SECRET" | "TIKTOK_TOKEN_ENCRYPTION_KEY"): string {
  const value = config[name];
  if (!value) throw new Error(`LIVE_OUTBOUND_NOT_CONFIGURED: ${name} is required`);
  return value;
}
const disabledOutbound: TikTokOutboundAdapter = {
  createOrGetConversation: async () => { throw new Error("OUTBOUND_DISABLED"); },
  sendMessage: async () => { throw new Error("OUTBOUND_DISABLED"); }
};
const adapter: TikTokOutboundAdapter = config.OUTBOUND_MODE === "mock" ? new MockTikTokAffiliateAdapter()
  : config.OUTBOUND_MODE === "live" ? new RealTikTokOutboundAdapter({
    baseUrl: config.TIKTOK_API_BASE_URL, appKey: required("TIKTOK_APP_KEY"), appSecret: required("TIKTOK_APP_SECRET"),
    shopCipher: async () => {
      const shop = await prisma.shop.findFirst({ where: { connectionMode: "READ_ONLY", selectedForReadOnly: true }, select: { shopCipher: true } });
      if (!shop?.shopCipher) throw new Error("LIVE_OUTBOUND_NOT_CONFIGURED: selected shop cipher is unavailable");
      return shop.shopCipher;
    },
    accessToken: async () => {
      const shop = await prisma.shop.findFirst({ where: { connectionMode: "READ_ONLY", selectedForReadOnly: true }, select: { id: true } });
      if (!shop) throw new Error("LIVE_OUTBOUND_NOT_CONFIGURED: selected shop is unavailable");
      const connection = await prisma.integrationConnection.findUnique({ where: { shopId_provider: { shopId: shop.id, provider: "TIKTOK_SHOP" } } });
      if (!connection?.accessTokenCiphertext || connection.status !== "HEALTHY" || !connection.accessTokenExpiresAt || connection.accessTokenExpiresAt <= new Date()) {
        throw new TikTokOutboundError("AUTH", "CREATE_CONVERSATION", undefined, undefined, "A healthy unexpired TikTok access token is required");
      }
      return decryptTikTokToken(connection.accessTokenCiphertext, required("TIKTOK_TOKEN_ENCRYPTION_KEY"));
    }
  }) : disabledOutbound;
const queue = new Queue("outreach", { connection });
const reconciliationDelays = config.MOCK_RECONCILIATION_DELAYS_MS.split(",").map(Number);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function publishHeartbeat(status: "RUNNING" | "STOPPED"): Promise<void> {
  const now = new Date();
  const since = new Date(now.getTime() - 60_000);
  await prisma.providerOutboundLimiter.updateMany({
    where: {
      appScope: providerAppScope, operation: "SEND_MESSAGE",
      OR: [{ effectiveConcurrency: { not: 1 } }, { technicalMaxConcurrency: { not: 1 } }]
    },
    data: { effectiveConcurrency: 1, technicalMaxConcurrency: 1, healthySuccessCount: 0 }
  });
  const [limiters, attemptsLastMinute, acceptedLastMinute, throttlesLastMinute, queueDepth] = await Promise.all([
    prisma.providerOutboundLimiter.findMany({ where: { appScope: providerAppScope }, select: {
      shopId: true, operation: true, state: true, effectiveConcurrency: true, technicalMaxConcurrency: true,
      nextPermittedAt: true, lastHttpStatus: true, lastBusinessCode: true, consecutiveThrottleCount: true, quotaCode: true
    } }),
    prisma.providerOutboundEvent.count({ where: { occurredAt: { gt: since }, outcome: "ATTEMPT", limiter: { appScope: providerAppScope } } }),
    prisma.providerOutboundEvent.count({ where: { occurredAt: { gt: since }, outcome: "ACCEPTED", limiter: { appScope: providerAppScope, operation: "SEND_MESSAGE" } } }),
    prisma.providerOutboundEvent.count({ where: { occurredAt: { gt: since }, outcome: "THROTTLED", limiter: { appScope: providerAppScope } } }),
    queue.getJobCounts("waiting", "active", "delayed", "prioritized")
  ]);
  const metadata = {
    ...configuredOutboundCapability(config),
    outboundMode: config.OUTBOUND_MODE,
    sendMessageMinIntervalMs: config.OUTBOUND_SEND_MESSAGE_INTERVAL_MS,
    sendMessageMaxPerSecond: 1,
    acceptedSendsPerMinute: acceptedLastMinute,
    providerAttemptsPerMinute: attemptsLastMinute,
    recentThrottles: throttlesLastMinute,
    queueDepth: Object.values(queueDepth).reduce((sum, count) => sum + count, 0),
    limiters
  };
  await prisma.workerHeartbeat.upsert({
    where: { role: "outbound-worker" },
    update: { instanceId: workerInstanceId, status, lastSeenAt: now, metadata },
    create: { role: "outbound-worker", instanceId: workerInstanceId, status, startedAt: now, lastSeenAt: now, metadata }
  });
  console.log(JSON.stringify({ level: "info", worker: "outbound-worker", event: "provider_runtime", ...metadata }));
}

async function maintenanceSweep(): Promise<void> {
  const now = new Date();
  await prisma.queueOutbox.updateMany({
    where: {
      state: { in: ["PENDING", "ENQUEUED"] },
      delivery: { state: { in: ["SENT", "RESTRICTED", "FAILED_TERMINAL", "DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN_UNRESOLVED", "CANCELLED"] } }
    },
    data: { state: "COMPLETED", lastError: null }
  });
  await prisma.$transaction(async (tx) => {
    const expired = await tx.campaign.findMany({ where: { state: "FROZEN", freezeExpiresAt: { lte: now } }, select: { id: true, shopId: true } });
    for (const campaign of expired) {
      const changed = await tx.campaign.updateMany({ where: { id: campaign.id, state: "FROZEN", freezeExpiresAt: { lte: now } }, data: { state: "PREVIEW_EXPIRED", version: { increment: 1 } } });
      if (!changed.count) continue;
      await tx.outreachReservation.deleteMany({ where: { recipient: { campaignId: campaign.id } } });
      await tx.campaignRecipient.updateMany({ where: { campaignId: campaign.id, state: "RESERVED" }, data: { state: "SELECTED", frozenMessage: null, contentHash: null } });
      await tx.auditEvent.create({ data: { shopId: campaign.shopId, campaignId: campaign.id, eventType: "CAMPAIGN_FREEZE_EXPIRED", payload: { expiredAt: now.toISOString(), reservationsReleased: true } } });
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  const recipients = await prisma.campaignRecipient.findMany({
    where: { state: "QUEUED", delivery: { isNot: null }, campaign: { state: { in: ["QUEUED", "RUNNING"] } } },
    include: { delivery: true }, take: config.OUTBOUND_QUEUE_RECONCILE_BATCH_SIZE
  });
  for (const recipient of recipients) {
    if (!recipient.delivery) continue;
    const entry = await prisma.queueOutbox.upsert({
      where: { recipientId: recipient.id }, update: {},
      create: { campaignId: recipient.campaignId, deliveryId: recipient.delivery.id, recipientId: recipient.id, deterministicJobId: `send-${recipient.id}` }
    });
    if (!["PENDING", "ENQUEUED"].includes(entry.state)) continue;
    try {
      const existing = await queue.getJob(entry.deterministicJobId);
      if (existing) {
        const state = await existing.getState();
        if (state === "completed" || state === "failed") await existing.remove();
        else continue;
      }
      await queue.add("send", { recipientId: recipient.id }, { jobId: entry.deterministicJobId, attempts: 4, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 1000 });
      await prisma.queueOutbox.updateMany({
        where: { id: entry.id, state: { in: ["PENDING", "ENQUEUED"] }, delivery: { recipient: { state: "QUEUED" } } },
        data: { state: "ENQUEUED", enqueuedAt: new Date(), enqueueAttempts: { increment: 1 }, lastError: null }
      });
    } catch (error) {
      await prisma.queueOutbox.update({ where: { id: entry.id }, data: { state: "PENDING", enqueueAttempts: { increment: 1 }, lastError: error instanceof Error ? error.message : "Queue reconciliation failed" } });
    }
  }
}

async function delayJob(job: Job, delayMs: number): Promise<never> {
  if (!job.token) throw new Error("Active job has no token");
  await job.moveToDelayed(Date.now() + delayMs, job.token);
  throw new DelayedError();
}

async function waitForSendPermitWhileCampaignActive(recipient: any, attemptNumber: number) {
  for (;;) {
    const result = await providerGovernor.acquire(
      recipient.campaign.shopId,
      "SEND_MESSAGE",
      `${workerInstanceId}:${recipient.delivery.id}:${attemptNumber}:send`
    );
    if (result.acquired) return result.permit;
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: recipient.campaignId }, select: { state: true } });
    if (!["QUEUED", "RUNNING"].includes(campaign.state)) return undefined;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, result.delayMs)));
  }
}

async function markSent(recipient: any, conversationId: string, externalMessageId: string, requestId?: string) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await lockCreatorEligibility(tx, recipient.campaign.shopId, [recipient.creatorId]);
    const previous = await tx.creatorShopContactState.findUnique({ where: { shopId_creatorId: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId } } });
    await tx.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: { state: "SENT", conversationId, externalMessageId, providerRequestId: requestId, sentAt: now } });
    await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "SENT" } });
    const [otherUnknownDeliveries, historicalUnknownFacts] = await Promise.all([
      tx.outreachDelivery.count({ where: {
        id: { not: recipient.delivery.id }, state: { in: ["DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN_UNRESOLVED"] },
        recipient: { creatorId: recipient.creatorId }, campaign: { shopId: recipient.campaign.shopId }
      } }),
      tx.historicalContactFact.count({ where: {
        shopId: recipient.campaign.shopId, creatorOpenId: recipient.creator.creatorOpenId,
        sendStatus: "UNKNOWN", resolutionState: "MATCHED"
      } })
    ]);
    const unresolvedDelivery = otherUnknownDeliveries > 0 || historicalUnknownFacts > 0;
    await tx.creatorShopContactState.upsert({
      where: { shopId_creatorId: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId } },
      update: { firstContactedAt: previous?.firstContactedAt ?? now, lastContactedAt: now, contactCount: { increment: 1 }, lastCampaignId: recipient.campaignId, lastDeliveryId: recipient.delivery.id, unresolvedDelivery },
      create: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId, firstContactedAt: now, lastContactedAt: now, contactCount: 1, lastCampaignId: recipient.campaignId, lastDeliveryId: recipient.delivery.id, unresolvedDelivery }
    });
    await tx.outreachReservation.deleteMany({ where: { campaignRecipientId: recipient.id } });
    await tx.queueOutbox.updateMany({ where: { recipientId: recipient.id }, data: { state: "COMPLETED" } });
  });
}

async function scheduleReconciliation(deliveryId: string, attemptNumber: number) {
  const delay = reconciliationDelays[Math.min(attemptNumber - 1, reconciliationDelays.length - 1)] ?? 300_000;
  const scheduledFor = new Date(Date.now() + delay);
  await prisma.deliveryReconciliationRun.upsert({
    where: { deliveryId_attemptNumber: { deliveryId, attemptNumber } }, update: { scheduledFor },
    create: { deliveryId, attemptNumber, scheduledFor }
  });
  await queue.add("reconcile", { deliveryId, attemptNumber }, { jobId: `reconcile-${deliveryId}-${attemptNumber}`, delay, removeOnComplete: 1000 });
}

async function markTerminalFailure(recipient: any, errorCode: string, errorDetail: string) {
  await prisma.$transaction([
    prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
      state: "FAILED_TERMINAL", lastErrorCode: errorCode, lastErrorDetail: errorDetail
    } }),
    prisma.campaignRecipient.update({ where: { id: recipient.id }, data: {
      state: "FAILED", skipReason: errorCode, skipDetail: errorDetail
    } }),
    prisma.outreachReservation.deleteMany({ where: { campaignRecipientId: recipient.id } }),
    prisma.queueOutbox.updateMany({ where: { recipientId: recipient.id }, data: { state: "COMPLETED" } })
  ]);
}

async function markDeliveryUnknown(recipient: any, attemptId: string, requestId: string | undefined, detail: string, httpStatus?: number) {
  await prisma.$transaction(async (tx) => {
    await lockCreatorEligibility(tx, recipient.campaign.shopId, [recipient.creatorId]);
    await tx.deliveryAttempt.update({ where: { id: attemptId }, data: {
      outcome: "DELIVERY_UNKNOWN", providerRequestId: requestId, providerCode: "DELIVERY_UNKNOWN", providerHttpStatus: httpStatus, completedAt: new Date()
    } });
    await tx.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
      state: "DELIVERY_UNKNOWN", providerRequestId: requestId, lastErrorCode: "DELIVERY_UNKNOWN", lastErrorDetail: detail
    } });
    await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "DELIVERY_UNKNOWN" } });
    await tx.creatorShopContactState.upsert({
      where: { shopId_creatorId: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId } },
      update: { unresolvedDelivery: true, lastDeliveryId: recipient.delivery.id },
      create: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId, unresolvedDelivery: true, lastDeliveryId: recipient.delivery.id }
    });
    await tx.queueOutbox.updateMany({ where: { recipientId: recipient.id }, data: { state: "COMPLETED" } });
  });
  await scheduleReconciliation(recipient.delivery.id, 1);
}

async function completeCampaignIfDone(campaignId: string) {
  const recipients = await prisma.campaignRecipient.findMany({
    where: { campaignId, selected: true, frozenMessage: { not: null } }, select: { state: true }
  });
  if (!allFrozenRecipientsTerminal(recipients.map((recipient) => recipient.state))) return;
  const completion = campaignCompletionSummary(recipients.map((recipient) => recipient.state));
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { state: true, summary: true } });
  if (campaign.state === "CANCELLED") return;
  const previous = campaign.summary && typeof campaign.summary === "object" && !Array.isArray(campaign.summary) ? campaign.summary as Record<string, unknown> : {};
  await prisma.campaign.update({ where: { id: campaignId }, data: {
    state: completion.completedSuccessfully ? "COMPLETED" : "COMPLETED_WITH_ERRORS",
    summary: { ...previous, completion } as Prisma.InputJsonValue
  } });
}

async function markRestricted(recipient: any, errorCode: string) {
  await prisma.$transaction([
    prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: { state: "RESTRICTED", lastErrorCode: errorCode, lastErrorDetail: "Creator is not currently messageable" } }),
    prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "RESTRICTED", skipReason: errorCode, skipDetail: "Creator is not currently messageable" } }),
    prisma.outreachReservation.deleteMany({ where: { campaignRecipientId: recipient.id } }),
    prisma.queueOutbox.updateMany({ where: { recipientId: recipient.id }, data: { state: "COMPLETED" } })
  ]);
}

async function pauseShopForProviderFailure(recipient: any, error: TikTokOutboundError) {
  const reason = `TikTok ${error.kind.toLowerCase()} failure paused outbound; operator action is required`;
  await prisma.$transaction([
    prisma.campaign.updateMany({ where: { shopId: recipient.campaign.shopId, state: { in: ["QUEUED", "RUNNING"] } }, data: { state: "SAFETY_PAUSED", safetyPauseReason: reason, version: { increment: 1 } } }),
    prisma.queueOutbox.updateMany({ where: { campaign: { shopId: recipient.campaign.shopId }, state: { in: ["PENDING", "ENQUEUED"] } }, data: { state: "SAFETY_PAUSED", lastError: reason } }),
    prisma.auditEvent.create({ data: { shopId: recipient.campaign.shopId, campaignId: recipient.campaignId, eventType: "OUTBOUND_PROVIDER_SAFETY_PAUSED", payload: { kind: error.kind, providerCode: error.providerCode, requestId: error.requestId } } })
  ]);
}

async function pauseShopForProviderQuota(recipient: any, errorCode: string, operation: "CREATE_CONVERSATION" | "SEND_MESSAGE") {
  const reason = `TikTok outbound IM quota ${errorCode} blocked outbound; provider recovery or operator action is required`;
  await prisma.$transaction([
    prisma.campaign.updateMany({ where: { shopId: recipient.campaign.shopId, state: { in: ["QUEUED", "RUNNING"] } }, data: { state: "SAFETY_PAUSED", safetyPauseReason: reason, version: { increment: 1 } } }),
    prisma.queueOutbox.updateMany({ where: { campaign: { shopId: recipient.campaign.shopId }, state: { in: ["PENDING", "ENQUEUED"] } }, data: { state: "SAFETY_PAUSED", lastError: reason } }),
    prisma.auditEvent.create({ data: {
      shopId: recipient.campaign.shopId, campaignId: recipient.campaignId,
      eventType: "OUTBOUND_PROVIDER_IM_QUOTA_BLOCKED", payload: { providerCode: errorCode, operation }
    } })
  ]);
}

async function makeDeliveryRetryable(recipient: any, errorCode: string, errorDetail: string) {
  await prisma.$transaction([
    prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
      state: "FAILED_RETRYABLE", lastErrorCode: errorCode, lastErrorDetail: errorDetail
    } }),
    prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "QUEUED" } })
  ]);
}

async function processSend(job: Job<{ recipientId: string }>) {
  if (!configuredOutboundCapability(config).mutationCapability) throw new Error("OUTBOUND_DISABLED: worker dispatch is unavailable");
  const recipient = await prisma.campaignRecipient.findUnique({
    where: { id: job.data.recipientId },
    include: { creator: true, campaign: { include: { shop: true } }, delivery: true, reservation: true }
  });
  if (!recipient?.delivery || !recipient.frozenMessage || !recipient.contentHash) return;
  const action = deliveryAction(recipient.delivery.state);
  if (action === "SKIP") return;
  if (action === "RECOVER_AS_UNKNOWN") {
    await recoverDispatchingDelivery(prisma, recipient);
    await scheduleReconciliation(recipient.delivery.id, 1);
    return;
  }
  if (["PAUSE_REQUESTED", "PAUSED"].includes(recipient.campaign.state)) {
    if (recipient.campaign.state === "PAUSE_REQUESTED") await prisma.campaign.update({ where: { id: recipient.campaignId }, data: { state: "PAUSED" } });
    return delayJob(job, 5000);
  }
  if (recipient.campaign.state === "SAFETY_PAUSED") return;
  const creatorOpenId = recipient.creatorOpenIdSnapshot;
  if (!creatorOpenId) {
    await markTerminalFailure(recipient, "INVALID_MESSAGING_ID", "Creator has no Marketplace Open ID");
    await completeCampaignIfDone(recipient.campaignId);
    return;
  }
  const createPermitResult = await providerGovernor.acquire(
    recipient.campaign.shopId,
    "CREATE_CONVERSATION",
    `${workerInstanceId}:${recipient.delivery.id}:${recipient.delivery.attemptCount + 1}:create`
  );
  if (!createPermitResult.acquired) return delayJob(job, createPermitResult.delayMs);
  const createPermit = createPermitResult.permit;
  let createPermitSettled = false;
  let sendPermit: Awaited<ReturnType<typeof providerGovernor.waitForPermit>> | undefined;
  let sendPermitSettled = false;
  let claim: Awaited<ReturnType<typeof reserveDispatchSlot>>;
  try { claim = await reserveDispatchSlot(prisma, recipient); }
  catch (error) {
    await providerGovernor.release(createPermit, "NOT_DISPATCHED");
    createPermitSettled = true;
    throw error;
  }
  if (!claim.claimed) {
    await providerGovernor.release(createPermit, "NOT_DISPATCHED");
    createPermitSettled = true;
    if (claim.cancelled) await completeCampaignIfDone(recipient.campaignId);
    return;
  }

  try {
  const attemptNumber = claim.attemptNumber;
  const attempt = await prisma.deliveryAttempt.create({ data: { deliveryId: recipient.delivery.id, attemptNumber, outcome: "STARTED", startedAt: new Date() } });
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  let providerConversation: Awaited<ReturnType<typeof adapter.createOrGetConversation>>;
  let conversation: { id: string };
  try {
    providerConversation = await adapter.createOrGetConversation(creatorOpenId);
    await providerGovernor.healthy(createPermit, "ACCEPTED", { businessCode: "0" });
    createPermitSettled = true;
  } catch (error) {
    const providerCode = error instanceof TikTokOutboundError ? String(error.providerCode ?? error.kind) : "CONVERSATION_SETUP_FAILED";
    const meta = error instanceof TikTokOutboundError ? { httpStatus: error.httpStatus, businessCode: providerCode } : {};
    if (error instanceof TikTokOutboundError && error.kind === "QUOTA") {
      await providerGovernor.quotaBlocked(createPermit, providerCode, "TikTok reported that the shop has reached its IM quota", meta);
      createPermitSettled = true;
      await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "FAILED_RETRYABLE", providerCode, providerHttpStatus: error.httpStatus, providerRequestId: error.requestId, completedAt: new Date() } });
      await makeDeliveryRetryable(recipient, providerCode, "Provider shop IM quota is blocked");
      await pauseShopForProviderQuota(recipient, providerCode, "CREATE_CONVERSATION");
      return;
    }
    if (error instanceof TikTokOutboundError && ["AUTH", "PERMISSION"].includes(error.kind)) {
      await providerGovernor.release(createPermit, "AUTH_OR_PERMISSION", meta);
      createPermitSettled = true;
      await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "FAILED_RETRYABLE", providerCode, providerHttpStatus: error.httpStatus, providerRequestId: error.requestId, completedAt: new Date() } });
      await makeDeliveryRetryable(recipient, providerCode, "Provider authorization or permission requires operator action");
      await pauseShopForProviderFailure(recipient, error);
      return;
    }
    if (error instanceof TikTokOutboundError && error.kind === "RESTRICTED") {
      await providerGovernor.healthy(createPermit, "RESTRICTED", meta);
      createPermitSettled = true;
      await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "FAILED_TERMINAL", providerCode: String(error.providerCode ?? "RESTRICTED"), providerHttpStatus: error.httpStatus, providerRequestId: error.requestId, completedAt: new Date() } });
      await markRestricted(recipient, String(error.providerCode ?? "RESTRICTED"));
      await completeCampaignIfDone(recipient.campaignId);
      return;
    }
    const detail = error instanceof Error ? error.message : "Provider conversation setup failed";
    let providerDelayMs: number | undefined;
    if (error instanceof TikTokOutboundError && error.kind === "RETRYABLE" && isProviderThrottle(error.httpStatus, error.providerCode)) {
      const throttle = await providerGovernor.throttle(createPermit, { ...meta, retryAfterMs: error.retryAfterMs });
      createPermitSettled = true;
      providerDelayMs = throttle.delayMs;
    } else if (!(error instanceof TikTokOutboundError) || error.kind === "RETRYABLE") {
      const transient = await providerGovernor.transientFailure(createPermit, meta);
      createPermitSettled = true;
      providerDelayMs = transient.delayMs;
    } else {
      await providerGovernor.healthy(createPermit, "RESTRICTED", meta);
      createPermitSettled = true;
    }
    const throttled = error instanceof TikTokOutboundError && error.kind === "RETRYABLE" && isProviderThrottle(error.httpStatus, error.providerCode);
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: {
      outcome: throttled || !finalAttempt ? "FAILED_RETRYABLE" : "FAILED_TERMINAL",
      providerCode,
      providerHttpStatus: error instanceof TikTokOutboundError ? error.httpStatus : undefined,
      providerRequestId: error instanceof TikTokOutboundError ? error.requestId : undefined, completedAt: new Date()
    } });
    if (!throttled && finalAttempt) {
      await markTerminalFailure(recipient, "CONVERSATION_SETUP_FAILED", detail);
      await completeCampaignIfDone(recipient.campaignId);
      return;
    }
    await makeDeliveryRetryable(recipient, providerCode, detail);
    if (throttled) return delayJob(job, providerDelayMs ?? 1_000);
    throw error;
  }
  try {
    conversation = await prisma.conversation.upsert({
      where: { externalConversationId: providerConversation.conversationId }, update: {},
      create: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId, externalConversationId: providerConversation.conversationId }
    });
    await prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: { conversationId: conversation.id } });
    recipient.delivery.conversationId = conversation.id;
  } catch (error) {
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "FAILED_RETRYABLE", providerCode: "LOCAL_CONVERSATION_PERSISTENCE_FAILED", completedAt: new Date() } });
    await makeDeliveryRetryable(recipient, "LOCAL_CONVERSATION_PERSISTENCE_FAILED", "Conversation persistence failed before Send Message was attempted");
    throw error;
  }
  sendPermit = await waitForSendPermitWhileCampaignActive(recipient, attemptNumber);
  if (!sendPermit) {
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "FAILED_RETRYABLE", providerCode: "CAMPAIGN_PAUSED_BEFORE_SEND", completedAt: new Date() } });
    await makeDeliveryRetryable(recipient, "CAMPAIGN_PAUSED_BEFORE_SEND", "Campaign paused before Send Message acquired a provider permit");
    await prisma.campaign.updateMany({ where: { id: recipient.campaignId, state: "PAUSE_REQUESTED" }, data: { state: "PAUSED" } });
    return;
  }
  let result: Awaited<ReturnType<typeof adapter.sendMessage>>;
  try {
    result = await adapter.sendMessage(providerConversation.conversationId, creatorOpenId, recipient.frozenMessage, {
      idempotencyKey: recipient.delivery.deterministicKey
    });
  } catch (error) {
    if (error instanceof TikTokOutboundError && ["AUTH", "PERMISSION"].includes(error.kind)) {
      await providerGovernor.release(sendPermit, "AUTH_OR_PERMISSION", { httpStatus: error.httpStatus, businessCode: String(error.providerCode ?? error.kind) });
      sendPermitSettled = true;
      await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "FAILED_RETRYABLE", providerCode: String(error.providerCode ?? error.kind), providerHttpStatus: error.httpStatus, providerRequestId: error.requestId, completedAt: new Date() } });
      await makeDeliveryRetryable(recipient, String(error.providerCode ?? error.kind), "Provider authorization or permission requires operator action");
      await pauseShopForProviderFailure(recipient, error);
      return;
    }
    if (error instanceof TikTokOutboundError && error.kind === "QUOTA") {
      const code = String(error.providerCode ?? "PROVIDER_IM_QUOTA");
      await providerGovernor.quotaBlocked(sendPermit, code, "TikTok reported a shop IM quota", { httpStatus: error.httpStatus, businessCode: code });
      sendPermitSettled = true;
      await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "FAILED_RETRYABLE", providerCode: code, providerHttpStatus: error.httpStatus, providerRequestId: error.requestId, completedAt: new Date() } });
      await makeDeliveryRetryable(recipient, code, "Provider shop IM quota is blocked");
      await pauseShopForProviderQuota(recipient, code, "SEND_MESSAGE");
      return;
    }
    if (error instanceof TikTokOutboundError) {
      await providerGovernor.healthy(sendPermit, "RESTRICTED", { httpStatus: error.httpStatus, businessCode: String(error.providerCode ?? error.kind) });
      sendPermitSettled = true;
      await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "FAILED_TERMINAL", providerCode: String(error.providerCode ?? error.kind), providerHttpStatus: error.httpStatus, providerRequestId: error.requestId, completedAt: new Date() } });
      await markTerminalFailure(recipient, String(error.providerCode ?? error.kind), "TikTok definitively rejected the message request");
      await completeCampaignIfDone(recipient.campaignId);
      return;
    }
    const detail = error instanceof Error ? error.message : "Network outcome was not observable";
    await providerGovernor.release(sendPermit, "DELIVERY_UNKNOWN");
    sendPermitSettled = true;
    await markDeliveryUnknown(recipient, attempt.id, undefined, detail);
    await completeCampaignIfDone(recipient.campaignId);
    return;
  }
  if (result.status === "SENT") {
    await providerGovernor.healthy(sendPermit, "ACCEPTED", { httpStatus: result.httpStatus, businessCode: "0" });
    sendPermitSettled = true;
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "SENT", providerCode: "0", providerHttpStatus: result.httpStatus, providerRequestId: result.requestId, completedAt: new Date() } });
    await markSent(recipient, conversation.id, result.messageId, result.requestId);
  } else if (result.status === "DELIVERY_UNKNOWN") {
    await providerGovernor.release(sendPermit, "DELIVERY_UNKNOWN", { httpStatus: result.httpStatus });
    sendPermitSettled = true;
    await markDeliveryUnknown(recipient, attempt.id, result.requestId, "Provider response did not establish whether the message was accepted", result.httpStatus);
    const numeric = Number(creatorOpenId.slice(-5));
    if (config.OUTBOUND_MODE === "mock" && numeric % 74 === 0) {
      await prisma.conversationMessage.create({ data: {
        conversationId: conversation.id, externalMessageId: `mock_reconciled_${recipient.delivery.id}`, direction: "OUTBOUND",
        content: recipient.frozenMessage, contentHash: recipient.contentHash, providerCreatedAt: new Date(), importSource: "MOCK_PROVIDER_RECONCILIATION"
      }});
    }
  } else if (result.status === "RESTRICTED") {
    await providerGovernor.healthy(sendPermit, "RESTRICTED", { httpStatus: result.httpStatus, businessCode: result.errorCode });
    sendPermitSettled = true;
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: {
      outcome: "FAILED_TERMINAL", providerRequestId: result.requestId, providerCode: result.errorCode, providerHttpStatus: result.httpStatus, completedAt: new Date()
    } });
    await markRestricted(recipient, result.errorCode);
  } else if (result.status === "QUOTA_LIMITED") {
    await providerGovernor.quotaBlocked(sendPermit, result.errorCode, "TikTok reported that outbound IM quota is blocked", { httpStatus: result.httpStatus, businessCode: result.errorCode });
    sendPermitSettled = true;
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: {
      outcome: "FAILED_RETRYABLE", providerRequestId: result.requestId, providerCode: result.errorCode,
      providerHttpStatus: result.httpStatus, completedAt: new Date()
    } });
    await makeDeliveryRetryable(recipient, result.errorCode, "Provider shop IM quota is blocked");
    await pauseShopForProviderQuota(recipient, result.errorCode, "SEND_MESSAGE");
    return;
  } else {
    const throttled = isProviderThrottle(result.httpStatus, result.errorCode);
    const providerDelay = throttled
      ? await providerGovernor.throttle(sendPermit, { httpStatus: result.httpStatus, businessCode: result.errorCode, retryAfterMs: result.retryAfterMs })
      : await providerGovernor.transientFailure(sendPermit, { httpStatus: result.httpStatus, businessCode: result.errorCode });
    sendPermitSettled = true;
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: {
      outcome: throttled || !finalAttempt ? "FAILED_RETRYABLE" : "FAILED_TERMINAL", providerRequestId: result.requestId,
      providerCode: result.errorCode, providerHttpStatus: result.httpStatus, completedAt: new Date()
    } });
    if (!throttled && finalAttempt) {
      await markTerminalFailure(recipient, result.errorCode, "Retry budget exhausted without a confirmed dispatch");
    } else {
      await makeDeliveryRetryable(recipient, result.errorCode, `Provider retry scheduled after ${providerDelay.delayMs}ms`);
      if (throttled) return delayJob(job, providerDelay.delayMs);
      throw new Error(result.errorCode);
    }
  }
  await completeCampaignIfDone(recipient.campaignId);
  } finally {
    if (!createPermitSettled) await providerGovernor.release(createPermit, "LOCAL_FAILURE").catch(() => undefined);
    if (sendPermit && !sendPermitSettled) await providerGovernor.release(sendPermit, "LOCAL_FAILURE").catch(() => undefined);
  }
}

async function processReconciliation(job: Job<{ deliveryId: string; attemptNumber: number }>) {
  const delivery = await prisma.outreachDelivery.findUnique({
    where: { id: job.data.deliveryId },
    include: { conversation: { include: { messages: true } }, recipient: { include: { creator: true, campaign: { include: { shop: true } } } } }
  });
  if (!delivery || delivery.state !== "DELIVERY_UNKNOWN" || !delivery.conversation || !delivery.firstDispatchedAt) return;
  const linked = await prisma.outreachDelivery.findMany({ where: { externalMessageId: { not: null } }, select: { externalMessageId: true } });
  const result = reconcileUnknownDelivery({
    conversationId: delivery.conversation.externalConversationId,
    contentHash: delivery.contentHash,
    dispatchedAt: delivery.firstDispatchedAt,
    alreadyLinkedMessageIds: new Set(linked.flatMap((item) => item.externalMessageId ? [item.externalMessageId] : [])),
    messages: delivery.conversation.messages.map((message) => ({
      id: message.externalMessageId, conversationId: delivery.conversation!.externalConversationId,
      direction: message.direction, contentHash: message.contentHash, createdAt: message.providerCreatedAt
    }))
  });
  if (result.status === "MATCHED") {
    await prisma.deliveryReconciliationRun.update({ where: { deliveryId_attemptNumber: { deliveryId: delivery.id, attemptNumber: job.data.attemptNumber } }, data: { state: "MATCHED", matchedMessageId: result.messageId, completedAt: new Date(), evidence: { exactContentHash: true, uniqueMatch: true } } });
    await markSent({ ...delivery.recipient, delivery, campaign: delivery.recipient.campaign }, delivery.conversation.id, result.messageId, "mock-reconciliation");
  } else if (job.data.attemptNumber < 3) {
    await prisma.deliveryReconciliationRun.update({ where: { deliveryId_attemptNumber: { deliveryId: delivery.id, attemptNumber: job.data.attemptNumber } }, data: { state: "UNRESOLVED", completedAt: new Date(), evidence: { reason: result.reason } } });
    await scheduleReconciliation(delivery.id, job.data.attemptNumber + 1);
  } else {
    await prisma.$transaction([
      prisma.deliveryReconciliationRun.update({ where: { deliveryId_attemptNumber: { deliveryId: delivery.id, attemptNumber: job.data.attemptNumber } }, data: { state: "UNRESOLVED", completedAt: new Date(), evidence: { reason: result.reason } } }),
      prisma.outreachDelivery.update({ where: { id: delivery.id }, data: { state: "DELIVERY_UNKNOWN_UNRESOLVED", lastErrorDetail: result.reason } }),
      prisma.campaignRecipient.update({ where: { id: delivery.campaignRecipientId }, data: { state: "DELIVERY_UNKNOWN_UNRESOLVED" } }),
      prisma.outreachReservation.deleteMany({ where: { campaignRecipientId: delivery.campaignRecipientId } })
    ]);
  }
  await completeCampaignIfDone(delivery.campaignId);
}

const worker = new Worker("outreach", async (job) => {
  if (job.name === "reconcile") return processReconciliation(job as Job<{ deliveryId: string; attemptNumber: number }>);
  return processSend(job as Job<{ recipientId: string }>);
}, {
  connection,
  concurrency: config.OUTBOUND_WORKER_CONCURRENCY
});

worker.on("failed", (job, error) => console.error(JSON.stringify({ level: "error", worker: "outbound-worker", event: "job_failed", jobId: job?.id, error: error.message })));
worker.on("error", (error) => console.error(JSON.stringify({ level: "error", worker: "outbound-worker", event: "worker_error", error: error.message })));
void maintenanceSweep().catch((error) => console.error(JSON.stringify({ level: "error", worker: "outbound-worker", event: "maintenance_failed", error: error instanceof Error ? error.message : "unknown" })));
const maintenanceTimer = setInterval(() => void maintenanceSweep().catch((error) => console.error(JSON.stringify({ level: "error", worker: "outbound-worker", event: "maintenance_failed", error: error instanceof Error ? error.message : "unknown" }))), config.OUTBOUND_QUEUE_POLL_INTERVAL_MS);
maintenanceTimer.unref();
void publishHeartbeat("RUNNING").catch((error) => console.error(JSON.stringify({ level: "error", worker: "outbound-worker", event: "heartbeat_failed", error: error instanceof Error ? error.message : "unknown" })));
const heartbeatTimer = setInterval(() => void publishHeartbeat("RUNNING").catch((error) => console.error(JSON.stringify({ level: "error", worker: "outbound-worker", event: "heartbeat_failed", error: error instanceof Error ? error.message : "unknown" }))), config.WORKER_HEARTBEAT_INTERVAL_MS ?? 15_000);
heartbeatTimer.unref();
console.log(JSON.stringify({
  level: "info", worker: "outbound-worker", event: "ready", appMode: config.APP_MODE, outboundMode: config.OUTBOUND_MODE,
  workerConcurrency: config.OUTBOUND_WORKER_CONCURRENCY,
  providerInitialConcurrency: config.OUTBOUND_PROVIDER_INITIAL_CONCURRENCY,
  providerTechnicalMaxConcurrency: config.OUTBOUND_PROVIDER_MAX_CONCURRENCY,
  sendMessageMinIntervalMs: config.OUTBOUND_SEND_MESSAGE_INTERVAL_MS,
  queuePollIntervalMs: config.OUTBOUND_QUEUE_POLL_INTERVAL_MS, queueReconcileBatchSize: config.OUTBOUND_QUEUE_RECONCILE_BATCH_SIZE
}));

async function shutdown() {
  clearInterval(maintenanceTimer);
  clearInterval(heartbeatTimer);
  await worker.close();
  await queue.close();
  await publishHeartbeat("STOPPED").catch(() => undefined);
  await prisma.$disconnect();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
