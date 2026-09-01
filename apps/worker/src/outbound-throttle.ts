import { randomUUID } from "node:crypto";
import { PrismaClient } from "@affiliate/db";

export type OutboundProviderOperation = "CREATE_CONVERSATION" | "SEND_MESSAGE";

const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const THROTTLE_BACKOFF_CAP_MS = 60_000;
const TRANSIENT_BACKOFF_CAP_MS = 30_000;
const JITTER_MAX_MS = 500;

function boundedRetryAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), MAX_RETRY_AFTER_MS)
    : undefined;
}

export function exponentialBackoffWithJitter(
  consecutiveFailures: number,
  retryAfterMs?: number,
  options: { baseMs?: number; capMs?: number; random?: () => number } = {}
): number {
  const baseMs = options.baseMs ?? 1_000;
  const capMs = options.capMs ?? THROTTLE_BACKOFF_CAP_MS;
  const random = options.random ?? Math.random;
  const exponent = Math.min(20, Math.max(0, consecutiveFailures - 1));
  const jitter = Math.floor(Math.max(0, Math.min(0.999999, random())) * (JITTER_MAX_MS + 1));
  const local = Math.min(capMs, baseMs * 2 ** exponent + jitter);
  return Math.max(local, boundedRetryAfter(retryAfterMs) ?? 0);
}

export function decreasedConcurrency(current: number): number {
  return Math.max(1, Math.floor(Math.max(1, current) / 2));
}

export function increasedConcurrency(
  current: number,
  technicalMax: number,
  healthySuccessCount: number
): { effectiveConcurrency: number; healthySuccessCount: number } {
  const safeCurrent = Math.max(1, Math.min(current, technicalMax));
  const nextCount = healthySuccessCount + 1;
  if (safeCurrent < technicalMax && nextCount >= safeCurrent) {
    return { effectiveConcurrency: safeCurrent + 1, healthySuccessCount: 0 };
  }
  return { effectiveConcurrency: safeCurrent, healthySuccessCount: nextCount };
}

type Permit = { id: string; limiterId: string; owner: string; operation: OutboundProviderOperation };
export type PermitResult =
  | { acquired: true; permit: Permit; effectiveConcurrency: number }
  | { acquired: false; delayMs: number; state: string; throttledUntil?: Date; quotaCode?: string };

type ResponseMeta = { httpStatus?: number; businessCode?: string };

export class OutboundProviderGovernor {
  constructor(private readonly prisma: PrismaClient, private readonly options: {
    provider: string;
    appScope: string;
    initialConcurrency: number;
    technicalMaxConcurrency: number;
    permitLeaseMs: number;
    sendMessageIntervalMs?: number;
    random?: () => number;
  }) {
    if (options.initialConcurrency > options.technicalMaxConcurrency) {
      throw new Error("OUTBOUND_PROVIDER_INITIAL_CONCURRENCY must not exceed OUTBOUND_PROVIDER_MAX_CONCURRENCY");
    }
  }

  private key(shopId: string, operation: OutboundProviderOperation): string {
    return `${this.options.provider}:${this.options.appScope}:${shopId}:${operation}`;
  }

