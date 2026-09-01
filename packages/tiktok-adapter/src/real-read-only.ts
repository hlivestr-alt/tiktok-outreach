import type {
  AdapterCapabilities, AuthorizedTikTokShop, CreatorSearchPage, ProviderConversation, ProviderMessage,
  ProviderPage, TikTokReadAdapter, TikTokShopCategory
} from "@affiliate/contracts";
import type { CreatorCandidate, CreatorFilters } from "@affiliate/domain";
import { signTikTokShopRequest } from "./signing";

export type TikTokReadOperation = "GET_AUTHORIZED_SHOPS" | "GET_CATEGORIES" | "SEARCH_CREATORS" | "GET_CREATOR_PERFORMANCE" | "LIST_CONVERSATIONS" | "LIST_MESSAGES";

const ALLOWED_REQUESTS: ReadonlyArray<{ operation: TikTokReadOperation; method: "GET" | "POST"; path: RegExp }> = [
  { operation: "GET_AUTHORIZED_SHOPS", method: "GET", path: /^\/authorization\/202309\/shops$/ },
  { operation: "GET_CATEGORIES", method: "GET", path: /^\/product\/202309\/categories$/ },
  { operation: "SEARCH_CREATORS", method: "POST", path: /^\/affiliate_seller\/202508\/marketplace_creators\/search$/ },
  { operation: "GET_CREATOR_PERFORMANCE", method: "GET", path: /^\/affiliate_seller\/202508\/marketplace_creators\/[^/]+$/ },
  { operation: "LIST_CONVERSATIONS", method: "GET", path: /^\/affiliate_seller\/202412\/conversations$/ },
  { operation: "LIST_MESSAGES", method: "GET", path: /^\/affiliate_seller\/202412\/conversation\/[^/]+\/messages$/ }
] as const;

export class TikTokReadOnlyBoundaryError extends Error {
  readonly code = "TIKTOK_READ_ONLY_BOUNDARY_REJECTED";
  constructor(method: string, path: string) { super(`TikTok request blocked by read-only allowlist: ${method.toUpperCase()} ${path}`); }
}

export function assertAllowedTikTokReadRequest(operation: TikTokReadOperation, method: string, path: string): void {
  const normalized = method.toUpperCase();
  if (!ALLOWED_REQUESTS.some((entry) => entry.operation === operation && entry.method === normalized && entry.path.test(path))) {
    throw new TikTokReadOnlyBoundaryError(normalized, path);
  }
}

export type TikTokErrorKind = "AUTH_EXPIRED" | "PERMISSION" | "SHOP_AUTHORIZATION" | "INVALID_SHOP_CIPHER" | "RATE_LIMIT" | "TEMPORARY" | "MALFORMED_RESPONSE" | "UNSUPPORTED_IDENTIFIER" | "REVOKED" | "PROVIDER";

export class TikTokApiError extends Error {
  constructor(
    readonly kind: TikTokErrorKind,
    readonly operation: string,
    readonly httpStatus: number | undefined,
    readonly providerCode: number | undefined,
    readonly requestId: string | undefined,
    message: string,
    readonly retryAfterMs?: number,
    readonly nextPermittedAt?: Date,
    readonly locallyBlocked: boolean = false
  ) { super(message); }
}

export type TikTokDiagnostics = {
  operation: string; httpStatus?: number; providerCode?: number; requestId?: string; durationMs: number;
  retryCount: number; shopScope?: string; timestamp: string;
};

export type TikTokReadLease = { provider: "TIKTOK_SHOP"; shopScope: string; operation: TikTokReadOperation; leaseOperation: string; leaseId: string };
export type TikTokReadGovernorEvent = { requestId?: string; retryAfterMs?: number; providerCode?: number; httpStatus?: number };
export interface TikTokReadRequestGovernor {
  acquire(input: Omit<TikTokReadLease, "leaseId" | "leaseOperation">): Promise<TikTokReadLease>;
  requestStarted(lease: TikTokReadLease): Promise<void>;
  succeeded(lease: TikTokReadLease, event: TikTokReadGovernorEvent): Promise<void>;
  throttled(lease: TikTokReadLease, event: TikTokReadGovernorEvent): Promise<Date>;
  release(lease: TikTokReadLease): Promise<void>;
}

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TikTokApiError("MALFORMED_RESPONSE", label, undefined, undefined, undefined, `${label}: expected object`);
  return value as JsonObject;
};
const string = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const milliseconds = Number(value) * 1000;
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? date - now : undefined;
}

