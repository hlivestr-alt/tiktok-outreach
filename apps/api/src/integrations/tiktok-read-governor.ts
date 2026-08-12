import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { TikTokApiError, type TikTokReadGovernorEvent, type TikTokReadLease, type TikTokReadRequestGovernor } from "@affiliate/tiktok-adapter";
import { PrismaService } from "../shared";
import { config } from "../shared";

const DEFAULT_SPACING_MS = 750;
const LEASE_MS = 120_000;

type GovernorOptions = { now?: () => Date; random?: () => number; spacingMs?: number; marketplaceSpacingMs?: number; leaseMs?: number; timezone?: string };

function safeDelay(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), 24 * 60 * 60_000);
}

function latestDate(...values: Array<Date | null | undefined>): Date | undefined {
  const dates = values.filter((value): value is Date => Boolean(value));
  return dates.length ? new Date(Math.max(...dates.map((value) => value.getTime()))) : undefined;
}

function leaseOperation(operation: TikTokReadLease["operation"]): string {
  if (operation === "GET_AUTHORIZED_SHOPS") return "__LEASE__:AUTHORIZED_SHOPS";
  if (operation === "SEARCH_CREATORS") return "__LEASE__:SEARCH_CREATORS";
  return "__LEASE__:SHOP_HISTORY_READS";
}

export function marketplaceBackoffMs(count: number, random = Math.random): number {
  const base = Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(Math.max(0, count - 1), 20));
  return Math.min(6 * 60 * 60_000, base + Math.floor(base * 0.2 * random()));
}

function spacingMs(operation: TikTokReadLease["operation"], options: GovernorOptions): number {
  return operation === "SEARCH_CREATORS"
    ? options.marketplaceSpacingMs ?? config.MARKETPLACE_SUCCESS_SPACING_MS
    : options.spacingMs ?? DEFAULT_SPACING_MS;
}

function nextLocalDay(now: Date, timezone: string): Date {
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  const nominalUtc = Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day) + 1);
  const localAtNominal = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(nominalUtc)).reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  const offset = Date.UTC(Number(localAtNominal.year), Number(localAtNominal.month) - 1, Number(localAtNominal.day), Number(localAtNominal.hour), Number(localAtNominal.minute), Number(localAtNominal.second)) - nominalUtc;
  return new Date(nominalUtc - offset + 5 * 60_000);
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
        spacingUntil: new Date(now.getTime() + spacingMs(input.operation, this.options))
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
    await this.prisma.providerReadThrottle.updateMany({
      where: { provider: lease.provider, shopScope: lease.shopScope, operation: lease.leaseOperation, leaseId: lease.leaseId },
      data: { spacingUntil: new Date(now.getTime() + spacingMs(lease.operation, this.options)) }
    });
    await this.release(lease);
  }

  async throttled(lease: TikTokReadLease, event: TikTokReadGovernorEvent): Promise<Date> {
    const current = await this.prisma.providerReadThrottle.findUniqueOrThrow({
      where: { provider_shopScope_operation: { provider: lease.provider, shopScope: lease.shopScope, operation: lease.operation } }
    });
    const count = current.consecutiveThrottleCount + 1;
    const exponential = lease.operation === "SEARCH_CREATORS"
      ? marketplaceBackoffMs(count, this.options.random)
      : Math.min(15 * 60_000, 5_000 * 2 ** Math.min(count - 1, 20));
    const retryAfterMs = safeDelay(event.retryAfterMs);
    const cooldownMs = Math.max(exponential, retryAfterMs ?? 0);
    const now = this.now();
    const nextPermittedAt = event.providerCode === 45101004
      ? nextLocalDay(now, this.options.timezone ?? config.SHOP_TIMEZONE)
      : new Date(now.getTime() + cooldownMs);
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
