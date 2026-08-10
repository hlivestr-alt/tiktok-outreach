import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { tiktokCredentialsConfigured } from "@affiliate/config";
import type { TikTokReadAdapter } from "@affiliate/contracts";
import {
  decryptTikTokToken, encryptTikTokToken, MockTikTokAffiliateAdapter, RealTikTokReadOnlyAffiliateAdapter,
  TikTokAuthorizationError, TikTokReadOnlyHttpClient, TikTokSellerAuthClient, type TikTokDiagnostics, type TikTokSellerTokens
} from "@affiliate/tiktok-adapter";
import { config, ensureMockShop, PrismaService } from "../shared";
import { Prisma } from "@affiliate/db";

const stateHash = (state: string) => createHash("sha256").update(state).digest("hex");
const REQUIRED_READ_SCOPES = ["seller.creator_marketplace.read", "seller.affiliate_messages.write"];

export function validateTikTokCallbackInput(input: { state?: string; code?: string; error?: string }): void {
  if (!input.state) throw new TikTokAuthorizationError("MISSING_STATE", "Authorization callback state is missing");
  if (input.error || input.code === "null") throw new TikTokAuthorizationError("AUTHORIZATION_REJECTED", "Seller rejected TikTok authorization");
  if (!input.code) throw new TikTokAuthorizationError("MALFORMED_CALLBACK", "Authorization callback code is missing");
}

export function publicTikTokConnection(connection: {
  status: string; sellerOpenId: string | null; grantedScopes: unknown; accessTokenExpiresAt: Date | null; refreshTokenExpiresAt: Date | null;
  lastAuthorizedAt: Date | null; lastRefreshAt: Date | null; lastRefreshFailureAt: Date | null; refreshFailureCount: number;
  lastApiRequestAt: Date | null; lastRequestId: string | null; lastErrorCode: string | null; lastErrorMessage: string | null;
}) {
  return {
    status: connection.status, sellerOpenId: connection.sellerOpenId, grantedScopes: connection.grantedScopes,
    accessTokenExpiresAt: connection.accessTokenExpiresAt, refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
    lastAuthorizedAt: connection.lastAuthorizedAt, lastRefreshAt: connection.lastRefreshAt, lastRefreshFailureAt: connection.lastRefreshFailureAt,
    refreshFailureCount: connection.refreshFailureCount, lastApiRequestAt: connection.lastApiRequestAt, lastRequestId: connection.lastRequestId,
    lastErrorCode: connection.lastErrorCode, lastErrorMessage: connection.lastErrorMessage
  };
}

@Injectable()
export class TikTokIntegrationService {
  private readonly mock = new MockTikTokAffiliateAdapter();
  private readonly configured = tiktokCredentialsConfigured(config);

  constructor(private readonly prisma: PrismaService) {}

  private credentials() {
    if (!this.configured || !config.TIKTOK_APP_KEY || !config.TIKTOK_APP_SECRET || !config.TIKTOK_TOKEN_ENCRYPTION_KEY || !config.TIKTOK_SERVICE_ID) {
      throw new ServiceUnavailableException("READ_ONLY_NOT_CONFIGURED");
    }
    return { appKey: config.TIKTOK_APP_KEY, appSecret: config.TIKTOK_APP_SECRET, encryptionKey: config.TIKTOK_TOKEN_ENCRYPTION_KEY, serviceId: config.TIKTOK_SERVICE_ID };
  }

  private http(): TikTokReadOnlyHttpClient {
    const credentials = this.credentials();
    return new TikTokReadOnlyHttpClient({ baseUrl: config.TIKTOK_API_BASE_URL, appKey: credentials.appKey, appSecret: credentials.appSecret, diagnostics: (event) => this.recordDiagnostics(event) });
  }

  private recordDiagnostics(event: TikTokDiagnostics): void {
    if (!event.shopReference) return;
    void this.prisma.shop.findFirst({ where: { OR: [{ id: event.shopReference }, { shopCipher: event.shopReference }] }, select: { id: true } }).then((shop) => {
      if (!shop) return;
      return this.prisma.integrationConnection.updateMany({ where: { shopId: shop.id, provider: "TIKTOK_SHOP" }, data: event.providerCode === 0 ? {
        lastApiRequestAt: new Date(event.timestamp), lastRequestId: event.requestId, lastErrorCode: null
      } : { lastRequestId: event.requestId, lastErrorCode: event.providerCode == null ? null : String(event.providerCode) } });
    }).catch(() => undefined);
  }

  async adapter(): Promise<TikTokReadAdapter> {
    if (config.APP_MODE === "mock") return this.mock;
    this.credentials();
    return new RealTikTokReadOnlyAffiliateAdapter({ http: this.http(), accessToken: () => this.validAccessToken(), shopCipher: async () => (await this.selectedShop()).shopCipher! });
  }

