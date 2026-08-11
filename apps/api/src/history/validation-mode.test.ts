import { describe, expect, it, vi } from "vitest";
import { RealTikTokReadOnlyAffiliateAdapter, TikTokReadOnlyHttpClient } from "@affiliate/tiktok-adapter";
import { HistoryService } from "./history.service";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function adapter(fetcher: typeof fetch) {
  return new RealTikTokReadOnlyAffiliateAdapter({
    http: new TikTokReadOnlyHttpClient({ baseUrl: "https://provider.example.test", appKey: "a", appSecret: "s", fetch: fetcher, validationMode: true }),
    accessToken: async () => "prepared-token", shopCipher: async () => "cipher"
  });
}

describe("controlled history validation", () => {
  it("sync validation reads one conversation page and never enters conversation messages", async () => {
    const fetcher = vi.fn(async () => json({ code: 0, data: {
      has_more: true, next_page_token: "conversation-page-2",
      conversations: [{ id: "conversation-1", creator_im_id: "creator-im-1" }]
    } }));
    const service = new HistoryService({} as any, {} as any);
    const result = await service.syncMockHistory(adapter(fetcher as typeof fetch), "REAL_TIKTOK_READ_ONLY", true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/affiliate_seller/202412/conversations");
    expect(result).toMatchObject({ validationMode: true, providerCallCeiling: 1, providerPagesInspected: 1, providerHasMore: true });
  });

  it("message validation reads exactly one page for the selected conversation", async () => {
    const fetcher = vi.fn(async () => json({ code: 0, data: {
      has_more: true, next_page_token: "message-page-2", messages: [{ message_body: {
        id: "message-1", conversation_id: "conversation-1", sender_id: "creator-im-1",
        type: "TEXT", content: "{\"content\":\"hello\"}", create_time: 1691411573
      } }]
    } }));
    const service = new HistoryService({} as any, {} as any);
    const result = await service.validateMessageList("conversation-1", "creator-im-1", adapter(fetcher as typeof fetch));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/affiliate_seller/202412/conversation/conversation-1/messages");
    expect(result).toMatchObject({ validationMode: true, providerCallCeiling: 1, providerPagesInspected: 1, providerHasMore: true, conversationId: "conversation-1" });
  });
});
