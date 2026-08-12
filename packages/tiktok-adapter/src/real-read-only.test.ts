import { describe, expect, it, vi } from "vitest";
import {
  decryptTikTokToken, encryptTikTokToken, RealTikTokReadOnlyAffiliateAdapter, signTikTokShopRequest,
  TikTokApiError, TikTokReadOnlyBoundaryError, TikTokReadOnlyHttpClient, TikTokSellerAuthClient
} from "./index";

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("TikTok Shop signing", () => {
  it("matches TikTok's fixed official Get Authorized Shops fixture", () => {
    expect(signTikTokShopRequest({ path: "/authorization/202309/shops", query: { app_key: "29a39d", timestamp: 1623812664 }, appSecret: "e59af819cc", contentType: "application/json" }))
      .toBe("b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8");
  });

  it("canonicalizes sorted query and exact JSON body while excluding sign/access_token", () => {
    const first = signTikTokShopRequest({ path: "/x", query: { z: "2", app_key: "a", timestamp: 1, sign: "ignored", access_token: "ignored" }, body: "{\"x\":1}", appSecret: "secret", contentType: "application/json" });
    const second = signTikTokShopRequest({ path: "/x", query: { timestamp: 1, app_key: "a", z: "2" }, body: "{\"x\":1}", appSecret: "secret", contentType: "application/json" });
    expect(first).toBe(second);
  });
});

describe("AES-GCM token envelope", () => {
  it("encrypts and authenticates refreshable credentials", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptTikTokToken("sensitive-token", key);
    expect(encrypted).not.toContain("sensitive-token");
    expect(decryptTikTokToken(encrypted, key)).toBe("sensitive-token");
    expect(() => decryptTikTokToken(`${encrypted}tampered`, key)).toThrow();
  });
});

describe("seller token API", () => {
  it("parses exchange and refresh rotation without exposing request secrets", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { access_token: "access-new", refresh_token: "refresh-new", access_token_expire_in: 1800000000, refresh_token_expire_in: 1805000000, open_id: "seller-open", user_type: 0, granted_scopes: ["seller.creator_marketplace.read"] } }));
    const auth = new TikTokSellerAuthClient({ baseUrl: "https://auth.tiktok-shops.com", appKey: "app", appSecret: "secret", fetch: fetcher as typeof fetch });
    const exchanged = await auth.exchange("one-time-code");
    const refreshed = await auth.refresh("refresh-old");
    expect(exchanged).toMatchObject({ accessToken: "access-new", refreshToken: "refresh-new", sellerOpenId: "seller-open", userType: 0 });
    expect(exchanged.accessTokenExpiresAt.getTime()).toBe(1_800_000_000_000);
    expect(exchanged.refreshTokenExpiresAt.getTime()).toBe(1_805_000_000_000);
    expect(refreshed.refreshToken).toBe("refresh-new");
    expect(JSON.stringify(exchanged)).not.toContain("secret");
  });

  it("rejects creator tokens and malformed token responses", async () => {
    const creator = new TikTokSellerAuthClient({ baseUrl: "https://auth.tiktok-shops.com", appKey: "a", appSecret: "s", fetch: (async () => jsonResponse({ code: 0, data: { access_token: "a", refresh_token: "r", access_token_expire_in: 1, refresh_token_expire_in: 2, user_type: 1 } })) as typeof fetch });
    await expect(creator.exchange("code")).rejects.toMatchObject({ code: "WRONG_AUTHORIZATION_IDENTITY" });
    const malformed = new TikTokSellerAuthClient({ baseUrl: "https://auth.tiktok-shops.com", appKey: "a", appSecret: "s", fetch: (async () => jsonResponse({ code: 0, data: {} })) as typeof fetch });
    await expect(malformed.exchange("code")).rejects.toMatchObject({ code: "TOKEN_MALFORMED_RESPONSE" });
  });
});

