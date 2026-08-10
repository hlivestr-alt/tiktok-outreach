import { createHash } from "node:crypto";
import { DelayedError, Job, Queue, Worker } from "bullmq";
import { lockCreatorEligibility, Prisma, PrismaClient } from "@affiliate/db";
import { loadConfig } from "@affiliate/config";
import { reconcileUnknownDelivery } from "@affiliate/domain";
import { MockTikTokAffiliateAdapter } from "@affiliate/tiktok-adapter";
import { reserveDispatchSlot, SafetyDelay } from "./dispatch-safety";
import { deliveryAction, recoverDispatchingDelivery } from "./delivery-policy";

const config = loadConfig();
const redisUrl = new URL(config.REDIS_URL);
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), password: redisUrl.password || undefined };
const prisma = new PrismaClient();
const adapter = new MockTikTokAffiliateAdapter();
const queue = new Queue("outreach", { connection });
const reconciliationDelays = config.MOCK_RECONCILIATION_DELAYS_MS.split(",").map(Number);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function maintenanceSweep(): Promise<void> {
  const now = new Date();
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
    include: { delivery: true }, take: 250
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
      await prisma.queueOutbox.update({ where: { id: entry.id }, data: { state: "ENQUEUED", enqueuedAt: new Date(), enqueueAttempts: { increment: 1 }, lastError: null } });
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

async function markDeliveryUnknown(recipient: any, attemptId: string, requestId: string | undefined, detail: string) {
  await prisma.$transaction(async (tx) => {
    await lockCreatorEligibility(tx, recipient.campaign.shopId, [recipient.creatorId]);
    await tx.deliveryAttempt.update({ where: { id: attemptId }, data: {
      outcome: "DELIVERY_UNKNOWN", providerRequestId: requestId, providerCode: "DELIVERY_UNKNOWN", completedAt: new Date()
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
  const unfinished = await prisma.campaignRecipient.count({ where: { campaignId, selected: true, state: { in: ["RESERVED", "QUEUED", "PROCESSING", "DELIVERY_UNKNOWN"] } } });
  if (unfinished) return;
  const failures = await prisma.campaignRecipient.count({ where: { campaignId, selected: true, state: { in: ["FAILED", "DELIVERY_UNKNOWN_UNRESOLVED"] } } });
  await prisma.campaign.update({ where: { id: campaignId }, data: { state: failures ? "COMPLETED_WITH_ERRORS" : "COMPLETED" } });
}

async function processSend(job: Job<{ recipientId: string }>) {
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
  let claim: Awaited<ReturnType<typeof reserveDispatchSlot>>;
  try { claim = await reserveDispatchSlot(prisma, recipient); }
  catch (error) { if (error instanceof SafetyDelay) return delayJob(job, error.delayMs); throw error; }
  if (!claim.claimed) {
    if (claim.cancelled) await completeCampaignIfDone(recipient.campaignId);
    return;
  }

  const attemptNumber = claim.attemptNumber;
  const attempt = await prisma.deliveryAttempt.create({ data: { deliveryId: recipient.delivery.id, attemptNumber, outcome: "STARTED", startedAt: new Date() } });
  let providerConversation: Awaited<ReturnType<typeof adapter.createOrGetConversation>>;
  let conversation: { id: string };
  try {
    providerConversation = await adapter.createOrGetConversation(recipient.creator.creatorOpenId);
    conversation = await prisma.conversation.upsert({
      where: { externalConversationId: providerConversation.conversationId }, update: {},
      create: { shopId: recipient.campaign.shopId, creatorId: recipient.creatorId, externalConversationId: providerConversation.conversationId }
    });
    await prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: { conversationId: conversation.id } });
    recipient.delivery.conversationId = conversation.id;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Provider conversation setup failed";
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: {
      outcome: finalAttempt ? "FAILED_TERMINAL" : "FAILED_RETRYABLE", providerCode: "CONVERSATION_SETUP_FAILED", completedAt: new Date()
    } });
    if (finalAttempt) {
      await markTerminalFailure(recipient, "CONVERSATION_SETUP_FAILED", detail);
      await completeCampaignIfDone(recipient.campaignId);
      return;
    }
    await prisma.$transaction([
      prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
        state: "FAILED_RETRYABLE", lastErrorCode: "CONVERSATION_SETUP_FAILED", lastErrorDetail: detail
      } }),
      prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "QUEUED" } })
    ]);
    throw error;
  }
  let result: Awaited<ReturnType<typeof adapter.sendMessage>>;
  try {
    result = await adapter.sendMessage(providerConversation.conversationId, recipient.creator.creatorOpenId, recipient.frozenMessage, {
      idempotencyKey: recipient.delivery.deterministicKey
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network outcome was not observable";
    await markDeliveryUnknown(recipient, attempt.id, undefined, detail);
    await completeCampaignIfDone(recipient.campaignId);
    return;
  }
  if (result.status === "SENT") {
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: { outcome: "SENT", providerRequestId: result.requestId, completedAt: new Date() } });
    await markSent(recipient, conversation.id, result.messageId, result.requestId);
  } else if (result.status === "DELIVERY_UNKNOWN") {
    await markDeliveryUnknown(recipient, attempt.id, result.requestId, "Provider response did not establish whether the message was accepted");
    const numeric = Number(recipient.creator.creatorOpenId.slice(-5));
    if (numeric % 74 === 0) {
      await prisma.conversationMessage.create({ data: {
        conversationId: conversation.id, externalMessageId: `mock_reconciled_${recipient.delivery.id}`, direction: "OUTBOUND",
        content: recipient.frozenMessage, contentHash: recipient.contentHash, providerCreatedAt: new Date(), importSource: "MOCK_PROVIDER_RECONCILIATION"
      }});
    }
  } else if (result.status === "RESTRICTED") {
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: {
      outcome: "FAILED_TERMINAL", providerRequestId: result.requestId, providerCode: result.errorCode, completedAt: new Date()
    } });
    await markTerminalFailure(recipient, result.errorCode, "Creator cannot receive affiliate messages");
  } else {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await prisma.deliveryAttempt.update({ where: { id: attempt.id }, data: {
      outcome: finalAttempt ? "FAILED_TERMINAL" : "FAILED_RETRYABLE", providerRequestId: result.requestId,
      providerCode: result.errorCode, completedAt: new Date()
    } });
    if (finalAttempt) {
      await markTerminalFailure(recipient, result.errorCode, "Retry budget exhausted without a confirmed dispatch");
    } else {
      await prisma.$transaction([
        prisma.outreachDelivery.update({ where: { id: recipient.delivery.id }, data: {
          state: "FAILED_RETRYABLE", lastErrorCode: result.errorCode, lastErrorDetail: `Retry after ${result.retryAfterMs}ms`
        } }),
        prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { state: "QUEUED" } })
      ]);
      throw new Error(result.errorCode);
    }
  }
  await completeCampaignIfDone(recipient.campaignId);
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
  concurrency: 4,
  limiter: { max: config.MAX_DISPATCHES_PER_MINUTE, duration: 60_000 }
});

worker.on("failed", (job, error) => console.error("Outreach job failed", { jobId: job?.id, error: error.message }));
worker.on("error", (error) => console.error("Worker error", { error: error.message }));
void maintenanceSweep().catch((error) => console.error("Worker maintenance sweep failed", error));
const maintenanceTimer = setInterval(() => void maintenanceSweep().catch((error) => console.error("Worker maintenance sweep failed", error)), 5_000);
maintenanceTimer.unref();
console.log("Mock outreach worker ready", { mode: config.APP_MODE, outboundProvider: "mock-only" });

async function shutdown() {
  clearInterval(maintenanceTimer);
  await worker.close();
  await queue.close();
  await prisma.$disconnect();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
