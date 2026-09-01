import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PrismaClient } from "@affiliate/db";
import { encryptTikTokToken } from "@affiliate/tiktok-adapter";
import { config } from "../shared";
import { TikTokIntegrationService } from "./tiktok.service";

const prisma = new PrismaClient();
const shopIds = new Set<string>();
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const originalConfig = {
  TIKTOK_APP_KEY: config.TIKTOK_APP_KEY, TIKTOK_APP_SECRET: config.TIKTOK_APP_SECRET,
  TIKTOK_SERVICE_ID: config.TIKTOK_SERVICE_ID, TIKTOK_TOKEN_ENCRYPTION_KEY: config.TIKTOK_TOKEN_ENCRYPTION_KEY,
  TIKTOK_AUTH_BASE_URL: config.TIKTOK_AUTH_BASE_URL, TIKTOK_API_BASE_URL: config.TIKTOK_API_BASE_URL,
  TIKTOK_CATEGORY_APP_KEY: config.TIKTOK_CATEGORY_APP_KEY, TIKTOK_CATEGORY_APP_SECRET: config.TIKTOK_CATEGORY_APP_SECRET,
  TIKTOK_CATEGORY_ACCESS_TOKEN: config.TIKTOK_CATEGORY_ACCESS_TOKEN, TIKTOK_CATEGORY_SHOP_CIPHER: config.TIKTOK_CATEGORY_SHOP_CIPHER
};
const stamp = () => `refresh_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const authorizationScope = `AUTHORIZATION:${createHash("sha256").update("test-service").digest("hex").slice(0, 16)}`;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(() => Object.assign(config, {
  TIKTOK_APP_KEY: "test-app", TIKTOK_APP_SECRET: "test-secret", TIKTOK_SERVICE_ID: "test-service",
  TIKTOK_TOKEN_ENCRYPTION_KEY: encryptionKey, TIKTOK_AUTH_BASE_URL: "https://auth.example.test", TIKTOK_API_BASE_URL: "https://api.example.test"
}));
beforeEach(async () => { await prisma.providerReadThrottle.deleteMany({ where: { shopScope: authorizationScope } }); });
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  Object.assign(config, originalConfig);
  for (const id of shopIds) await prisma.shop.delete({ where: { id } }).catch(() => undefined);
  await prisma.$disconnect();
});

async function connection(overrides: Record<string, unknown> = {}) {
  const externalShopId = stamp();
  const shop = await prisma.shop.create({ data: {
    name: stamp(), externalShopId, shopCipher: stamp(), region: "ID", currency: "UNKNOWN",
    connectionMode: "READ_ONLY", selectedForReadOnly: true
  } });
  shopIds.add(shop.id);
  const value = await prisma.integrationConnection.create({ data: {
    shopId: shop.id, mode: "READ_ONLY", status: "HEALTHY",
    accessTokenCiphertext: encryptTikTokToken("known-access", encryptionKey),
    refreshTokenCiphertext: encryptTikTokToken("known-refresh", encryptionKey),
    accessTokenExpiresAt: new Date(Date.now() - 1_000), refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    grantedScopes: ["seller.creator_marketplace.read", "seller.affiliate_messages.write", "seller.product.basic"],
    capabilityStatus: { authorizedShop: { available: true }, creatorMarketplace: { available: true }, affiliateMessageHistory: { available: true } },
    ...overrides
  } as any });
  return { shop, connection: value };
}

function successfulFetch(shopId: string, scopes = ["seller.creator_marketplace.read", "seller.affiliate_messages.write", "seller.product.basic"], delayMs = 0) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v2/token/refresh") {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return response({ code: 0, data: {
        access_token: "rotated-access", refresh_token: "rotated-refresh",
        access_token_expire_in: Math.floor(Date.now() / 1000) + 86_400,
        refresh_token_expire_in: Math.floor(Date.now() / 1000) + 604_800,
        open_id: "seller", user_type: 0, granted_scopes: scopes
      } });
    }
    if (url.pathname === "/authorization/202309/shops") return response({ code: 0, data: { shops: [{ id: shopId, cipher: "cipher", name: "Shop", region: "ID" }] }, request_id: "request-safe" });
    throw new Error(`Unexpected test path ${url.pathname}`);
  });
}

describe.sequential("persisted TikTok refresh lease", () => {
  it("uses a locally healthy validation token without refresh or Authorized Shops calls", async () => {
    const seed = await connection({ accessTokenExpiresAt: new Date(Date.now() + (config.TIKTOK_TOKEN_REFRESH_MARGIN_SECONDS * 1000) + 60_000) });
    await prisma.shop.updateMany({ where: { id: { in: [...shopIds] } }, data: { selectedForReadOnly: false } });
    await prisma.shop.update({ where: { id: seed.shop.id }, data: { selectedForReadOnly: true } });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const service = new TikTokIntegrationService(prisma as any);
    await expect(service.validAccessToken(true)).resolves.toBe("known-access");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails locally for near-expiry and expired validation tokens without refresh or Authorized Shops calls", async () => {
    const nearExpiry = await connection({ accessTokenExpiresAt: new Date(Date.now() + (config.TIKTOK_TOKEN_REFRESH_MARGIN_SECONDS * 1000) - 1) });
    const expired = await connection({ accessTokenExpiresAt: new Date(Date.now() - 1) });
    await prisma.shop.updateMany({ where: { id: { in: [...shopIds] } }, data: { selectedForReadOnly: false } });
    await prisma.shop.update({ where: { id: nearExpiry.shop.id }, data: { selectedForReadOnly: true } });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const service = new TikTokIntegrationService(prisma as any);
    await expect(service.validAccessToken(true)).rejects.toThrow(/CONTROLLED_VALIDATION_TOKEN_NOT_READY/);
    await prisma.shop.update({ where: { id: nearExpiry.shop.id }, data: { selectedForReadOnly: false } });
    await prisma.shop.update({ where: { id: expired.shop.id }, data: { selectedForReadOnly: true } });
    await expect(service.validAccessToken(true)).rejects.toThrow(/CONTROLLED_VALIDATION_TOKEN_NOT_READY/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains normal automatic refresh and refresh-time Authorized Shops validation", async () => {
    const seed = await connection();
    await prisma.shop.updateMany({ where: { id: { in: [...shopIds] } }, data: { selectedForReadOnly: false } });
    await prisma.shop.update({ where: { id: seed.shop.id }, data: { selectedForReadOnly: true } });
    const fetcher = successfulFetch(seed.shop.externalShopId!);
    vi.stubGlobal("fetch", fetcher);
    const service = new TikTokIntegrationService(prisma as any);
    await expect(service.validAccessToken()).resolves.toBe("rotated-access");
    const paths = fetcher.mock.calls.map(([value]) => new URL(String(value)).pathname);
    expect(paths).toEqual(["/api/v2/token/refresh", "/authorization/202309/shops"]);
  });

  it("serializes concurrent refresh calls and performs one token rotation request", async () => {
    const seed = await connection();
    const fetcher = successfulFetch(seed.shop.externalShopId!, undefined, 75);
    vi.stubGlobal("fetch", fetcher);
    const service = new TikTokIntegrationService(prisma as any);
    const [first, second] = await Promise.all([service.refreshToken(seed.shop.id), service.refreshToken(seed.shop.id)]);
    expect(first).toBe("rotated-access"); expect(second).toBe("rotated-access");
    expect(fetcher.mock.calls.filter(([value]) => new URL(String(value)).pathname === "/api/v2/token/refresh")).toHaveLength(1);
    expect(await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } })).toMatchObject({ status: "HEALTHY", refreshState: "IDLE", tokenVersion: 1, refreshFailureCount: 0 });
  });

  it("treats an explicit TikTok refresh rejection as FAILED and preserves the stored token pair", async () => {
    const seed = await connection();
    const before = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } });
    const fetcher = vi.fn(async () => response({ code: 105002, message: "expired" }, 401));
    vi.stubGlobal("fetch", fetcher);
    const service = new TikTokIntegrationService(prisma as any);
    await expect(service.refreshToken(seed.shop.id)).rejects.toThrow(/automatic retry is blocked/i);
    const after = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } });
    expect(after).toMatchObject({ status: "REFRESH_FAILED_RETRY_MANUALLY", refreshState: "FAILED" });
    expect(after.accessTokenCiphertext).toBe(before.accessTokenCiphertext);
    expect(after.refreshTokenCiphertext).toBe(before.refreshTokenCiphertext);
    await expect(service.refreshToken(seed.shop.id, "AUTO")).rejects.toThrow(/automatic token refresh is blocked/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a thrown refresh fetch as OUTCOME_UNCERTAIN and invalidates local tokens", async () => {
    const seed = await connection();
    const fetcher = vi.fn(async () => { throw new Error("simulated connection drop"); });
    vi.stubGlobal("fetch", fetcher);
    const service = new TikTokIntegrationService(prisma as any);
    await expect(service.refreshToken(seed.shop.id)).rejects.toThrow(/outcome is uncertain/i);
    const stored = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } });
    expect(stored).toMatchObject({
      status: "REFRESH_OUTCOME_UNCERTAIN", refreshState: "OUTCOME_UNCERTAIN", lastErrorCode: "TOKEN_NETWORK_ERROR",
      accessTokenCiphertext: null, refreshTokenCiphertext: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null
    });
    await expect(service.refreshToken(seed.shop.id)).rejects.toThrow(/reauthorization is required/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a malformed non-JSON refresh response as OUTCOME_UNCERTAIN", async () => {
    const seed = await connection();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("truncated{", { status: 200, headers: { "content-type": "application/json" } })));
    const service = new TikTokIntegrationService(prisma as any);
    await expect(service.refreshToken(seed.shop.id)).rejects.toThrow(/outcome is uncertain/i);
    expect(await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } })).toMatchObject({
      status: "REFRESH_OUTCOME_UNCERTAIN", refreshState: "OUTCOME_UNCERTAIN", lastErrorCode: "TOKEN_MALFORMED_RESPONSE",
      accessTokenCiphertext: null, refreshTokenCiphertext: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null
    });
  });

  it("does not let an ambiguous stale refresh overwrite a newer reauthorization generation", async () => {
    const seed = await connection({ tokenVersion: 11 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("simulated connection drop"); }));
    const service = new TikTokIntegrationService(prisma as any);
    const delegate = prisma.integrationConnection as any;
    const original = delegate.updateMany.bind(delegate);
    delegate.updateMany = async (args: any) => {
      if (args.data?.refreshState === "OUTCOME_UNCERTAIN") {
        await prisma.integrationConnection.update({ where: { id: seed.connection.id }, data: {
          status: "HEALTHY", refreshState: "IDLE", refreshLeaseId: null, refreshLeaseExpiresAt: null,
          accessTokenCiphertext: encryptTikTokToken("reauthorized-access", encryptionKey),
          refreshTokenCiphertext: encryptTikTokToken("reauthorized-refresh", encryptionKey),
          accessTokenExpiresAt: new Date(Date.now() + 86_400_000), refreshTokenExpiresAt: new Date(Date.now() + 604_800_000),
          lastErrorCode: null, lastErrorMessage: null, tokenVersion: { increment: 1 }
        } });
      }
      return original(args);
    };
    try { await expect(service.refreshToken(seed.shop.id)).rejects.toThrow(/newer token generation was preserved/i); }
    finally { delegate.updateMany = original; }
    const stored = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } });
    expect(stored).toMatchObject({ status: "HEALTHY", refreshState: "IDLE", tokenVersion: 12, lastErrorCode: null });
    expect(stored.accessTokenCiphertext).not.toBeNull();
    expect(stored.refreshTokenCiphertext).not.toBeNull();
  });

  it("turns provider success plus local persistence failure into explicit uncertainty", async () => {
    const seed = await connection();
    vi.stubGlobal("fetch", successfulFetch(seed.shop.externalShopId!));
    const service = new TikTokIntegrationService(prisma as any);
    const delegate = prisma.integrationConnection as any;
    const original = delegate.updateMany.bind(delegate);
    delegate.updateMany = async (args: any) => {
      if (args.data?.accessTokenCiphertext) throw new Error("SIMULATED_DATABASE_PERSISTENCE_FAILURE");
      return original(args);
    };
    try { await expect(service.refreshToken(seed.shop.id)).rejects.toThrow(/persistence is uncertain/i); }
    finally { delegate.updateMany = original; }
    const stored = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } });
    expect(stored).toMatchObject({ status: "REFRESH_OUTCOME_UNCERTAIN", refreshState: "OUTCOME_UNCERTAIN", accessTokenCiphertext: null, refreshTokenCiphertext: null });
  });

  it("does not let stale lease cleanup overwrite a newer healthy token generation", async () => {
    const seed = await connection({
      refreshState: "IN_PROGRESS", refreshLeaseId: "stale-lease", refreshLeaseExpiresAt: new Date(Date.now() - 1_000),
      refreshStartedAt: new Date(Date.now() - 130_000), tokenVersion: 7
    });
    const service = new TikTokIntegrationService(prisma as any);
    await prisma.integrationConnection.update({ where: { id: seed.connection.id }, data: {
      status: "HEALTHY", refreshState: "IDLE", refreshLeaseId: null, refreshLeaseExpiresAt: null,
      accessTokenCiphertext: encryptTikTokToken("newer-access", encryptionKey),
      refreshTokenCiphertext: encryptTikTokToken("newer-refresh", encryptionKey), tokenVersion: 8
    } });

    await expect((service as any).markRefreshUncertain(seed.connection.id, "stale-lease", 7)).resolves.toBe(false);
    const stored = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } });
    expect(stored).toMatchObject({ status: "HEALTHY", refreshState: "IDLE", tokenVersion: 8 });
    expect(stored.accessTokenCiphertext).not.toBeNull();
    expect(stored.refreshTokenCiphertext).not.toBeNull();
  });

  it("does not let a stale missing-token preflight mark a reauthorized generation failed", async () => {
    const seed = await connection({ refreshTokenCiphertext: null, tokenVersion: 3 });
    const service = new TikTokIntegrationService(prisma as any);
    const delegate = prisma.integrationConnection as any;
    const original = delegate.updateMany.bind(delegate);
    delegate.updateMany = async (args: any) => {
      if (args.data?.lastErrorCode === "MISSING_REFRESH_TOKEN") {
        await prisma.integrationConnection.update({ where: { id: seed.connection.id }, data: {
          status: "SHOP_SELECTION_REQUIRED", refreshState: "IDLE", refreshLeaseId: null, refreshLeaseExpiresAt: null,
          accessTokenCiphertext: encryptTikTokToken("reauthorized-access", encryptionKey),
          refreshTokenCiphertext: encryptTikTokToken("reauthorized-refresh", encryptionKey),
          accessTokenExpiresAt: new Date(Date.now() + 86_400_000), refreshTokenExpiresAt: new Date(Date.now() + 604_800_000),
          lastErrorCode: null, lastErrorMessage: null, tokenVersion: { increment: 1 }
        } });
      }
      return original(args);
    };
    try { await expect(service.refreshToken(seed.shop.id)).rejects.toThrow(/connection changed/i); }
    finally { delegate.updateMany = original; }
    expect(await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } })).toMatchObject({
      status: "SHOP_SELECTION_REQUIRED", refreshState: "IDLE", tokenVersion: 4, lastErrorCode: null
    });
  });

  it("revalidates refreshed scopes and keeps a missing capability unhealthy", async () => {
    const seed = await connection();
    vi.stubGlobal("fetch", successfulFetch(seed.shop.externalShopId!, ["seller.creator_marketplace.read"]));
    const service = new TikTokIntegrationService(prisma as any);
    await expect(service.refreshToken(seed.shop.id)).rejects.toThrow(/missing required capabilities/i);
    const stored = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } });
    expect(stored.status).toBe("MISSING_REQUIRED_SCOPES");
    expect((stored.capabilityStatus as any).affiliateMessageHistory).toMatchObject({ available: false });
  });

  it("fails before network for missing and expired refresh tokens", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const missing = await connection({ refreshTokenCiphertext: null });
    const expired = await connection({ refreshTokenExpiresAt: new Date(Date.now() - 1_000) });
    const service = new TikTokIntegrationService(prisma as any);
    await expect(service.refreshToken(missing.shop.id)).rejects.toThrow(/missing/i);
    await expect(service.refreshToken(expired.shop.id)).rejects.toThrow(/expired/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await prisma.integrationConnection.findUniqueOrThrow({ where: { id: missing.connection.id } })).toMatchObject({ status: "REAUTHORIZATION_REQUIRED", refreshState: "FAILED" });
    expect(await prisma.integrationConnection.findUniqueOrThrow({ where: { id: expired.connection.id } })).toMatchObject({ status: "REAUTHORIZATION_REQUIRED", refreshState: "FAILED" });
  });

  it("resets failed refresh lifecycle state after a successful reauthorization", async () => {
    const seed = await connection({
      status: "REFRESH_OUTCOME_UNCERTAIN", refreshState: "OUTCOME_UNCERTAIN", refreshUncertainAt: new Date(),
      refreshLeaseId: "stale-lease", refreshLeaseExpiresAt: new Date(), refreshStartedAt: new Date(),
      refreshFailureCount: 2, lastRefreshFailureAt: new Date(), lastErrorCode: "STALE_REFRESH_ERROR", lastErrorMessage: "stale",
      accessTokenCiphertext: null, refreshTokenCiphertext: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null,
      tokenVersion: 4
    });
    const state = stamp();
    await prisma.tikTokAuthorizationState.create({ data: {
      stateHash: createHash("sha256").update(state).digest("hex"), expiresAt: new Date(Date.now() + 60_000)
    } });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v2/token/get") return response({ code: 0, data: {
        access_token: "reauthorized-access", refresh_token: "reauthorized-refresh",
        access_token_expire_in: Math.floor(Date.now() / 1000) + 86_400,
        refresh_token_expire_in: Math.floor(Date.now() / 1000) + 604_800,
        open_id: "seller", user_type: 0,
        granted_scopes: ["seller.creator_marketplace.read", "seller.affiliate_messages.write", "seller.product.basic"]
      } });
      if (url.pathname === "/authorization/202309/shops") return response({ code: 0, data: { shops: [{
        id: seed.shop.externalShopId, cipher: "reauthorized-cipher", name: "Shop", region: "ID"
      }] } });
      throw new Error(`Unexpected test path ${url.pathname}`);
    }));
    const service = new TikTokIntegrationService(prisma as any);
    await expect(service.callback({ state, code: "new-authorization-code" })).resolves.toMatchObject({ status: "SHOP_SELECTION_REQUIRED" });
    const stored = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: seed.connection.id } });
    expect(stored).toMatchObject({
      refreshState: "IDLE", refreshLeaseId: null, refreshLeaseExpiresAt: null, refreshStartedAt: null, refreshUncertainAt: null,
      refreshFailureCount: 0, lastRefreshFailureAt: null, lastErrorCode: null, lastErrorMessage: null,
      tokenVersion: 5, status: "SHOP_SELECTION_REQUIRED"
    });
    expect(stored.accessTokenCiphertext).not.toBeNull();
    expect(stored.refreshTokenCiphertext).not.toBeNull();
  });
});

describe.sequential("separate category metadata credentials", () => {
  it("fails closed when category credentials are missing and never falls back to Outreach", async () => {
    const seed = await connection({ accessTokenExpiresAt: new Date(Date.now() + 86_400_000) });
    await prisma.shop.updateMany({ where: { id: { in: [...shopIds] } }, data: { selectedForReadOnly: false } });
    await prisma.shop.update({ where: { id: seed.shop.id }, data: { selectedForReadOnly: true } });
    Object.assign(config, { TIKTOK_CATEGORY_APP_KEY: undefined, TIKTOK_CATEGORY_APP_SECRET: undefined,
      TIKTOK_CATEGORY_ACCESS_TOKEN: undefined, TIKTOK_CATEGORY_SHOP_CIPHER: undefined });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(new TikTokIntegrationService(prisma as any).categoryMetadataAdapter()).rejects.toThrow(/CATEGORY_METADATA_NOT_CONFIGURED/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses category credentials only for Get Categories and Outreach credentials for creator search", async () => {
    const seed = await connection({ accessTokenExpiresAt: new Date(Date.now() + 86_400_000) });
    await prisma.shop.updateMany({ where: { id: { in: [...shopIds] } }, data: { selectedForReadOnly: false } });
    await prisma.shop.update({ where: { id: seed.shop.id }, data: { selectedForReadOnly: true, shopCipher: "outreach-cipher" } });
    Object.assign(config, { TIKTOK_CATEGORY_APP_KEY: "category-app", TIKTOK_CATEGORY_APP_SECRET: "category-secret",
      TIKTOK_CATEGORY_ACCESS_TOKEN: "category-token", TIKTOK_CATEGORY_SHOP_CIPHER: "category-cipher" });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/product/202309/categories") {
        expect(url.searchParams.get("app_key")).toBe("category-app");
        expect(url.searchParams.get("shop_cipher")).toBe("category-cipher");
        expect(new Headers(init?.headers).get("x-tts-access-token")).toBe("category-token");
        return response({ code: 0, data: { categories: [{ id: "600001", parent_id: "0", local_name: "Beauty", is_leaf: false }] } });
      }
      if (url.pathname === "/affiliate_seller/202508/marketplace_creators/search") {
        expect(url.searchParams.get("app_key")).toBe("test-app");
        expect(url.searchParams.get("shop_cipher")).toBe("outreach-cipher");
        expect(new Headers(init?.headers).get("x-tts-access-token")).toBe("known-access");
        return response({ code: 0, data: { creators: [], search_key: "search", next_page_token: "" } });
      }
      throw new Error(`Unexpected test path ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const service = new TikTokIntegrationService(prisma as any);
    const category = await service.categoryMetadataAdapter();
    await expect(category.getCategories!()).resolves.toEqual([{ id: "600001", parentId: "0", localName: "Beauty", isLeaf: false }]);
    const marketplace = await service.discoveryAdapter();
    await marketplace.searchCreators({}, { pageSize: 20 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await service.status())).not.toContain("category-secret");
  });
});