function errorKind(status: number, code?: number, message = ""): TikTokErrorKind {
  if (status === 429 || code === 45101004 || code === 36009002) return "RATE_LIMIT";
  if (status >= 500 || code === 36009003 || code === 36009007) return "TEMPORARY";
  if (code === 105002) return "AUTH_EXPIRED";
  if (code === 105001) return "REVOKED";
  if (code === 105005) return "PERMISSION";
  if (code === 106013 || (code === 101000 && /shop|cipher/i.test(message))) return "INVALID_SHOP_CIPHER";
  if (code === 101000) return "SHOP_AUTHORIZATION";
  return "PROVIDER";
}

export class TikTokReadOnlyHttpClient {
  private validationActionClaimed = false;

  constructor(private readonly options: {
    baseUrl: string; appKey: string; appSecret: string; fetch?: FetchLike; now?: () => number;
    sleep?: (ms: number) => Promise<void>; random?: () => number; diagnostics?: (event: TikTokDiagnostics) => void;
    governor?: TikTokReadRequestGovernor; validationMode?: boolean; automaticRetries?: boolean;
  }) {}

  async requestRaw<T>(input: {
    operation: TikTokReadOperation; method: "GET" | "POST"; path: string;
    accessToken: string; query?: Record<string, string | number | boolean | undefined>; body?: JsonObject; shopScope?: string;
  }): Promise<T> {
    assertAllowedTikTokReadRequest(input.operation, input.method, input.path);
    if (this.options.validationMode) {
      if (this.validationActionClaimed) {
        throw new TikTokApiError("PROVIDER", input.operation, undefined, undefined, undefined, "Controlled validation permits at most one physical TikTok API request per action");
      }
      this.validationActionClaimed = true;
    }
    const lease = this.options.governor
      ? await this.options.governor.acquire({ provider: "TIKTOK_SHOP", shopScope: input.shopScope ?? "AUTHORIZATION", operation: input.operation })
      : undefined;
    const started = Date.now();
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const now = this.options.now ?? Date.now;
    const baseQuery = { ...(input.query ?? {}), app_key: this.options.appKey };
    const fetcher = this.options.fetch ?? fetch;
    let retryCount = 0;
    let finalized = false;
    try { for (;;) {
      if (lease) await this.options.governor!.requestStarted(lease);
      const timestamp = Math.floor(now() / 1000);
      const query = { ...baseQuery, timestamp };
      const sign = signTikTokShopRequest({ path: input.path, query, body, contentType: "application/json", appSecret: this.options.appSecret });
      const url = new URL(input.path, this.options.baseUrl);
      for (const [key, value] of Object.entries({ ...query, sign })) if (value !== undefined) url.searchParams.set(key, String(value));
      let response: Response;
      try {
        response = await fetcher(url, { method: input.method, headers: { "content-type": "application/json", "x-tts-access-token": input.accessToken }, body });
      } catch (cause) {
        if (this.options.automaticRetries !== false && input.operation !== "SEARCH_CREATORS" && !this.options.validationMode && retryCount < 2) { await this.backoff(retryCount++); continue; }
        throw new TikTokApiError("TEMPORARY", input.operation, undefined, undefined, undefined, cause instanceof Error ? cause.message : "TikTok network error");
      }
      const requestIdHeader = response.headers.get("x-tts-request-id") ?? undefined;
      const retryAfter = retryAfterMs(response.headers.get("retry-after"), now());
      let decoded: unknown;
      try { decoded = await response.json(); }
      catch {
        if (response.status === 429) {
          this.options.diagnostics?.({ operation: input.operation, httpStatus: response.status, requestId: requestIdHeader, durationMs: Date.now() - started, retryCount, shopScope: input.shopScope, timestamp: new Date().toISOString() });
          const nextPermittedAt = lease ? await this.options.governor!.throttled(lease, { requestId: requestIdHeader, retryAfterMs: retryAfter, httpStatus: response.status }) : undefined;
          finalized = Boolean(lease);
          throw new TikTokApiError("RATE_LIMIT", input.operation, response.status, undefined, requestIdHeader, "TikTok read operation is provider-throttled", retryAfter, nextPermittedAt);
        }
        throw new TikTokApiError("MALFORMED_RESPONSE", input.operation, response.status, undefined, requestIdHeader, "TikTok response was not valid JSON");
      }
      let payload: JsonObject;
      try { payload = object(decoded, input.operation); }
      catch {
        if (response.status === 429) {
          this.options.diagnostics?.({ operation: input.operation, httpStatus: response.status, requestId: requestIdHeader, durationMs: Date.now() - started, retryCount, shopScope: input.shopScope, timestamp: new Date().toISOString() });
          const nextPermittedAt = lease ? await this.options.governor!.throttled(lease, { requestId: requestIdHeader, retryAfterMs: retryAfter, httpStatus: response.status }) : undefined;
          finalized = Boolean(lease);
          throw new TikTokApiError("RATE_LIMIT", input.operation, response.status, undefined, requestIdHeader, "TikTok read operation is provider-throttled", retryAfter, nextPermittedAt);
        }
        throw new TikTokApiError("MALFORMED_RESPONSE", input.operation, response.status, undefined, requestIdHeader, `${input.operation}: expected object`);
      }
      const code = number(payload.code) ?? undefined;
      const requestId = string(payload.request_id) ?? requestIdHeader;
      this.options.diagnostics?.({ operation: input.operation, httpStatus: response.status, providerCode: code, requestId, durationMs: Date.now() - started, retryCount, shopScope: input.shopScope, timestamp: new Date().toISOString() });
      if (response.ok && code === 0) {
        if (lease) await this.options.governor!.succeeded(lease, { requestId, providerCode: code });
        finalized = true;
        return payload as T;
      }
      const kind = errorKind(response.status, code, string(payload.message) ?? "");
      if (kind === "RATE_LIMIT") {
        const nextPermittedAt = lease ? await this.options.governor!.throttled(lease, { requestId, retryAfterMs: retryAfter, providerCode: code, httpStatus: response.status }) : undefined;
        finalized = Boolean(lease);
        throw new TikTokApiError(kind, input.operation, response.status, code, requestId, "TikTok read operation is provider-throttled", retryAfter, nextPermittedAt);
      }
      if (kind === "TEMPORARY" && this.options.automaticRetries !== false && input.operation !== "SEARCH_CREATORS" && !this.options.validationMode && retryCount < 2) { await this.backoff(retryCount++, retryAfter); continue; }
      throw new TikTokApiError(kind, input.operation, response.status, code, requestId, string(payload.message) ?? "TikTok API request failed", retryAfter);
    } } finally {
      if (lease && !finalized) await this.options.governor!.release(lease).catch(() => undefined);
    }
  }

