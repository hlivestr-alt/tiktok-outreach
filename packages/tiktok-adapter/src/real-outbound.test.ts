import { describe, expect, it, vi } from "vitest";
import { parseRetryAfterMs, RealTikTokOutboundAdapter, TikTokOutboundError } from "./real-outbound";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "x-tts-request-id": "header-request" } });
const adapter = (fetcher: typeof fetch) => new RealTikTokOutboundAdapter({
  baseUrl: "https://open-api.tiktokglobalshop.com", appKey: "app", appSecret: "secret",
  accessToken: async () => "token", shopCipher: async () => "cipher", fetch: fetcher, now: () => 1_700_000_000_000
});

describe("real outbound mutation boundary", () => {
  it("uses only the documented create and send paths and parses positive evidence", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 0, data: { conversation_id: "conversation-1", is_new: true }, request_id: "r1" }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: "message-1" }, request_id: "r2" }));
    const client = adapter(fetcher);
    await expect(client.createOrGetConversation("creator-open-id")).resolves.toEqual({ conversationId: "conversation-1", isNew: true });
    await expect(client.sendMessage("conversation-1", "creator-open-id", "hello", { idempotencyKey: "local-only" })).resolves.toEqual({ status: "SENT", messageId: "message-1", requestId: "r2", httpStatus: 200 });
    expect(fetcher.mock.calls.map((call) => new URL(String(call[0])).pathname)).toEqual([
      "/affiliate_seller/202508/conversations", "/affiliate_seller/202412/conversations/conversation-1/messages"
    ]);
    expect(String(fetcher.mock.calls[1][1]?.body)).not.toContain("local-only");
  });

  it("classifies structured restrictions and never retries an ambiguous send", async () => {
    const restricted = adapter(vi.fn<typeof fetch>().mockResolvedValue(response({ code: 16030100, message: "quota", request_id: "r" }, 400)));
    await expect(restricted.sendMessage("c", "o", "hello", { idempotencyKey: "k" })).resolves.toMatchObject({ status: "RESTRICTED", errorCode: "16030100" });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("reset"));
    await expect(adapter(fetcher).sendMessage("c", "o", "hello", { idempotencyKey: "k" })).resolves.toMatchObject({ status: "DELIVERY_UNKNOWN" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("surfaces terminal permission errors for worker-wide safety pause", async () => {
    const client = adapter(vi.fn<typeof fetch>().mockResolvedValue(response({ code: 105005, request_id: "r" }, 403)));
    await expect(client.sendMessage("c", "o", "hello", { idempotencyKey: "k" })).rejects.toMatchObject({ kind: "PERMISSION" } satisfies Partial<TikTokOutboundError>);
  });

  it("distinguishes shop-wide IM quota from a recipient restriction", async () => {
    const client = adapter(vi.fn<typeof fetch>().mockResolvedValue(response({ code: 16030002, request_id: "quota-r" }, 400)));
    await expect(client.createOrGetConversation("creator-open-id")).rejects.toMatchObject({
      kind: "QUOTA", providerCode: 16030002, operation: "CREATE_CONVERSATION"
    } satisfies Partial<TikTokOutboundError>);
    const endpointQuota = adapter(vi.fn<typeof fetch>().mockResolvedValue(response({ code: 45101004, request_id: "daily-quota-r" }, 400)));
    await expect(endpointQuota.sendMessage("conversation", "creator-open-id", "hello", { idempotencyKey: "key" })).rejects.toMatchObject({
      kind: "QUOTA", providerCode: 45101004, operation: "SEND_MESSAGE"
    } satisfies Partial<TikTokOutboundError>);
  });

  it("preserves Retry-After and treats provider throttles as retryable", async () => {
    const throttled = new Response(JSON.stringify({ code: 36009002, request_id: "throttle-r" }), {
      status: 429, headers: { "retry-after": "17", "x-tts-request-id": "header-r" }
    });
    await expect(adapter(vi.fn<typeof fetch>().mockResolvedValue(throttled))
      .sendMessage("c", "o", "hello", { idempotencyKey: "k" }))
      .resolves.toMatchObject({ status: "RETRYABLE_ERROR", errorCode: "36009002", retryAfterMs: 17_000, httpStatus: 429 });
    expect(parseRetryAfterMs("Wed, 15 Nov 2023 00:00:10 GMT", Date.parse("2023-11-15T00:00:00Z"))).toBe(10_000);

    const emptyThrottle = new Response("not-json", { status: 429, headers: { "retry-after": "9" } });
    await expect(adapter(vi.fn<typeof fetch>().mockResolvedValue(emptyThrottle))
      .sendMessage("c", "o", "hello", { idempotencyKey: "k" }))
      .resolves.toMatchObject({ status: "RETRYABLE_ERROR", retryAfterMs: 9_000, httpStatus: 429 });
  });
});
