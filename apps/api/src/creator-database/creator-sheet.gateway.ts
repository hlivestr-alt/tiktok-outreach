import { createSign } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { CreatorCandidate, Money } from "@affiliate/domain";
import { config } from "../shared";

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
type SheetValues = { values?: unknown[][] };

export type GoogleSheetsFailureDetails = {
  httpStatus?: number;
  googleApiCode?: string;
  retryable: boolean;
  safeReason?: string;
};

export class GoogleSheetsError extends Error {
  constructor(readonly details: GoogleSheetsFailureDetails, options?: { cause?: unknown }) {
    super("Google Sheets request failed", options);
  }
}

export type CreatorSheet = Pick<GoogleSheetsCreatorGateway, "readCreators" | "reconcilePage">;

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function text(value: unknown): string | undefined {
  const normalized = value == null ? "" : String(value).trim();
  return normalized || undefined;
}

function numeric(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized
    .replace(/bearer\s+[a-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*[^,; ]+/gi, "$1=[redacted]")
    .slice(0, 240);
}

type GoogleErrorPayload = { error?: { code?: unknown; message?: unknown; status?: unknown; errors?: Array<{ reason?: unknown; message?: unknown }> } };

function providerCode(payload: GoogleErrorPayload): string | undefined {
  const error = payload.error;
  if (!error) return undefined;
  const status = text(error.status);
  const code = typeof error.code === "number" || typeof error.code === "string" ? String(error.code) : undefined;
  if (status && code && status !== code) return `${status} (${code})`;
  return status ?? code;
}

function responseIsRetryable(httpStatus: number | undefined, payload: GoogleErrorPayload): boolean {
  const error = payload.error;
  const status = text(error?.status)?.toUpperCase();
  const reasons = (error?.errors ?? []).map((item) => text(item.reason)?.toLowerCase()).filter(Boolean);
  if (["rateLimitExceeded", "userRateLimitExceeded", "backendError"].some((reason) => reasons.includes(reason))) return true;
  if (["RESOURCE_EXHAUSTED", "UNAVAILABLE", "DEADLINE_EXCEEDED", "INTERNAL", "ABORTED"].includes(status ?? "")) return true;
  if (httpStatus == null) return true;
  if (httpStatus === 408 || httpStatus === 409 || httpStatus === 425 || httpStatus === 429) return true;
  return httpStatus >= 500;
}

function failureFromResponse(httpStatus: number | undefined, payload: GoogleErrorPayload, fallback: string): GoogleSheetsError {
  const error = payload.error;
  const retryable = responseIsRetryable(httpStatus, payload);
  return new GoogleSheetsError({
    httpStatus,
    googleApiCode: providerCode(payload),
    retryable,
    safeReason: safeProviderMessage(error?.message) ?? safeProviderMessage(fallback)
  });
}

export function googleSheetsFailure(error: unknown): GoogleSheetsFailureDetails {
  if (error instanceof GoogleSheetsError) return error.details;
  return { retryable: true, safeReason: "provider response unavailable" };
}

function money(amount: unknown, currency = "USD"): Money | null {
  const value = numeric(amount);
  return value == null ? null : { amount: String(value), currency };
}

function sheetRow(creator: CreatorCandidate, recordNumber: number): unknown[] {
  return [
    recordNumber, creator.username ?? "", creator.nickname ?? "", creator.creatorOpenId,
    creator.followerCount ?? "", creator.avgVideoViews ?? "", creator.avgLiveViewers ?? "",
    creator.gmv?.amount ?? "", creator.liveGmv?.amount ?? "", creator.videoGmv?.amount ?? "",
    creator.gmvRange ?? "", creator.categoryIds.join(", "), creator.selectionRegion,
    creator.topAgeRanges?.join(", ") ?? "", creator.majorGender ?? "",
    creator.majorGenderPercentage ?? "", creator.avatarUrl ?? ""
  ];
}

function candidateFromRow(row: unknown[], ordinal: number): CreatorCandidate | null {
  const creatorOpenId = text(row[3]);
  if (!creatorOpenId) return null;
  return {
    creatorOpenId, username: text(row[1]), nickname: text(row[2]),
    followerCount: numeric(row[4]), avgVideoViews: numeric(row[5]), avgLiveViewers: numeric(row[6]),
    gmv: money(row[7]), liveGmv: money(row[8]), videoGmv: money(row[9]), gmvRange: text(row[10]),
    categoryIds: text(row[11])?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
    selectionRegion: text(row[12]) ?? "UNKNOWN",
    topAgeRanges: text(row[13])?.split(",").map((value) => value.trim()).filter(Boolean),
    majorGender: text(row[14]), majorGenderPercentage: numeric(row[15]) ?? undefined,
    avatarUrl: text(row[16]), unitsSold: null, discoveryOrdinal: ordinal
  };
}

@Injectable()
export class GoogleSheetsCreatorGateway {
  private accessToken?: { value: string; expiresAt: number };

  private credentials(): ServiceAccount {
    const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
    if (!raw) throw new GoogleSheetsError({ retryable: false, googleApiCode: "INVALID_CONFIGURATION", safeReason: "service account is not configured" });
    try {
      const decoded = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
      const credentials = JSON.parse(decoded) as Partial<ServiceAccount>;
      if (!credentials.client_email || !credentials.private_key) throw new Error("missing fields");
      return credentials as ServiceAccount;
    } catch {
      throw new GoogleSheetsError({ retryable: false, googleApiCode: "INVALID_CONFIGURATION", safeReason: "service account configuration is invalid" });
    }
  }

  private async token() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const credentials = this.credentials();
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64url(JSON.stringify({
      iss: credentials.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: credentials.token_uri ?? "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
    }));
    let assertion: string;
    try {
      const signer = createSign("RSA-SHA256"); signer.update(`${header}.${claim}`); signer.end();
      assertion = `${header}.${claim}.${signer.sign(credentials.private_key, "base64url")}`;
    } catch (error) {
      throw new GoogleSheetsError({ retryable: false, googleApiCode: "INVALID_CONFIGURATION", safeReason: "service account key is invalid" }, { cause: error });
    }
    let response: Response;
    try {
      response = await fetch(credentials.token_uri ?? "https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
      });
    } catch (error) {
      throw new GoogleSheetsError({ retryable: true, safeReason: "authentication request failed before a response" }, { cause: error });
    }
    const payload = await response.json().catch(() => ({})) as GoogleErrorPayload & { access_token?: string; expires_in?: number };
    if (!response.ok) throw failureFromResponse(response.status, payload, "Google authentication failed");
    if (!payload.access_token) throw new GoogleSheetsError({ httpStatus: response.status, googleApiCode: "INVALID_RESPONSE", retryable: true, safeReason: "authentication response returned no access token" });
    this.accessToken = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 };
    return payload.access_token;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json", ...init?.headers } });
    } catch (error) {
      if (error instanceof GoogleSheetsError) throw error;
      throw new GoogleSheetsError({ retryable: true, safeReason: "request failed before a response" }, { cause: error });
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as GoogleErrorPayload;
      throw failureFromResponse(response.status, payload, "Google Sheets request failed");
    }
    try {
      return await response.json() as T;
    } catch (error) {
      throw new GoogleSheetsError({ httpStatus: response.status, googleApiCode: "INVALID_RESPONSE", retryable: true, safeReason: "Google returned an unreadable response" }, { cause: error });
    }
  }

  private valuesUrl(spreadsheetId: string, range: string) {
    return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  }

  async readCreators(spreadsheetId: string): Promise<CreatorCandidate[]> {
    const payload = await this.request<SheetValues>(`${this.valuesUrl(spreadsheetId, "Creators!A2:Q")}?valueRenderOption=UNFORMATTED_VALUE`);
    return (payload.values ?? []).map(candidateFromRow).filter((value): value is CreatorCandidate => Boolean(value));
  }

  async reconcilePage(spreadsheetId: string, creators: CreatorCandidate[]): Promise<void> {
    const existing = await this.request<SheetValues>(`${this.valuesUrl(spreadsheetId, "Creators!A2:Q")}?valueRenderOption=UNFORMATTED_VALUE`);
    const rows = existing.values ?? [];
    const rowByCreator = new Map<string, number>();
    rows.forEach((row, index) => { const id = text(row[3]); if (id && !rowByCreator.has(id)) rowByCreator.set(id, index + 2); });
    const updates: Array<{ range: string; values: unknown[][] }> = [];
    const additions: unknown[][] = [];
    const uniqueCreators = [...new Map(creators.map((creator) => [creator.creatorOpenId, creator])).values()];
    for (const creator of uniqueCreators) {
      const rowNumber = rowByCreator.get(creator.creatorOpenId);
      if (rowNumber) updates.push({ range: `Creators!A${rowNumber}:Q${rowNumber}`, values: [sheetRow(creator, rowNumber - 1)] });
      else additions.push(sheetRow(creator, rows.length + additions.length + 1));
    }
    if (updates.length) await this.request(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
      method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data: updates })
    });
    if (additions.length) await this.request(`${this.valuesUrl(spreadsheetId, "Creators!A:Q")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST", body: JSON.stringify({ values: additions })
    });
  }
}