  private async backoff(attempt: number, retryAfter?: number): Promise<void> {
    const jitter = Math.floor((this.options.random ?? Math.random)() * 250);
    await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(retryAfter ?? Math.min(4000, 250 * 2 ** attempt) + jitter);
  }
}

function money(value: unknown): { amount: string; currency: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonObject;
  const amount = string(record.amount); const currency = string(record.currency);
  if (!amount || !currency || !Number.isFinite(Number(amount))) return null;
  return { amount, currency };
}

function mapCreator(value: unknown, ordinal: number): CreatorCandidate {
  const creator = object(value, "creator");
  const avatar = creator.avatar && typeof creator.avatar === "object" && !Array.isArray(creator.avatar) ? creator.avatar as JsonObject : {};
  const gmvRange = creator.gmv_range && typeof creator.gmv_range === "object" && !Array.isArray(creator.gmv_range) ? creator.gmv_range as JsonObject : {};
  const demographics = creator.top_follower_demographics && typeof creator.top_follower_demographics === "object" && !Array.isArray(creator.top_follower_demographics) ? creator.top_follower_demographics as JsonObject : {};
  const majorGender = demographics.major_gender && typeof demographics.major_gender === "object" && !Array.isArray(demographics.major_gender) ? demographics.major_gender as JsonObject : {};
  // Current marketplace docs describe this value as Creator Open ID. creator_im_id is intentionally never accepted here.
  const creatorOpenId = string(creator.creator_open_id);
  if (!creatorOpenId) throw new TikTokApiError("UNSUPPORTED_IDENTIFIER", "MAP_CREATOR", undefined, undefined, undefined, "Marketplace creator response omitted creator_open_id");
  return {
    creatorOpenId,
    creatorUserId: string(creator.creator_user_id),
    username: string(creator.username), nickname: string(creator.nickname),
    categoryIds: array(creator.category_ids).filter((item): item is string => typeof item === "string"),
    followerCount: number(creator.follower_count), gmv: money(creator.gmv), unitsSold: number(creator.units_sold),
    avgVideoViews: number(creator.avg_ec_video_view_count), avgLiveViewers: number(creator.avg_ec_live_uv),
    engagementRate: number(creator.engagement_rate) ?? undefined,
    avatarUrl: string(avatar.url), liveGmv: money(creator.live_gmv), videoGmv: money(creator.video_gmv),
    gmvRange: string(gmvRange.formatted_range),
    topAgeRanges: array(demographics.age_ranges).filter((item): item is string => typeof item === "string"),
    majorGender: string(majorGender.gender),
    majorGenderPercentage: number(majorGender.percentage) == null ? undefined : number(majorGender.percentage)! / 10_000,
    selectionRegion: string(creator.selection_region) ?? "UNKNOWN", discoveryOrdinal: ordinal
  };
}

