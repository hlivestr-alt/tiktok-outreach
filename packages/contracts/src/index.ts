import type { CreatorCandidate, CreatorFilters, RankingMetric } from "@affiliate/domain";

export type OutreachCampaignFilters = Omit<CreatorFilters, "gmvCurrency">;

export type CampaignCreateInput = {
  /** Ignored for normal creation; the API allocates the campaign name. */
  name?: string;
  /** Optional legacy metadata and {{product_name}} rendering context. */
  productName?: string;
  targetCount: number;
  candidateLimit?: number;
  cooldownDays: number;
  messageTemplate?: string;
  /** GMV currency is server-owned for Outreach and cannot be selected by clients. */
  filters: OutreachCampaignFilters;
  rankingMetric: RankingMetric;
  rankingDirection?: "ASC" | "DESC";
};

export type CampaignCloneFromPreviewInput = {
  /** Ignored; clone names use the same automatic allocator as normal creation. */
  name?: string;
  /** Optional legacy metadata and {{product_name}} rendering context. */
  productName?: string;
  messageTemplate: string;
  targetCount: number;
};

export type CreatorSearchPage = {
  creators: CreatorCandidate[];
  nextPageToken?: string;
  searchKey: string;
  hasMore: boolean;
};

export type AdapterCapabilities = {
  mode: "MOCK" | "READ_ONLY" | "LIVE" | "DISABLED";
  market: "ID";
  currency: string | null;
  currencySource: "MOCK_FIXED" | "PROVIDER_RESPONSE_REQUIRED";
  pageSizes: number[];
  filters: string[];
  rankingMetrics: RankingMetric[];
  messageTypes: ["TEXT"];
  maxMessageLength: number;
};

export type ProviderMessage = {
  id: string;
  conversationId: string;
  creatorOpenId?: string;
  creatorImId?: string;
  direction: "OUTBOUND" | "INBOUND";
  content: string;
  createdAt: Date;
};

export type ProviderPage<T> = {
  items: T[];
  nextPageToken?: string;
  hasMore: boolean;
};

export type ProviderConversation = { id: string; creatorOpenId?: string; creatorImId: string; username?: string; avatarUrl?: string; unreadCount?: number };

export type SendMessageResult =
  | { status: "SENT"; messageId: string; requestId: string; httpStatus?: number }
  | { status: "DELIVERY_UNKNOWN"; requestId: string; httpStatus?: number }
  | { status: "RETRYABLE_ERROR" | "QUOTA_LIMITED"; requestId: string; errorCode: string; retryAfterMs?: number; httpStatus?: number }
  | { status: "RESTRICTED"; requestId: string; errorCode: string; httpStatus?: number };

export type AuthorizedTikTokShop = { id: string; cipher: string; code?: string; name: string; region: string; sellerType?: string };
export type TikTokShopCategory = { id: string; parentId: string; localName: string; isLeaf: boolean };

export interface TikTokReadAdapter {
  getCapabilities(): Promise<AdapterCapabilities>;
  searchCreators(filters: CreatorFilters, cursor?: { pageToken?: string; searchKey?: string; pageSize: number }): Promise<CreatorSearchPage>;
  getCreatorPerformance(creatorOpenId: string): Promise<CreatorCandidate>;
  getAuthorizedShops?(): Promise<AuthorizedTikTokShop[]>;
  getCategories?(): Promise<TikTokShopCategory[]>;
  listConversations(cursor?: { pageToken?: string; pageSize: number }): Promise<ProviderPage<ProviderConversation>>;
  listMessages(conversationId: string, cursor?: { pageToken?: string; pageSize: number; creatorImId?: string }): Promise<ProviderPage<ProviderMessage>>;
  getLatestUnreadMessages?(): Promise<ProviderMessage[]>;
}

export interface TikTokAffiliateAdapter extends TikTokReadAdapter {
  createOrGetConversation(creatorOpenId: string): Promise<{ conversationId: string; isNew: boolean }>;
  sendMessage(conversationId: string, creatorOpenId: string, content: string, options: { idempotencyKey: string }): Promise<SendMessageResult>;
}

/** The outbound worker receives this deliberately narrow capability. */
export type TikTokOutboundAdapter = Pick<TikTokAffiliateAdapter, "createOrGetConversation" | "sendMessage">;
