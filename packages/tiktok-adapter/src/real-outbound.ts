import type { SendMessageResult, TikTokOutboundAdapter } from "@affiliate/contracts";
import { signTikTokShopRequest } from "./signing";

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

export type TikTokOutboundErrorKind = "AUTH" | "PERMISSION" | "RESTRICTED" | "RETRYABLE" | "PROVIDER" | "MALFORMED_RESPONSE";

export class TikTokOutboundError extends Error {
  constructor(
    readonly kind: TikTokOutboundErrorKind,
    readonly operation: "CREATE_CONVERSATION" | "SEND_MESSAGE",
    readonly providerCode: number | undefined,
    readonly requestId: string | undefined,
    message: string,
    readonly retryAfterMs?: number
  ) { super(message); }
}

const restrictedCreateCodes = new Set([16030001, 16030002, 16030003, 16030007, 16030009, 16032001, 45101021]);
const restrictedSendCodes = new Set([16030100, 16030101, 16032001]);
const authCodes = new Set([105001, 105002]);
const permissionCodes = new Set([105005]);
const retryableCodes = new Set([36009003, 36009007, 45101004]);
const asObject = (value: unknown): JsonObject | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const asString = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
const asNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * A mutation-only client. It intentionally contains no Marketplace or history
 * methods, performs no automatic HTTP retry, and never implements Mark Read.
 */
export class RealTikTokOutboundAdapter implements TikTokOutboundAdapter {
  constructor(private readonly options: {
    baseUrl: string;
    appKey: string;
    appSecret: string;
    accessToken: () => Promise<string>;
    shopCipher: () => Promise<string>;
    fetch?: FetchLike;
    now?: () => number;
  }) {}

  private async request(operation: "CREATE_CONVERSATION" | "SEND_MESSAGE", path: string, body: JsonObject): Promise<JsonObject> {
    const timestamp = Math.floor((this.options.now ?? Date.now)() / 1000);
    const query = { app_key: this.options.appKey, timestamp, shop_cipher: await this.options.shopCipher() };
    const encodedBody = JSON.stringify(body);
    const sign = signTikTokShopRequest({ path, query, body: encodedBody, contentType: "application/json", appSecret: this.options.appSecret });
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries({ ...query, sign })) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tts-access-token": await this.options.accessToken() },
        body: encodedBody
      });
    } catch (cause) {
      // For Send Message the request outcome is ambiguous. The caller must not retry.
      if (operation === "SEND_MESSAGE") return { __deliveryUnknown: true };
      throw new TikTokOutboundError("RETRYABLE", operation, undefined, undefined, "TikTok conversation request did not receive a response", 5000);
    }
    const headerRequestId = response.headers.get("x-tts-request-id") ?? undefined;
    let decoded: JsonObject;
    try { decoded = asObject(await response.json()) ?? {}; }
    catch {
      if (operation === "SEND_MESSAGE") return { __deliveryUnknown: true, request_id: headerRequestId };
      throw new TikTokOutboundError(response.status >= 500 ? "RETRYABLE" : "MALFORMED_RESPONSE", operation, undefined, headerRequestId, "TikTok returned a non-JSON conversation response", 5000);
    }
    const code = asNumber(decoded.code);
    const requestId = asString(decoded.request_id) ?? headerRequestId;
    if (response.ok && code === 0) return decoded;
    const kind: TikTokOutboundErrorKind = authCodes.has(code ?? -1) ? "AUTH"
      : permissionCodes.has(code ?? -1) ? "PERMISSION"
      : (operation === "CREATE_CONVERSATION" ? restrictedCreateCodes : restrictedSendCodes).has(code ?? -1) ? "RESTRICTED"
      : response.status === 429 || response.status >= 500 || retryableCodes.has(code ?? -1) ? "RETRYABLE" : "PROVIDER";
    throw new TikTokOutboundError(kind, operation, code, requestId, `TikTok ${operation.toLowerCase().replaceAll("_", " ")} was rejected`, kind === "RETRYABLE" ? 5000 : undefined);
  }

  async createOrGetConversation(creatorOpenId: string): Promise<{ conversationId: string; isNew: boolean }> {
    const response = await this.request("CREATE_CONVERSATION", "/affiliate_seller/202508/conversations", {
      creator_open_id: creatorOpenId,
      only_need_conversation_id: true
    });
    const data = asObject(response.data);
    const conversationId = asString(data?.conversation_id);
    if (!conversationId) throw new TikTokOutboundError("MALFORMED_RESPONSE", "CREATE_CONVERSATION", 0, asString(response.request_id), "TikTok did not return a conversation ID");
    return { conversationId, isNew: data?.is_new === true };
  }

  async sendMessage(conversationId: string, _creatorOpenId: string, content: string, _options: { idempotencyKey: string }): Promise<SendMessageResult> {
    try {
      const response = await this.request("SEND_MESSAGE", `/affiliate_seller/202412/conversations/${encodeURIComponent(conversationId)}/messages`, {
        msg_type: "TEXT",
        content: JSON.stringify({ content })
      });
      const requestId = asString(response.request_id) ?? "unknown-request";
      if (response.__deliveryUnknown === true) return { status: "DELIVERY_UNKNOWN", requestId };
      const messageId = asString(asObject(response.data)?.message_id);
      return messageId ? { status: "SENT", messageId, requestId } : { status: "DELIVERY_UNKNOWN", requestId };
    } catch (error) {
      if (!(error instanceof TikTokOutboundError)) return { status: "DELIVERY_UNKNOWN", requestId: "unknown-request" };
      if (error.kind === "RESTRICTED") return { status: "RESTRICTED", requestId: error.requestId ?? "unknown-request", errorCode: String(error.providerCode ?? "RESTRICTED") };
      if (error.kind === "RETRYABLE") return { status: "RETRYABLE_ERROR", requestId: error.requestId ?? "unknown-request", errorCode: String(error.providerCode ?? "TEMPORARY"), retryAfterMs: error.retryAfterMs ?? 5000 };
      throw error;
    }
  }
}
