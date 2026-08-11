import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { TikTokApiError, type TikTokReadGovernorEvent, type TikTokReadLease, type TikTokReadRequestGovernor } from "@affiliate/tiktok-adapter";
import { PrismaService } from "../shared";

const BASE_THROTTLE_MS = 5_000;
const MAX_THROTTLE_MS = 15 * 60_000;
const DEFAULT_SPACING_MS = 750;
const LEASE_MS = 120_000;

type GovernorOptions = { now?: () => Date; random?: () => number; spacingMs?: number; leaseMs?: number };

function safeDelay(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), 24 * 60 * 60_000);
}

function latestDate(...values: Array<Date | null | undefined>): Date | undefined {
  const dates = values.filter((value): value is Date => Boolean(value));
  return dates.length ? new Date(Math.max(...dates.map((value) => value.getTime()))) : undefined;
}

function leaseOperation(operation: TikTokReadLease["operation"]): string {
  return operation === "GET_AUTHORIZED_SHOPS" ? "__LEASE__:AUTHORIZED_SHOPS" : "__LEASE__:SHOP_READS";
}

@Injectable()
export class TikTokReadGovernor implements TikTokReadRequestGovernor {
  private readonly options: GovernorOptions;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject("TIKTOK_READ_GOVERNOR_OPTIONS") options?: GovernorOptions
  ) { this.options = options ?? {}; }

  private now(): Date { return this.options.now?.() ?? new Date(); }

  async acquire(input: Omit<TikTokReadLease, "leaseId" | "leaseOperation">): Promise<TikTokReadLease> {
    const now = this.now();
    const leaseId = randomBytes(18).toString("base64url");
    const operationState = await this.prisma.providerReadThrottle.upsert({
      where: { provider_shopScope_operation: { provider: input.provider, shopScope: input.shopScope, operation: input.operation } },
      update: {},
      create: { provider: input.provider, shopScope: input.shopScope, operation: input.operation }
    });
    if (operationState.nextPermittedAt && operationState.nextPermittedAt > now) {
      throw new TikTokApiError(
        "RATE_LIMIT", input.operation, 429, 36009002, operationState.lastProviderRequestId ?? undefined,
        "TikTok read operation is cooling down; no provider request was made", operationState.retryAfterMs ?? undefined,
        operationState.nextPermittedAt, true
      );
    }
    const groupOperation = leaseOperation(input.operation);
    const row = await this.prisma.providerReadThrottle.upsert({
      where: { provider_shopScope_operation: { provider: input.provider, shopScope: input.shopScope, operation: groupOperation } },
      update: {},
      create: { provider: input.provider, shopScope: input.shopScope, operation: groupOperation }
    });
    const claimed = await this.prisma.providerReadThrottle.updateMany({
      where: {
        id: row.id,
        AND: [
          { OR: [{ spacingUntil: null }, { spacingUntil: { lte: now } }] },
          { OR: [{ leaseId: null }, { leaseExpiresAt: { lte: now } }] }
        ]
      },
      data: {
        leaseId,
        leaseExpiresAt: new Date(now.getTime() + (this.options.leaseMs ?? LEASE_MS)),
        spacingUntil: new Date(now.getTime() + (this.options.spacingMs ?? DEFAULT_SPACING_MS))
      }
    });
    if (claimed.count === 1) return { ...input, leaseOperation: groupOperation, leaseId };

    const current = await this.prisma.providerReadThrottle.findUniqueOrThrow({ where: { id: row.id } });
    const next = latestDate(current.spacingUntil, current.leaseExpiresAt) ?? now;
    throw new TikTokApiError(
      "RATE_LIMIT", input.operation, 429, undefined, operationState.lastProviderRequestId ?? undefined,
      "TikTok read operation is already in flight or locally paced; no provider request was made",
      operationState.retryAfterMs ?? undefined, next, true
    );
  }

  async requestStarted(lease: TikTokReadLease): Promise<void> {
    const now = this.now();
    await this.prisma.$transaction([
      this.prisma.providerReadThrottle.updateMany({
        where: { provider: lease.provider, shopScope: lease.shopScope, operation: lease.operation },
        data: { lastRequestAt: now }
      }),
      this.prisma.providerReadThrottle.updateMany({
        where: { provider: lease.provider, shopScope: lease.shopScope, operation: lease.leaseOperation, leaseId: lease.leaseId },
        data: { leaseExpiresAt: new Date(now.getTime() + (this.options.leaseMs ?? LEASE_MS)) }
      })
    ]);
  }

  async succeeded(lease: TikTokReadLease, event: TikTokReadGovernorEvent): Promise<void> {
    const now = this.now();
    await this.prisma.providerReadThrottle.updateMany({
      where: { provider: lease.provider, shopScope: lease.shopScope, operation: lease.operation },
      data: {
        lastSuccessAt: now,
        consecutiveThrottleCount: 0,
        nextPermittedAt: null,
        retryAfterMs: null,
        lastProviderRequestId: event.requestId
      }
    });
    await this.release(lease);
  }

  async throttled(lease: TikTokReadLease, event: TikTokReadGovernorEvent): Promise<Date> {
    const current = await this.prisma.providerReadThrottle.findUniqueOrThrow({
      where: { provider_shopScope_operation: { provider: lease.provider, shopScope: lease.shopScope, operation: lease.operation } }
    });
    const count = current.consecutiveThrottleCount + 1;
    const exponential = Math.min(MAX_THROTTLE_MS, BASE_THROTTLE_MS * 2 ** Math.min(count - 1, 20));
    const jitter = Math.floor(exponential * 0.2 * (this.options.random?.() ?? Math.random()));
    const retryAfterMs = safeDelay(event.retryAfterMs);
    const cooldownMs = Math.max(exponential + jitter, retryAfterMs ?? 0);
    const now = this.now();
    const nextPermittedAt = new Date(now.getTime() + cooldownMs);
    await this.prisma.providerReadThrottle.updateMany({
      where: { id: current.id },
      data: {
        lastThrottleAt: now,
        consecutiveThrottleCount: count,
        nextPermittedAt,
        retryAfterMs,
        lastProviderRequestId: event.requestId
      }
    });
    await this.release(lease);
    return nextPermittedAt;
  }

  async release(lease: TikTokReadLease): Promise<void> {
    await this.prisma.providerReadThrottle.updateMany({
      where: { provider: lease.provider, shopScope: lease.shopScope, operation: lease.leaseOperation, leaseId: lease.leaseId },
      data: { leaseId: null, leaseExpiresAt: null }
    });
  }
}