  async acquire(shopId: string, operation: OutboundProviderOperation, owner: string = randomUUID(), now = new Date()): Promise<PermitResult> {
    return this.prisma.$transaction(async (tx) => {
      const key = this.key(shopId, operation);
      const isSendMessage = operation === "SEND_MESSAGE";
      const technicalMaxConcurrency = isSendMessage ? 1 : this.options.technicalMaxConcurrency;
      const initialConcurrency = isSendMessage ? 1 : this.options.initialConcurrency;
      const sendMessageIntervalMs = Math.max(1_000, this.options.sendMessageIntervalMs ?? 1_000);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outbound-provider:${key}`}))`;
      let limiter = await tx.providerOutboundLimiter.upsert({
        where: { provider_appScope_shopId_operation: { provider: this.options.provider, appScope: this.options.appScope, shopId, operation } },
        update: { technicalMaxConcurrency },
        create: {
          provider: this.options.provider, appScope: this.options.appScope, shopId, operation,
          effectiveConcurrency: initialConcurrency,
          technicalMaxConcurrency
        }
      });
      if (limiter.effectiveConcurrency > technicalMaxConcurrency) {
        limiter = await tx.providerOutboundLimiter.update({
          where: { id: limiter.id }, data: { effectiveConcurrency: technicalMaxConcurrency, healthySuccessCount: 0 }
        });
      }
      await tx.providerOutboundPermit.deleteMany({ where: { limiterId: limiter.id, expiresAt: { lte: now } } });
      if (limiter.state === "QUOTA_BLOCKED") {
        return { acquired: false as const, delayMs: 60_000, state: limiter.state, quotaCode: limiter.quotaCode ?? undefined };
      }
      if (limiter.nextPermittedAt && limiter.nextPermittedAt > now) {
        return {
          acquired: false as const,
          delayMs: Math.max(25, limiter.nextPermittedAt.getTime() - now.getTime()),
          state: limiter.state,
          throttledUntil: limiter.nextPermittedAt
        };
      }
      if (limiter.state !== "HEALTHY" && limiter.nextPermittedAt && limiter.nextPermittedAt <= now) {
        limiter = await tx.providerOutboundLimiter.update({
          where: { id: limiter.id },
          data: { state: "RECOVERING", nextPermittedAt: null, retryAfterMs: null }
        });
      }
      if (isSendMessage && limiter.lastRequestAt) {
        const nextSendAdmissionAt = new Date(limiter.lastRequestAt.getTime() + sendMessageIntervalMs);
        if (nextSendAdmissionAt > now) {
          return {
            acquired: false as const,
            delayMs: nextSendAdmissionAt.getTime() - now.getTime(),
            state: limiter.state,
            throttledUntil: nextSendAdmissionAt
          };
        }
      }
      const active = await tx.providerOutboundPermit.count({ where: { limiterId: limiter.id } });
      if (active >= limiter.effectiveConcurrency) {
        const earliest = await tx.providerOutboundPermit.findFirst({
          where: { limiterId: limiter.id }, orderBy: { expiresAt: "asc" }, select: { expiresAt: true }
        });
        const untilExpiry = earliest ? earliest.expiresAt.getTime() - now.getTime() : 100;
        return { acquired: false as const, delayMs: Math.max(25, Math.min(250, untilExpiry)), state: limiter.state };
      }
      const permit = await tx.providerOutboundPermit.create({ data: {
        limiterId: limiter.id, owner, expiresAt: new Date(now.getTime() + this.options.permitLeaseMs)
      } });
      await Promise.all([
        tx.providerOutboundLimiter.update({ where: { id: limiter.id }, data: { lastRequestAt: now } }),
        tx.providerOutboundEvent.create({ data: { limiterId: limiter.id, outcome: "ATTEMPT", occurredAt: now } })
      ]);
      return { acquired: true as const, permit: { id: permit.id, limiterId: limiter.id, owner, operation }, effectiveConcurrency: limiter.effectiveConcurrency };
    }, { maxWait: 10_000, timeout: 10_000 });
  }