function discreteRanges(min: number | undefined, max: number | undefined, boundaries: Array<[string, number, number]>): string[] | undefined {
  if (min == null && max == null) return undefined;
  const documentedMinimums = new Set(boundaries.map(([, low]) => low));
  const documentedMaximums = new Set(boundaries.filter(([, , high]) => Number.isFinite(high)).map(([, , high]) => high));
  // Arbitrary campaign currency/number boundaries stay local; only exact documented interval edges are translated.
  if ((min != null && !documentedMinimums.has(min)) || (max != null && !documentedMaximums.has(max))) return undefined;
  const selected = boundaries.filter(([, low, high]) => (min == null || high >= min) && (max == null || low <= max)).map(([name]) => name);
  return selected.length ? selected : undefined;
}

export class RealTikTokReadOnlyAffiliateAdapter implements TikTokReadAdapter {
  constructor(private readonly options: { http: TikTokReadOnlyHttpClient; accessToken: () => Promise<string>; shopCipher: () => Promise<string>; shopScope?: () => Promise<string>; authorizationScope?: string }) {}

  async getCapabilities(): Promise<AdapterCapabilities> {
    return { mode: "READ_ONLY", market: "ID", currency: null, currencySource: "PROVIDER_RESPONSE_REQUIRED", pageSizes: [12, 20], messageTypes: ["TEXT"], maxMessageLength: 0,
      filters: ["keyword:server", "category:server", "gmvDiscreteRanges:server", "unitsSoldDiscreteRanges:server", "followersInclusiveRange:server", "avgVideoViews:local", "avgLiveViewers:local", "engagementRate:local"],
      rankingMetrics: ["GMV", "UNITS_SOLD", "FOLLOWERS", "AVG_VIDEO_VIEWS", "AVG_LIVE_VIEWERS", "ENGAGEMENT_RATE", "TIKTOK_RELEVANCE"] };
  }

  async getAuthorizedShops(): Promise<AuthorizedTikTokShop[]> {
    const response = await this.options.http.requestRaw<JsonObject>({ operation: "GET_AUTHORIZED_SHOPS", method: "GET", path: "/authorization/202309/shops", accessToken: await this.options.accessToken(), shopScope: this.options.authorizationScope ?? "AUTHORIZATION" });
    const data = object(response.data, "GET_AUTHORIZED_SHOPS.data");
    return array(data.shops).map((item) => {
      const shop = object(item, "authorized shop");
      const id = string(shop.id), cipher = string(shop.cipher), name = string(shop.name), region = string(shop.region);
      if (!id || !cipher || !name || !region) throw new TikTokApiError("MALFORMED_RESPONSE", "GET_AUTHORIZED_SHOPS", undefined, undefined, string(response.request_id), "Authorized shop omitted a required identity field");
      return { id, cipher, name, region, code: string(shop.code), sellerType: string(shop.seller_type) };
    });
  }

  async getCategories(): Promise<TikTokShopCategory[]> {
    const [shopCipher, shopScope] = await Promise.all([this.options.shopCipher(), this.options.shopScope?.()]);
    const response = await this.options.http.requestRaw<JsonObject>({
      operation: "GET_CATEGORIES", method: "GET", path: "/product/202309/categories",
      accessToken: await this.options.accessToken(), shopScope,
      query: { shop_cipher: shopCipher, locale: "id-ID", category_version: "v2", listing_platform: "TIKTOK_SHOP", include_prohibited_categories: false }
    });
    const data = object(response.data, "GET_CATEGORIES.data");
    return array(data.categories).map((item) => {
      const category = object(item, "category");
      const id = string(category.id), parentId = string(category.parent_id), localName = string(category.local_name);
      if (!id || !parentId || !localName || typeof category.is_leaf !== "boolean") {
        throw new TikTokApiError("MALFORMED_RESPONSE", "GET_CATEGORIES", undefined, undefined, string(response.request_id), "Category omitted a required field");
      }
      return { id, parentId, localName, isLeaf: category.is_leaf };
    });
  }