  async activeShop() {
    if (config.APP_MODE === "mock") return ensureMockShop(this.prisma);
    return this.selectedShop();
  }

  async initiateAuthorization() {
    const { serviceId } = this.credentials();
    const state = randomBytes(32).toString("base64url");
    await this.prisma.tikTokAuthorizationState.create({ data: { stateHash: stateHash(state), expiresAt: new Date(Date.now() + 10 * 60_000) } });
    const url = new URL(config.TIKTOK_AUTHORIZATION_BASE_URL);
    url.searchParams.set("service_id", serviceId);
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), mode: "READ_ONLY" };
  }

  async callback(input: { state?: string; code?: string; error?: string }) {
    try { validateTikTokCallbackInput(input); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Invalid TikTok callback"); }
    const hash = stateHash(input.state!);
    const stored = await this.prisma.tikTokAuthorizationState.findUnique({ where: { stateHash: hash } });
    if (!stored) throw new BadRequestException("Authorization state does not match");
    if (stored.consumedAt) throw new BadRequestException("Authorization state was already used");
    if (stored.expiresAt <= new Date()) throw new BadRequestException("Authorization state expired");
    const consumed = await this.prisma.tikTokAuthorizationState.updateMany({ where: { id: stored.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    if (consumed.count !== 1) throw new BadRequestException("Authorization state is no longer valid");

    const credentials = this.credentials();
    const auth = new TikTokSellerAuthClient({ baseUrl: config.TIKTOK_AUTH_BASE_URL, appKey: credentials.appKey, appSecret: credentials.appSecret });
    let tokens: TikTokSellerTokens;
    try { tokens = await auth.exchange(input.code!); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "TikTok token exchange failed"); }

    const transient = new RealTikTokReadOnlyAffiliateAdapter({ http: this.http(), accessToken: async () => tokens.accessToken, shopCipher: async () => { throw new Error("Shop not selected"); } });
    const shops = await transient.getAuthorizedShops();
    if (!shops.length) throw new BadRequestException("TikTok returned no authorized shops");
    const indonesia = shops.filter((shop) => shop.region === "ID");
    if (!indonesia.length) throw new BadRequestException("Authorization did not include an Indonesian shop");
    const authorizedAt = new Date();
    const persisted = [];
    for (const shop of shops) {
      persisted.push(await this.prisma.shop.upsert({ where: { externalShopId: shop.id }, update: {
        name: shop.name, shopCipher: shop.cipher, shopCode: shop.code, sellerType: shop.sellerType, region: shop.region, connectionMode: "READ_ONLY", selectedForReadOnly: false
      }, create: {
        name: shop.name, externalShopId: shop.id, shopCipher: shop.cipher, shopCode: shop.code, sellerType: shop.sellerType,
        region: shop.region, currency: shop.region === "ID" ? "IDR" : "USD", timezone: shop.region === "ID" ? "Asia/Jakarta" : config.SHOP_TIMEZONE,
        connectionMode: "READ_ONLY", selectedForReadOnly: false, maxRecipientsPerCampaign: config.MAX_RECIPIENTS_PER_CAMPAIGN,
        maxDispatchAttemptsPerCampaign: config.MAX_DISPATCH_ATTEMPTS_PER_CAMPAIGN, maxSendsPerDay: config.MAX_SENDS_PER_DAY, maxDispatchesPerMinute: config.MAX_DISPATCHES_PER_MINUTE
      } }));
    }
    const primary = persisted.find((shop) => shop.region === "ID")!;
    const missingScopes = REQUIRED_READ_SCOPES.filter((scope) => !tokens.grantedScopes.includes(scope));
    const connectionStatus = missingScopes.length ? "MISSING_REQUIRED_SCOPES" : "SHOP_SELECTION_REQUIRED";
    await this.prisma.integrationConnection.upsert({ where: { shopId_provider: { shopId: primary.id, provider: "TIKTOK_SHOP" } }, update: {
      mode: "READ_ONLY", status: connectionStatus, sellerOpenId: tokens.sellerOpenId,
      accessTokenCiphertext: encryptTikTokToken(tokens.accessToken, credentials.encryptionKey), refreshTokenCiphertext: encryptTikTokToken(tokens.refreshToken, credentials.encryptionKey),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt, refreshTokenExpiresAt: tokens.refreshTokenExpiresAt, grantedScopes: tokens.grantedScopes,
      lastAuthorizedAt: authorizedAt, lastValidatedAt: authorizedAt, lastErrorCode: null, lastErrorMessage: null, refreshFailureCount: 0
    }, create: {
      shopId: primary.id, mode: "READ_ONLY", status: connectionStatus, sellerOpenId: tokens.sellerOpenId,
      accessTokenCiphertext: encryptTikTokToken(tokens.accessToken, credentials.encryptionKey), refreshTokenCiphertext: encryptTikTokToken(tokens.refreshToken, credentials.encryptionKey),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt, refreshTokenExpiresAt: tokens.refreshTokenExpiresAt, grantedScopes: tokens.grantedScopes,
      lastAuthorizedAt: authorizedAt, lastValidatedAt: authorizedAt
    } });
    return { status: connectionStatus, missingRequiredScopes: missingScopes, sellerOpenId: tokens.sellerOpenId, grantedScopes: tokens.grantedScopes, shops: shops.map(({ cipher: _cipher, ...shop }) => shop), outboundEnabled: false };
  }

  async selectShop(externalShopId: string) {
    if (config.APP_MODE !== "read_only") throw new BadRequestException("Real shop selection is available only in read-only mode");
    const shop = await this.prisma.shop.findFirst({ where: { externalShopId, connectionMode: "READ_ONLY", region: "ID" } });
    if (!shop?.shopCipher) throw new BadRequestException("Authorized Indonesian shop not found");
    const connection = await this.prisma.integrationConnection.findUnique({ where: { shopId_provider: { shopId: shop.id, provider: "TIKTOK_SHOP" } } });
    if (!connection) throw new BadRequestException("This shop is not associated with the current seller authorization");
    const granted = Array.isArray(connection.grantedScopes) ? connection.grantedScopes.filter((scope): scope is string => typeof scope === "string") : [];
    const missingScopes = REQUIRED_READ_SCOPES.filter((scope) => !granted.includes(scope));
    if (missingScopes.length) throw new BadRequestException(`Reauthorize with required scopes: ${missingScopes.join(", ")}`);
    await this.prisma.$transaction([
      this.prisma.shop.updateMany({ where: { connectionMode: "READ_ONLY" }, data: { selectedForReadOnly: false } }),
      this.prisma.shop.update({ where: { id: shop.id }, data: { selectedForReadOnly: true } }),
      this.prisma.integrationConnection.update({ where: { id: connection.id }, data: { status: "HEALTHY", lastValidatedAt: new Date() } })
    ]);
    return this.status();
  }

  async creatorPerformance(creatorOpenId: string) {
    const shop = await this.activeShop();
    const candidate = await (await this.adapter()).getCreatorPerformance(creatorOpenId);
    const creator = await this.prisma.creator.upsert({ where: { creatorOpenId: candidate.creatorOpenId }, update: {
      creatorUserId: candidate.creatorUserId, username: candidate.username, nickname: candidate.nickname, selectionRegion: candidate.selectionRegion
    }, create: { creatorOpenId: candidate.creatorOpenId, creatorUserId: candidate.creatorUserId, username: candidate.username, nickname: candidate.nickname, selectionRegion: candidate.selectionRegion } });
    const snapshot = await this.prisma.creatorMetricSnapshot.create({ data: {
      creatorId: creator.id, followerCount: candidate.followerCount, categoryIds: candidate.categoryIds,
      gmvAmount: candidate.gmv ? new Prisma.Decimal(candidate.gmv.amount) : null, gmvCurrency: candidate.gmv?.currency,
      unitsSold: candidate.unitsSold, avgVideoViews: candidate.avgVideoViews, avgLiveViewers: candidate.avgLiveViewers,
      engagementRate: candidate.engagementRate == null ? null : new Prisma.Decimal(candidate.engagementRate), sourceFetchedAt: new Date(),
      rawPayload: candidate as unknown as Prisma.InputJsonValue, metrics: { window: "LAST_30_DAYS", shopId: shop.id }
    } });
    return { creator: candidate, snapshotId: snapshot.id, sourceWindow: "LAST_30_DAYS" };
  }

  private async selectedShop() {
    const shop = await this.prisma.shop.findFirst({ where: { connectionMode: "READ_ONLY", selectedForReadOnly: true } });
    if (!shop?.shopCipher) throw new ServiceUnavailableException("A real authorized shop must be explicitly selected");
    return shop;
  }

  async validAccessToken(): Promise<string> {
    const shop = await this.selectedShop();
    const credentials = this.credentials();
    const margin = config.TIKTOK_TOKEN_REFRESH_MARGIN_SECONDS * 1000;
    const connection = await this.prisma.integrationConnection.findUniqueOrThrow({ where: { shopId_provider: { shopId: shop.id, provider: "TIKTOK_SHOP" } } });
    if (!connection.accessTokenCiphertext || !connection.accessTokenExpiresAt) throw new ServiceUnavailableException("TikTok access token is unavailable; reauthorization required");
    if (connection.accessTokenExpiresAt.getTime() > Date.now() + margin) return decryptTikTokToken(connection.accessTokenCiphertext, credentials.encryptionKey);
    return this.refreshToken(shop.id);
  }

  async refreshToken(shopId?: string): Promise<string> {
    const target = shopId ? await this.prisma.shop.findUniqueOrThrow({ where: { id: shopId } }) : await this.selectedShop();
    const credentials = this.credentials();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tiktok-token:${target.id}`}))`;
        const connection = await tx.integrationConnection.findUniqueOrThrow({ where: { shopId_provider: { shopId: target.id, provider: "TIKTOK_SHOP" } } });
        const margin = config.TIKTOK_TOKEN_REFRESH_MARGIN_SECONDS * 1000;
        if (connection.accessTokenCiphertext && connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() > Date.now() + margin) {
          return decryptTikTokToken(connection.accessTokenCiphertext, credentials.encryptionKey);
        }
        if (!connection.refreshTokenCiphertext || !connection.refreshTokenExpiresAt || connection.refreshTokenExpiresAt <= new Date()) throw new TikTokAuthorizationError("REFRESH_TOKEN_EXPIRED", "TikTok reauthorization is required");
        const previousRefresh = decryptTikTokToken(connection.refreshTokenCiphertext, credentials.encryptionKey);
        const auth = new TikTokSellerAuthClient({ baseUrl: config.TIKTOK_AUTH_BASE_URL, appKey: credentials.appKey, appSecret: credentials.appSecret });
        const refreshed = await auth.refresh(previousRefresh);
        await tx.integrationConnection.update({ where: { id: connection.id }, data: {
          accessTokenCiphertext: encryptTikTokToken(refreshed.accessToken, credentials.encryptionKey), refreshTokenCiphertext: encryptTikTokToken(refreshed.refreshToken, credentials.encryptionKey),
          accessTokenExpiresAt: refreshed.accessTokenExpiresAt, refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt, grantedScopes: refreshed.grantedScopes,
          sellerOpenId: refreshed.sellerOpenId ?? connection.sellerOpenId, lastRefreshAt: new Date(), lastValidatedAt: new Date(), status: "HEALTHY",
          refreshFailureCount: 0, lastErrorCode: null, lastErrorMessage: null
        } });
        return refreshed.accessToken;
      }, { timeout: 20_000 });
    } catch (error) {
      await this.prisma.integrationConnection.updateMany({ where: { shopId: target.id, provider: "TIKTOK_SHOP" }, data: {
        status: "REAUTHORIZATION_REQUIRED", lastRefreshFailureAt: new Date(), refreshFailureCount: { increment: 1 },
        lastErrorCode: error instanceof TikTokAuthorizationError ? error.code : "TOKEN_REFRESH_FAILED", lastErrorMessage: error instanceof Error ? error.message.slice(0, 500) : "Token refresh failed"
      } });
      throw new ServiceUnavailableException("TikTok token refresh failed; reauthorization is required");
    }
  }

  async status() {
    if (config.APP_MODE === "mock") {
      const shop = await ensureMockShop(this.prisma);
      return { mode: "MOCK", configurationState: "MOCK_READY", shop, capabilities: await this.mock.getCapabilities(), outboundEnabled: true, outboundProvider: "MOCK_ONLY" };
    }
    const shops = await this.prisma.shop.findMany({ where: { connectionMode: "READ_ONLY" }, orderBy: { createdAt: "asc" } });
    const selected = shops.find((shop) => shop.selectedForReadOnly);
    const connection = selected ? await this.prisma.integrationConnection.findUnique({ where: { shopId_provider: { shopId: selected.id, provider: "TIKTOK_SHOP" } } }) : await this.prisma.integrationConnection.findFirst({ where: { mode: "READ_ONLY" }, orderBy: { updatedAt: "desc" } });
    return {
      mode: "READ_ONLY", configurationState: this.configured ? connection ? connection.status : "AUTHORIZATION_REQUIRED" : "READ_ONLY_NOT_CONFIGURED",
      outboundEnabled: false, outboundProvider: "PHYSICALLY_UNAVAILABLE", readOnlyStatus: "REAL TIKTOK — READ ONLY",
      selectedShop: selected ? { id: selected.id, externalShopId: selected.externalShopId, name: selected.name, region: selected.region, code: selected.shopCode } : null,
      authorizedShops: shops.map((shop) => ({ id: shop.id, externalShopId: shop.externalShopId, name: shop.name, region: shop.region, code: shop.shopCode, selected: shop.selectedForReadOnly })),
      connection: connection ? publicTikTokConnection(connection) : null
    };
  }
}