  async waitForPermit(shopId: string, operation: OutboundProviderOperation, owner: string): Promise<Permit> {
    for (;;) {
      const result = await this.acquire(shopId, operation, owner);
      if (result.acquired) return result.permit;
      if (result.state === "QUOTA_BLOCKED") throw new ProviderQuotaBlockedError(result.quotaCode ?? "PROVIDER_IM_QUOTA");
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, result.delayMs)));
    }
  }

  async healthy(permit: Permit, outcome: "ACCEPTED" | "RESTRICTED", meta: ResponseMeta = {}, now = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outbound-provider-limiter:${permit.limiterId}`}))`;
      const limiter = await tx.providerOutboundLimiter.findUniqueOrThrow({ where: { id: permit.limiterId } });
      const ramp = increasedConcurrency(limiter.effectiveConcurrency, limiter.technicalMaxConcurrency, limiter.healthySuccessCount);
      await Promise.all([
        tx.providerOutboundPermit.deleteMany({ where: { id: permit.id, owner: permit.owner } }),
        tx.providerOutboundLimiter.update({ where: { id: limiter.id }, data: {
          state: ramp.effectiveConcurrency >= limiter.technicalMaxConcurrency ? "HEALTHY" : limiter.state === "HEALTHY" ? "HEALTHY" : "RECOVERING",
          effectiveConcurrency: ramp.effectiveConcurrency,
          healthySuccessCount: ramp.healthySuccessCount,
          consecutiveThrottleCount: 0,
          consecutiveFailureCount: 0,
          nextPermittedAt: null,
          retryAfterMs: null,
          lastSuccessAt: now,
          lastHttpStatus: meta.httpStatus,
          lastBusinessCode: meta.businessCode
        } }),
        tx.providerOutboundEvent.create({ data: { limiterId: limiter.id, outcome, httpStatus: meta.httpStatus, businessCode: meta.businessCode, occurredAt: now } })
      ]);
    }, { maxWait: 10_000, timeout: 10_000 });
  }

  async throttle(permit: Permit, meta: ResponseMeta & { retryAfterMs?: number }, now = new Date()): Promise<{ delayMs: number; effectiveConcurrency: number; nextPermittedAt: Date }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outbound-provider-limiter:${permit.limiterId}`}))`;
      const limiter = await tx.providerOutboundLimiter.findUniqueOrThrow({ where: { id: permit.limiterId } });
      const consecutive = limiter.consecutiveThrottleCount + 1;
      const delayMs = exponentialBackoffWithJitter(consecutive, meta.retryAfterMs, { random: this.options.random });
      const candidate = new Date(now.getTime() + delayMs);
      const nextPermittedAt = limiter.nextPermittedAt && limiter.nextPermittedAt > candidate ? limiter.nextPermittedAt : candidate;
      const effectiveConcurrency = decreasedConcurrency(limiter.effectiveConcurrency);
      await Promise.all([
        tx.providerOutboundPermit.deleteMany({ where: { id: permit.id, owner: permit.owner } }),
        tx.providerOutboundLimiter.update({ where: { id: limiter.id }, data: {
          state: "THROTTLED", effectiveConcurrency, healthySuccessCount: 0,
          consecutiveThrottleCount: consecutive, consecutiveFailureCount: 0,
          nextPermittedAt, lastThrottleAt: now, retryAfterMs: boundedRetryAfter(meta.retryAfterMs),
          lastHttpStatus: meta.httpStatus, lastBusinessCode: meta.businessCode
        } }),
        tx.providerOutboundEvent.create({ data: { limiterId: limiter.id, outcome: "THROTTLED", httpStatus: meta.httpStatus, businessCode: meta.businessCode, occurredAt: now } })
      ]);
      return { delayMs, effectiveConcurrency, nextPermittedAt };
    }, { maxWait: 10_000, timeout: 10_000 });
  }

  async transientFailure(permit: Permit, meta: ResponseMeta, now = new Date()): Promise<{ delayMs: number; nextPermittedAt: Date }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outbound-provider-limiter:${permit.limiterId}`}))`;
      const limiter = await tx.providerOutboundLimiter.findUniqueOrThrow({ where: { id: permit.limiterId } });
      const consecutive = limiter.consecutiveFailureCount + 1;
      const delayMs = exponentialBackoffWithJitter(consecutive, undefined, { baseMs: 1_000, capMs: TRANSIENT_BACKOFF_CAP_MS, random: this.options.random });
      const candidate = new Date(now.getTime() + delayMs);
      const nextPermittedAt = limiter.nextPermittedAt && limiter.nextPermittedAt > candidate ? limiter.nextPermittedAt : candidate;
      await Promise.all([
        tx.providerOutboundPermit.deleteMany({ where: { id: permit.id, owner: permit.owner } }),
        tx.providerOutboundLimiter.update({ where: { id: limiter.id }, data: {
          state: "TRANSIENT_BACKOFF", consecutiveFailureCount: consecutive,
          nextPermittedAt, lastHttpStatus: meta.httpStatus, lastBusinessCode: meta.businessCode
        } }),
        tx.providerOutboundEvent.create({ data: { limiterId: limiter.id, outcome: "TRANSIENT", httpStatus: meta.httpStatus, businessCode: meta.businessCode, occurredAt: now } })
      ]);
      return { delayMs, nextPermittedAt };
    }, { maxWait: 10_000, timeout: 10_000 });
  }

  async quotaBlocked(permit: Permit, code: string, detail: string, meta: ResponseMeta = {}, now = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outbound-provider-limiter:${permit.limiterId}`}))`;
      await Promise.all([
        tx.providerOutboundPermit.deleteMany({ where: { id: permit.id, owner: permit.owner } }),
        tx.providerOutboundLimiter.update({ where: { id: permit.limiterId }, data: {
          state: "QUOTA_BLOCKED", healthySuccessCount: 0, nextPermittedAt: null,
          quotaBlockedAt: now, quotaCode: code, quotaDetail: detail,
          lastHttpStatus: meta.httpStatus, lastBusinessCode: code
        } }),
        tx.providerOutboundEvent.create({ data: { limiterId: permit.limiterId, outcome: "QUOTA_BLOCKED", httpStatus: meta.httpStatus, businessCode: code, occurredAt: now } })
      ]);
    }, { maxWait: 10_000, timeout: 10_000 });
  }

  async release(permit: Permit, outcome = "UNKNOWN", meta: ResponseMeta = {}, now = new Date()): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.providerOutboundPermit.deleteMany({ where: { id: permit.id, owner: permit.owner } }),
      this.prisma.providerOutboundLimiter.update({ where: { id: permit.limiterId }, data: { lastHttpStatus: meta.httpStatus, lastBusinessCode: meta.businessCode } }),
      this.prisma.providerOutboundEvent.create({ data: { limiterId: permit.limiterId, outcome, httpStatus: meta.httpStatus, businessCode: meta.businessCode, occurredAt: now } })
    ]);
  }
}

export class ProviderQuotaBlockedError extends Error {
  constructor(readonly providerCode: string) { super(`Provider quota is blocked: ${providerCode}`); }
}

export const isProviderThrottle = (httpStatus?: number, businessCode?: string | number): boolean =>
  httpStatus === 429 || String(businessCode ?? "") === "36009002";