  async searchCreators(filters: CreatorFilters, cursor: { pageToken?: string; searchKey?: string; pageSize: number } = { pageSize: 20 }): Promise<CreatorSearchPage> {
    if (![12, 20].includes(cursor.pageSize)) throw new TikTokApiError("PROVIDER", "SEARCH_CREATORS", undefined, undefined, undefined, "Creator search page_size must be 12 or 20");
    const [shopCipher, shopScope] = await Promise.all([this.options.shopCipher(), this.options.shopScope?.()]);
    const body: JsonObject = {};
    if (cursor.searchKey) body.search_key = cursor.searchKey;
    if (filters.keyword) body.keyword = filters.keyword;
    if (filters.marketplaceCategory) body.category = [{
      parent_category_id: filters.marketplaceCategory.parentCategoryId,
      ...(filters.marketplaceCategory.childCategoryIds?.length ? { child_category_id_list: filters.marketplaceCategory.childCategoryIds } : {})
    }];
    else if (filters.categoryIds?.length) body.category = filters.categoryIds.map((id) => ({ parent_category_id: id }));
    if (filters.minFollowers != null || filters.maxFollowers != null) body.follower_demographics = { count_range: {
      ...(filters.minFollowers != null ? { count_ge: filters.minFollowers } : {}),
      ...(filters.maxFollowers != null ? { count_le: filters.maxFollowers } : {})
    } };
    if (filters.marketplaceGmvRanges?.length) body.gmv_ranges = filters.marketplaceGmvRanges;
    const unitRanges = discreteRanges(filters.minUnitsSold, undefined, [["UNITS_SOLD_RANGE_0_10", 0, 10], ["UNITS_SOLD_RANGE_10_100", 10, 100], ["UNITS_SOLD_RANGE_100_1000", 100, 1000], ["UNITS_SOLD_RANGE_1000_AND_ABOVE", 1000, Number.POSITIVE_INFINITY]]);
    if (unitRanges) body.units_sold_ranges = unitRanges;
    const response = await this.options.http.requestRaw<JsonObject>({ operation: "SEARCH_CREATORS", method: "POST", path: "/affiliate_seller/202508/marketplace_creators/search", accessToken: await this.options.accessToken(), shopScope,
      query: { shop_cipher: shopCipher, page_size: cursor.pageSize, page_token: cursor.pageToken }, body });
    const data = object(response.data, "SEARCH_CREATORS.data");
    const next = string(data.next_page_token);
    const creators = array(data.creators).map((item, index) => mapCreator(item, index));
    return { creators, searchKey: string(data.search_key) ?? cursor.searchKey ?? "", nextPageToken: next, hasMore: Boolean(next) };
  }

  async getCreatorPerformance(creatorOpenId: string): Promise<CreatorCandidate> {
    if (!creatorOpenId || creatorOpenId.startsWith("im:")) throw new TikTokApiError("UNSUPPORTED_IDENTIFIER", "GET_CREATOR_PERFORMANCE", undefined, undefined, undefined, "Creator performance requires creator_open_id, not creator_im_id");
    const [shopCipher, shopScope] = await Promise.all([this.options.shopCipher(), this.options.shopScope?.()]);
    const path = `/affiliate_seller/202508/marketplace_creators/${encodeURIComponent(creatorOpenId)}`;
    const response = await this.options.http.requestRaw<JsonObject>({ operation: "GET_CREATOR_PERFORMANCE", method: "GET", path, accessToken: await this.options.accessToken(), shopScope, query: { shop_cipher: shopCipher } });
    const data = object(response.data, "GET_CREATOR_PERFORMANCE.data");
    const providerCreator = object(data.creator, "GET_CREATOR_PERFORMANCE.data.creator");
    const mapped = mapCreator({ ...providerCreator, creator_open_id: providerCreator.creator_open_id ?? creatorOpenId }, 0);
    if (mapped.creatorOpenId !== creatorOpenId) throw new TikTokApiError("UNSUPPORTED_IDENTIFIER", "GET_CREATOR_PERFORMANCE", undefined, undefined, string(response.request_id), "Creator performance identity did not match request");
    return mapped;
  }

