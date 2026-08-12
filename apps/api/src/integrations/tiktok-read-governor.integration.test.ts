import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@affiliate/db";
import { TikTokApiError, TikTokReadOnlyBoundaryError, TikTokReadOnlyHttpClient, type TikTokReadOperation } from "@affiliate/tiktok-adapter";
import { TikTokApiExceptionFilter } from "./tiktok-api-exception.filter";
import { marketplaceBackoffMs, TikTokReadGovernor } from "./tiktok-read-governor";

const prisma = new PrismaClient();
const prefix = `rate_limit_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
let serial = 0;
let nowMs = Date.now();
const scope = (suffix = "shop") => `${prefix}_${suffix}_${serial++}`;
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const rawResponse = (body: string, status: number, headers: Record<string, string> = {}) => new Response(body, { status, headers });

function governor() {
  return new TikTokReadGovernor(prisma as any, { now: () => new Date(nowMs), random: () => 0, spacingMs: 0, marketplaceSpacingMs: 1000, leaseMs: 30_000 });
}

function client(fetcher: typeof fetch, readGovernor = governor(), validationMode = false) {
  return new TikTokReadOnlyHttpClient({
    baseUrl: "https://provider.example.test", appKey: "outreach-app", appSecret: "outreach-secret",
    fetch: fetcher, governor: readGovernor, validationMode, sleep: async () => undefined, random: () => 0
  });
}

function request(http: TikTokReadOnlyHttpClient, shopScope: string, operation: TikTokReadOperation = "SEARCH_CREATORS") {
  const paths: Record<TikTokReadOperation, { method: "GET" | "POST"; path: string }> = {
    GET_AUTHORIZED_SHOPS: { method: "GET", path: "/authorization/202309/shops" },
    SEARCH_CREATORS: { method: "POST", path: "/affiliate_seller/202508/marketplace_creators/search" },
    GET_CREATOR_PERFORMANCE: { method: "GET", path: "/affiliate_seller/202508/marketplace_creators/creator-open" },
    LIST_CONVERSATIONS: { method: "GET", path: "/affiliate_seller/202412/conversations" },
    LIST_MESSAGES: { method: "GET", path: "/affiliate_seller/202412/conversation/conversation-id/messages" }
  };
  return http.requestRaw({ ...paths[operation], operation, accessToken: "access-token-must-not-persist", shopScope, query: { shop_cipher: "shop-cipher-must-not-persist" } });
}

async function throttleOnce(shopScope: string, retryAfter?: string) {
  const fetcher = vi.fn(async () => response({ code: 36009002, message: "dynamic quota", request_id: "safe-request-id" }, 429, retryAfter ? { "retry-after": retryAfter } : {}));
  await expect(request(client(fetcher as typeof fetch), shopScope)).rejects.toMatchObject({ kind: "RATE_LIMIT" });
  return { fetcher, row: await prisma.providerReadThrottle.findUniqueOrThrow({ where: { provider_shopScope_operation: { provider: "TIKTOK_SHOP", shopScope, operation: "SEARCH_CREATORS" } } }) };
}

beforeEach(() => { nowMs += 60_000; });
afterAll(async () => {
  await prisma.providerReadThrottle.deleteMany({ where: { shopScope: { startsWith: prefix } } });
  await prisma.$disconnect();
});

describe.sequential("durable TikTok read governor", () => {
  it("uses conservative bounded Marketplace cooldowns", () => {
    expect([1, 2, 3, 4].map((count) => marketplaceBackoffMs(count, () => 0))).toEqual([15, 30, 60, 120].map((minutes) => minutes * 60_000));
    expect(marketplaceBackoffMs(1, () => 1)).toBe(18 * 60_000);
    expect(marketplaceBackoffMs(20, () => 1)).toBe(6 * 60 * 60_000);
  });
  it("persists Marketplace throttle state after HTTP 429 / 36009002", async () => {
    const { row } = await throttleOnce(scope());
    expect(row).toMatchObject({ provider: "TIKTOK_SHOP", operation: "SEARCH_CREATORS", consecutiveThrottleCount: 1, lastProviderRequestId: "safe-request-id" });
    expect(row.lastThrottleAt).toEqual(new Date(nowMs));
    expect(row.nextPermittedAt!.getTime()).toBeGreaterThan(nowMs);
  });

  it("blocks an immediate second request locally with zero additional provider calls", async () => {
    const shop = scope(); const { fetcher } = await throttleOnce(shop);
    await expect(request(client(fetcher as typeof fetch), shop)).rejects.toMatchObject({ kind: "RATE_LIMIT", locallyBlocked: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("survives creation of a new governor/service instance", async () => {
    const shop = scope(); await throttleOnce(shop);
    const freshFetch = vi.fn(async () => response({ code: 0 }));
    await expect(request(client(freshFetch as typeof fetch, governor()), shop)).rejects.toMatchObject({ locallyBlocked: true });
    expect(freshFetch).not.toHaveBeenCalled();
  });

  it("does not block a different shop", async () => {
    const first = scope("shop_a"), second = scope("shop_b"); await throttleOnce(first);
    const fetcher = vi.fn(async () => response({ code: 0, request_id: "other-shop" }));
    await expect(request(client(fetcher as typeof fetch), second)).resolves.toMatchObject({ code: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("paces successful Marketplace requests from completion by at least the configured floor", async () => {
    const shop = scope(); const fetcher = vi.fn(async () => response({ code: 0, request_id: "success" }));
    await request(client(fetcher as typeof fetch), shop);
    const lane = await prisma.providerReadThrottle.findUniqueOrThrow({ where: { provider_shopScope_operation: { provider: "TIKTOK_SHOP", shopScope: shop, operation: "__LEASE__:SEARCH_CREATORS" } } });
    expect(lane.spacingUntil!.getTime()).toBe(nowMs + 1000);
    await expect(request(client(fetcher as typeof fetch), shop)).rejects.toMatchObject({ locallyBlocked: true });
    nowMs += 1000;
    await expect(request(client(fetcher as typeof fetch), shop)).resolves.toMatchObject({ code: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps different operation buckets independent", async () => {
    const shop = scope(); await throttleOnce(shop);
    const fetcher = vi.fn(async () => response({ code: 0, request_id: "performance-ok" }));
    await expect(request(client(fetcher as typeof fetch), shop, "GET_CREATOR_PERFORMANCE")).resolves.toMatchObject({ code: 0 });
  });

  it("honors a valid Retry-After value", async () => {
    const { row } = await throttleOnce(scope(), "7200");
    expect(row.retryAfterMs).toBe(7_200_000);
    expect(row.nextPermittedAt!.getTime()).toBeGreaterThanOrEqual(nowMs + 7_200_000);
  });

  it("holds daily Marketplace quota until the next shop-local day plus a safety margin", async () => {
    const shop = scope(); const fetcher = vi.fn(async () => response({ code: 45101004, message: "daily quota", request_id: "daily" }, 429));
    await expect(request(client(fetcher as typeof fetch), shop)).rejects.toMatchObject({ kind: "RATE_LIMIT", providerCode: 45101004 });
    const row = await prisma.providerReadThrottle.findUniqueOrThrow({ where: { provider_shopScope_operation: { provider: "TIKTOK_SHOP", shopScope: shop, operation: "SEARCH_CREATORS" } } });
    expect(row.nextPermittedAt!.getTime()).toBeGreaterThan(nowMs + 5 * 60_000);
    expect(row.nextPermittedAt!.getUTCHours()).toBe(17);
    expect(row.nextPermittedAt!.getUTCMinutes()).toBe(5);
  });

  it("persists a throttle for HTTP 429 with malformed JSON and never exposes the body", async () => {
    const shop = scope();
    const fetcher = vi.fn(async () => rawResponse("raw-secret-truncated{", 429, { "retry-after": "45", "x-tts-request-id": "header-request-id" }));
    let caught: unknown;
    try { await request(client(fetcher as typeof fetch), shop); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ kind: "RATE_LIMIT", httpStatus: 429, providerCode: undefined, requestId: "header-request-id", retryAfterMs: 45_000 });
    expect(JSON.stringify(caught)).not.toContain("raw-secret-truncated");
    const row = await prisma.providerReadThrottle.findUniqueOrThrow({ where: { provider_shopScope_operation: { provider: "TIKTOK_SHOP", shopScope: shop, operation: "SEARCH_CREATORS" } } });
    expect(row).toMatchObject({ consecutiveThrottleCount: 1, retryAfterMs: 45_000, lastProviderRequestId: "header-request-id", leaseId: null });
    expect(row.nextPermittedAt!.getTime()).toBeGreaterThanOrEqual(nowMs + 45_000);
    expect(JSON.stringify(row)).not.toContain("raw-secret-truncated");
    await expect(request(client(fetcher as typeof fetch), shop)).rejects.toMatchObject({ kind: "RATE_LIMIT", locallyBlocked: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("persists a throttle for HTTP 429 with an empty body", async () => {
    const shop = scope();
    const fetcher = vi.fn(async () => rawResponse("", 429));
    await expect(request(client(fetcher as typeof fetch), shop)).rejects.toMatchObject({ kind: "RATE_LIMIT", httpStatus: 429 });
    expect(await prisma.providerReadThrottle.findUniqueOrThrow({ where: { provider_shopScope_operation: { provider: "TIKTOK_SHOP", shopScope: shop, operation: "SEARCH_CREATORS" } } }))
      .toMatchObject({ consecutiveThrottleCount: 1, leaseId: null });
  });

  it("increases exponential cooldown after repeated 429s", async () => {
    const shop = scope(); const first = await throttleOnce(shop);
    const firstDelay = first.row.nextPermittedAt!.getTime() - nowMs;
    nowMs = first.row.nextPermittedAt!.getTime() + 1;
    const second = await throttleOnce(shop);
    expect(second.row.consecutiveThrottleCount).toBe(2);
    expect(second.row.nextPermittedAt!.getTime() - nowMs).toBeGreaterThan(firstDelay);
  });

  it("clears provider cooldown and consecutive count after success", async () => {
    const shop = scope(); const throttled = await throttleOnce(shop);
    nowMs = throttled.row.nextPermittedAt!.getTime() + 1;
    const fetcher = vi.fn(async () => response({ code: 0, request_id: "success-id" }));
    await request(client(fetcher as typeof fetch), shop);
    const row = await prisma.providerReadThrottle.findUniqueOrThrow({ where: { provider_shopScope_operation: { provider: "TIKTOK_SHOP", shopScope: shop, operation: "SEARCH_CREATORS" } } });
    expect(row).toMatchObject({ consecutiveThrottleCount: 0, nextPermittedAt: null, retryAfterMs: null, lastProviderRequestId: "success-id" });
    expect(row.lastSuccessAt).toEqual(new Date(nowMs));
  });

  it("performs exactly one physical request in controlled-validation mode", async () => {
    const fetcher = vi.fn(async () => response({ code: 36009003, message: "temporary" }, 503));
    await expect(request(client(fetcher as typeof fetch, governor(), true), scope())).rejects.toMatchObject({ kind: "TEMPORARY" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("prevents concurrent Marketplace calls for the same shop from bursting", async () => {
    const shop = scope(); let resolveFirst!: (value: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetcher = vi.fn(() => firstResponse);
    const http = client(fetcher as typeof fetch);
    const first = request(http, shop);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await expect(request(client(fetcher as typeof fetch, governor()), shop)).rejects.toMatchObject({ locallyBlocked: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveFirst(response({ code: 0, request_id: "first-ok" }));
    await expect(first).resolves.toMatchObject({ code: 0 });
  });

  it("isolates Marketplace cooldown from Conversation List and Message History", async () => {
    const shop = scope(); await throttleOnce(shop);
    const historyGovernor = governor();
    const conversationLease = await historyGovernor.acquire({ provider: "TIKTOK_SHOP", shopScope: shop, operation: "LIST_CONVERSATIONS" });
    await historyGovernor.release(conversationLease);
    nowMs += 751;
    const messageLease = await historyGovernor.acquire({ provider: "TIKTOK_SHOP", shopScope: shop, operation: "LIST_MESSAGES" });
    await historyGovernor.release(messageLease);
    await expect(historyGovernor.acquire({ provider: "TIKTOK_SHOP", shopScope: shop, operation: "SEARCH_CREATORS" })).rejects.toMatchObject({ locallyBlocked: true });
  });

  it("stores and returns no access token, cipher, app secret, headers, or raw provider message", async () => {
    const shop = scope(); const { row } = await throttleOnce(shop);
    const serialized = JSON.stringify(row);
    for (const secret of ["access-token-must-not-persist", "shop-cipher-must-not-persist", "outreach-secret", "dynamic quota", "x-tts-access-token"]) expect(serialized).not.toContain(secret);

    let body: any;
    new TikTokApiExceptionFilter().catch(new TikTokApiError("RATE_LIMIT", "SEARCH_CREATORS", 429, 36009002, "safe-request-id", "raw secret response", 1000, new Date(nowMs + 1000), true), {
      switchToHttp: () => ({ getResponse: () => ({ status: () => ({ send: (value: unknown) => { body = value; } }) }) })
    } as any);
    expect(JSON.stringify(body)).not.toContain("raw secret response");
    expect(body).toMatchObject({ error: "TIKTOK_READ_THROTTLED", providerRequestPerformed: false });
  });

  it("still rejects every real mutation before lease acquisition or network", async () => {
    const shop = scope(); const fetcher = vi.fn();
    const http = client(fetcher as typeof fetch);
    await expect(http.requestRaw({ operation: "SEARCH_CREATORS", method: "POST", path: "/affiliate_seller/202508/conversations", accessToken: "token", shopScope: shop })).rejects.toBeInstanceOf(TikTokReadOnlyBoundaryError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await prisma.providerReadThrottle.count({ where: { shopScope: shop } })).toBe(0);
  });
});
