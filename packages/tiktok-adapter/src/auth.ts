export type TikTokSellerTokens = {
  accessToken: string; refreshToken: string; accessTokenExpiresAt: Date; refreshTokenExpiresAt: Date;
  sellerOpenId?: string; userType: number; grantedScopes: string[];
};

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

export class TikTokAuthorizationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const text = (value: unknown) => typeof value === "string" && value.length ? value : undefined;
const numeric = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;

export class TikTokSellerAuthClient {
  constructor(private readonly options: { baseUrl: string; appKey: string; appSecret: string; fetch?: FetchLike }) {}

  exchange(authCode: string): Promise<TikTokSellerTokens> {
    if (!authCode || authCode === "null") throw new TikTokAuthorizationError("MALFORMED_CALLBACK", "Authorization code is missing");
    return this.request("/api/v2/token/get", { auth_code: authCode, grant_type: "authorized_code" });
  }

  refresh(refreshToken: string): Promise<TikTokSellerTokens> {
    if (!refreshToken) throw new TikTokAuthorizationError("MISSING_REFRESH_TOKEN", "Refresh token is missing");
    return this.request("/api/v2/token/refresh", { refresh_token: refreshToken, grant_type: "refresh_token" });
  }

  private async request(path: string, values: Record<string, string>): Promise<TikTokSellerTokens> {
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries({ app_key: this.options.appKey, app_secret: this.options.appSecret, ...values })) url.searchParams.set(key, value);
    let response: Response;
    try { response = await (this.options.fetch ?? fetch)(url, { method: "GET", headers: { accept: "application/json" } }); }
    catch { throw new TikTokAuthorizationError("TOKEN_NETWORK_ERROR", "TikTok token service is temporarily unavailable"); }
    let payload: JsonObject;
    try { payload = await response.json() as JsonObject; }
    catch { throw new TikTokAuthorizationError("TOKEN_MALFORMED_RESPONSE", "TikTok token response was not valid JSON"); }
    const code = numeric(payload.code);
    if (!Number.isFinite(code) || (!response.ok && code === 0)) {
      throw new TikTokAuthorizationError("TOKEN_MALFORMED_RESPONSE", "TikTok token response did not contain a trustworthy outcome");
    }
    if (code !== 0) throw new TikTokAuthorizationError(`TIKTOK_TOKEN_${code}`, text(payload.message) ?? "TikTok token request failed");
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data as JsonObject : payload;
    const accessToken = text(data.access_token), refreshToken = text(data.refresh_token);
    const accessExpiry = numeric(data.access_token_expire_in), refreshExpiry = numeric(data.refresh_token_expire_in), userType = numeric(data.user_type);
    if (!accessToken || !refreshToken || !Number.isFinite(accessExpiry) || !Number.isFinite(refreshExpiry) || !Number.isFinite(userType)) {
      throw new TikTokAuthorizationError("TOKEN_MALFORMED_RESPONSE", "TikTok token response omitted required fields");
    }
    if (userType !== 0) throw new TikTokAuthorizationError("WRONG_AUTHORIZATION_IDENTITY", "A seller authorization is required");
    const grantedValue = data.granted_scopes ?? data.granted_permissions;
    const rawScopes = Array.isArray(grantedValue) ? grantedValue : typeof grantedValue === "string" ? grantedValue.split(",") : [];
    return {
      accessToken, refreshToken, accessTokenExpiresAt: new Date(accessExpiry * 1000), refreshTokenExpiresAt: new Date(refreshExpiry * 1000),
      sellerOpenId: text(data.open_id), userType, grantedScopes: rawScopes.filter((scope): scope is string => typeof scope === "string" && Boolean(scope.trim())).map((scope) => scope.trim())
    };
  }
}