  async listConversations(cursor: { pageToken?: string; pageSize: number } = { pageSize: 50 }): Promise<ProviderPage<ProviderConversation>> {
    if (cursor.pageSize < 1 || cursor.pageSize > 50) throw new TikTokApiError("PROVIDER", "LIST_CONVERSATIONS", undefined, undefined, undefined, "Conversation page_size must be 1..50");
    const [shopCipher, shopScope] = await Promise.all([this.options.shopCipher(), this.options.shopScope?.()]);
    const response = await this.options.http.requestRaw<JsonObject>({ operation: "LIST_CONVERSATIONS", method: "GET", path: "/affiliate_seller/202412/conversations", accessToken: await this.options.accessToken(), shopScope,
      query: { shop_cipher: shopCipher, page_size: cursor.pageSize, page_token: cursor.pageToken, only_need_conversation_id: false, conversation_status: "ALL" } });
    const data = object(response.data, "LIST_CONVERSATIONS.data");
    const items = array(data.conversations).map((item): ProviderConversation => {
      const conversation = object(item, "conversation");
      const id = string(conversation.id), creatorImId = string(conversation.creator_im_id);
      if (!id || !creatorImId) throw new TikTokApiError("MALFORMED_RESPONSE", "LIST_CONVERSATIONS", undefined, undefined, string(response.request_id), "Conversation omitted id or creator_im_id");
      return { id, creatorImId, username: string(conversation.username), avatarUrl: string(conversation.avatar), unreadCount: number(conversation.unread_count) ?? undefined };
    });
    const nextPageToken = string(data.next_page_token);
    if (data.has_more === true && !nextPageToken) throw new TikTokApiError("MALFORMED_RESPONSE", "LIST_CONVERSATIONS", undefined, undefined, string(response.request_id), "Conversation page has_more was true without next_page_token");
    return { items, nextPageToken, hasMore: typeof data.has_more === "boolean" ? data.has_more : Boolean(nextPageToken) };
  }

  async listMessages(conversationId: string, cursor: { pageToken?: string; pageSize: number; creatorImId?: string } = { pageSize: 20 }): Promise<ProviderPage<ProviderMessage>> {
    if (!conversationId || cursor.pageSize < 1 || cursor.pageSize > 20) throw new TikTokApiError("PROVIDER", "LIST_MESSAGES", undefined, undefined, undefined, "Message history requires a conversation and page_size 1..20");
    const [shopCipher, shopScope] = await Promise.all([this.options.shopCipher(), this.options.shopScope?.()]);
    const path = `/affiliate_seller/202412/conversation/${encodeURIComponent(conversationId)}/messages`;
    const response = await this.options.http.requestRaw<JsonObject>({ operation: "LIST_MESSAGES", method: "GET", path, accessToken: await this.options.accessToken(), shopScope,
      query: { shop_cipher: shopCipher, page_size: cursor.pageSize, page_token: cursor.pageToken } });
    const data = object(response.data, "LIST_MESSAGES.data");
    const items = array(data.messages).map((item): ProviderMessage => {
      const wrapper = object(item, "message"); const body = object(wrapper.message_body, "message_body");
      const id = string(body.id), providerConversationId = string(body.conversation_id), senderId = string(body.sender_id), created = number(body.create_time);
      if (!id || !providerConversationId || !senderId || created == null || created <= 0 || created >= 100_000_000_000) throw new TikTokApiError("MALFORMED_RESPONSE", "LIST_MESSAGES", undefined, undefined, string(response.request_id), "Message omitted required identifiers or a valid epoch-second timestamp");
      let content = string(body.content) ?? "";
      try { const parsed = JSON.parse(content) as JsonObject; content = string(parsed.content) ?? content; } catch { /* provider may return non-JSON for non-text messages */ }
      return { id, conversationId: providerConversationId, creatorImId: cursor.creatorImId, direction: cursor.creatorImId && senderId === cursor.creatorImId ? "INBOUND" : "OUTBOUND", content, createdAt: new Date(created * 1000) };
    });
    const nextPageToken = string(data.next_page_token);
    if (data.has_more === true && !nextPageToken) throw new TikTokApiError("MALFORMED_RESPONSE", "LIST_MESSAGES", undefined, undefined, string(response.request_id), "Message page has_more was true without next_page_token");
    return { items, nextPageToken, hasMore: typeof data.has_more === "boolean" ? data.has_more : Boolean(nextPageToken) };
  }
}