describe("real read-only adapter", () => {
  it("parses authorized shops, creator pages/performance, conversations, and messages", async () => {
    const responses = [
      { code: 0, data: { shops: [{ id: "shop-1", cipher: "cipher-1", code: "IDABC", name: "Indonesia Shop", region: "ID", seller_type: "LOCAL" }] }, request_id: "r1" },
      { code: 0, data: { search_key: "stable", next_page_token: "next", creators: [{ creator_open_id: "creator-open-1", creator_user_id: "creator-user-1", username: "ayu", nickname: "Ayu", selection_region: "ID", category_ids: ["60001"], follower_count: 1200, gmv: { amount: "125.50", currency: "IDR" }, units_sold: 9, avg_ec_video_view_count: 400, avg_ec_live_uv: 25 }] }, request_id: "r2" },
      { code: 0, data: { creator: { creator_open_id: "creator-open-1", creator_user_id: "creator-user-1", selection_region: "ID", category_ids: [], follower_count: 1200, gmv: { amount: "125.50", currency: "IDR" }, units_sold: 9 } }, request_id: "r3" },
      { code: 0, data: { has_more: true, next_page_token: "c-next", conversations: [{ id: "conversation-1", creator_im_id: "im-1", username: "ayu", unread_count: 2 }] }, request_id: "r4" },
      { code: 0, data: { has_more: false, messages: [{ message_body: { id: "message-1", conversation_id: "conversation-1", type: "TEXT", content: "{\"content\":\"hello\"}", create_time: 1691411573, sender_id: "im-1" } }] }, request_id: "r5" }
    ];
    const fetcher = vi.fn(async () => jsonResponse(responses.shift()));
    const http = new TikTokReadOnlyHttpClient({ baseUrl: "https://open-api.tiktokglobalshop.com", appKey: "app", appSecret: "secret", fetch: fetcher as typeof fetch, now: () => 1700000000000 });
    const adapter = new RealTikTokReadOnlyAffiliateAdapter({ http, accessToken: async () => "token", shopCipher: async () => "cipher-1" });
    expect(await adapter.getAuthorizedShops()).toEqual([{ id: "shop-1", cipher: "cipher-1", code: "IDABC", name: "Indonesia Shop", region: "ID", sellerType: "LOCAL" }]);
    const creators = await adapter.searchCreators({ minFollowers: 1000 }, { pageSize: 20 });
    expect(creators).toMatchObject({ searchKey: "stable", nextPageToken: "next", hasMore: true });
    expect(creators.creators[0]).toMatchObject({ creatorOpenId: "creator-open-1", creatorUserId: "creator-user-1", followerCount: 1200 });
    expect(await adapter.getCreatorPerformance("creator-open-1")).toMatchObject({ creatorOpenId: "creator-open-1", avgVideoViews: null, avgLiveViewers: null });
    const conversations = await adapter.listConversations({ pageSize: 50 });
    expect(conversations.items[0]).toMatchObject({ id: "conversation-1", creatorImId: "im-1", unreadCount: 2 });
    const messages = await adapter.listMessages("conversation-1", { pageSize: 20, creatorImId: "im-1" });
    expect(messages.items[0]).toMatchObject({ id: "message-1", direction: "INBOUND", content: "hello", creatorImId: "im-1" });
  });

  it("rejects messaging identifiers in the performance endpoint", async () => {
    const fetcher = vi.fn();
    const adapter = new RealTikTokReadOnlyAffiliateAdapter({ http: new TikTokReadOnlyHttpClient({ baseUrl: "https://example.test", appKey: "a", appSecret: "s", fetch: fetcher as typeof fetch }), accessToken: async () => "token", shopCipher: async () => "cipher" });
    await expect(adapter.getCreatorPerformance("im:123")).rejects.toMatchObject({ kind: "UNSUPPORTED_IDENTIFIER" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps provider errors and never immediately retries a provider throttle", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 36009002, message: "too many", request_id: "r-rate" }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { shops: [] }, request_id: "r-ok" }));
    const http = new TikTokReadOnlyHttpClient({ baseUrl: "https://example.test", appKey: "a", appSecret: "s", fetch: fetcher as typeof fetch, sleep: async () => undefined, random: () => 0 });
    await expect(http.requestRaw({ operation: "GET_AUTHORIZED_SHOPS", method: "GET", path: "/authorization/202309/shops", accessToken: "token" })).rejects.toMatchObject({ kind: "RATE_LIMIT", providerCode: 36009002 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const permission = new TikTokReadOnlyHttpClient({ baseUrl: "https://example.test", appKey: "a", appSecret: "s", fetch: (async () => jsonResponse({ code: 105005, message: "scope", request_id: "r" }, 403)) as typeof fetch });
    await expect(permission.requestRaw({ operation: "GET_AUTHORIZED_SHOPS", method: "GET", path: "/authorization/202309/shops", accessToken: "token" })).rejects.toMatchObject({ kind: "PERMISSION", providerCode: 105005 });
    const cipher = new TikTokReadOnlyHttpClient({ baseUrl: "https://example.test", appKey: "a", appSecret: "s", fetch: (async () => jsonResponse({ code: 106013, message: "shop_cipher is required", request_id: "r" }, 400)) as typeof fetch });
    await expect(cipher.requestRaw({ operation: "GET_AUTHORIZED_SHOPS", method: "GET", path: "/authorization/202309/shops", accessToken: "token" })).rejects.toMatchObject({ kind: "INVALID_SHOP_CIPHER" });
  });

  it("never internally retries Marketplace temporary failures", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 36009003, message: "temporary", request_id: "r-temp" }, 503));
    const adapter = new RealTikTokReadOnlyAffiliateAdapter({
      http: new TikTokReadOnlyHttpClient({ baseUrl: "https://example.test", appKey: "a", appSecret: "s", fetch: fetcher as typeof fetch, sleep: async () => undefined }),
      accessToken: async () => "token", shopCipher: async () => "cipher"
    });
    await expect(adapter.searchCreators({}, { pageSize: 20 })).rejects.toMatchObject({ kind: "TEMPORARY", providerCode: 36009003 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("enforces one physical request across a controlled-validation adapter", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: {
      search_key: "validation-key", next_page_token: "page-2",
      creators: [{ creator_open_id: "creator-open-1", selection_region: "ID", category_ids: [] }]
    } }));
    const adapter = new RealTikTokReadOnlyAffiliateAdapter({
      http: new TikTokReadOnlyHttpClient({ baseUrl: "https://example.test", appKey: "a", appSecret: "s", fetch: fetcher as typeof fetch, validationMode: true }),
      accessToken: async () => "token", shopCipher: async () => "cipher"
    });
    await expect(adapter.searchCreators({}, { pageSize: 20 })).resolves.toMatchObject({ hasMore: true, nextPageToken: "page-2" });
    await expect(adapter.searchCreators({}, { pageSize: 20, pageToken: "page-2", searchKey: "validation-key" })).rejects.toThrow(/at most one physical/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses one physical request for controlled creator-performance validation", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 0, data: { creator: {
      creator_open_id: "creator-open-1", selection_region: "ID", category_ids: []
    } } }));
    const adapter = new RealTikTokReadOnlyAffiliateAdapter({
      http: new TikTokReadOnlyHttpClient({ baseUrl: "https://example.test", appKey: "a", appSecret: "s", fetch: fetcher as typeof fetch, validationMode: true }),
      accessToken: async () => "token", shopCipher: async () => "cipher"
    });
    await expect(adapter.getCreatorPerformance("creator-open-1")).resolves.toMatchObject({ creatorOpenId: "creator-open-1" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps malformed non-429 responses out of the throttle classification", async () => {
    const http = new TikTokReadOnlyHttpClient({
      baseUrl: "https://example.test", appKey: "a", appSecret: "s",
      fetch: (async () => new Response("truncated{", { status: 500 })) as typeof fetch,
      validationMode: true
    });
    await expect(http.requestRaw({ operation: "GET_AUTHORIZED_SHOPS", method: "GET", path: "/authorization/202309/shops", accessToken: "token" }))
      .rejects.toMatchObject({ kind: "MALFORMED_RESPONSE", httpStatus: 500 });
  });

  it("fails closed before fetch for every known mutation path", async () => {
    const fetcher = vi.fn();
    const http = new TikTokReadOnlyHttpClient({ baseUrl: "https://open-api.tiktokglobalshop.com", appKey: "app", appSecret: "secret", fetch: fetcher as typeof fetch });
    const mutations: Array<["GET" | "POST", string]> = [
      ["POST", "/affiliate_seller/202508/conversations"],
      ["POST", "/affiliate_seller/202412/conversations/123/messages"],
      ["POST", "/affiliate_seller/202412/conversations/123/read"],
      ["POST", "/affiliate_seller/202508/target_collaborations"],
      ["POST", "/affiliate_seller/202508/invitations"],
      ["POST", "/affiliate_seller/202409/sample_applications/search"],
      ["POST", "/affiliate_seller/202409/sample_applications/123/approve"],
      ["POST", "/affiliate_seller/202508/open_collaborations"]
    ];
    for (const [method, path] of mutations) {
      await expect(http.requestRaw({ operation: "GET_AUTHORIZED_SHOPS", method, path, accessToken: "token", body: { message: "must never leave process" } })).rejects.toBeInstanceOf(TikTokReadOnlyBoundaryError);
    }
    expect(fetcher).toHaveBeenCalledTimes(0);
  });

  it("rejects malformed provider data", async () => {
    const http = new TikTokReadOnlyHttpClient({ baseUrl: "https://example.test", appKey: "a", appSecret: "s", fetch: (async () => jsonResponse({ code: 0, data: { creators: [{}], search_key: "x" } })) as typeof fetch });
    const adapter = new RealTikTokReadOnlyAffiliateAdapter({ http, accessToken: async () => "token", shopCipher: async () => "cipher" });
    await expect(adapter.searchCreators({}, { pageSize: 20 })).rejects.toBeInstanceOf(TikTokApiError);
  });
});
