import { describe, expect, it, vi } from "vitest";
import type { CreatorCandidate } from "@affiliate/domain";
import { GoogleSheetsCreatorGateway, GoogleSheetsError } from "./creator-sheet.gateway";

function creator(id: string, nickname = "Creator"): CreatorCandidate {
  return { creatorOpenId: id, username: id, nickname, categoryIds: ["beauty"], followerCount: 1_000, selectionRegion: "ID", discoveryOrdinal: 0 };
}

describe("Google Sheets creator gateway", () => {
  it.each([
    [{ code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" }, false],
    [{ code: 404, status: "NOT_FOUND", message: "Requested entity was not found" }, false],
    [{ code: 400, status: "INVALID_ARGUMENT", message: "Unable to parse range" }, false],
    [{ code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" }, true],
    [{ code: 503, status: "UNAVAILABLE", message: "Backend unavailable" }, true]
  ])("classifies Google response %s as retryable=%s", async (error, retryable) => {
    const gateway = new GoogleSheetsCreatorGateway();
    (gateway as any).accessToken = { value: "test-token", expiresAt: Date.now() + 600_000 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error }), { status: error.code, headers: { "content-type": "application/json" } })));
    await expect((gateway as any).request("https://sheets.test/request")).rejects.toSatisfy((failure: unknown) => {
      expect(failure).toBeInstanceOf(GoogleSheetsError);
      expect((failure as GoogleSheetsError).details).toMatchObject({ httpStatus: error.code, retryable });
      expect((failure as GoogleSheetsError).details.googleApiCode).toContain(error.status);
      return true;
    });
    vi.unstubAllGlobals();
  });

  it("deduplicates creator IDs before appending and reconciles a retried append without a duplicate row", async () => {
    const gateway = new GoogleSheetsCreatorGateway();
    (gateway as any).accessToken = { value: "test-token", expiresAt: Date.now() + 600_000 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ values: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ values: [[1, "id", "Creator", "open-1"]] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await gateway.reconcilePage("sheet-test", [creator("open-1", "First"), creator("open-1", "Updated")]);
    const firstAppend = JSON.parse(fetchMock.mock.calls[1][1].body as string) as { values: unknown[][] };
    expect(firstAppend.values).toHaveLength(1);

    await gateway.reconcilePage("sheet-test", [creator("open-1", "Updated")]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((JSON.parse(fetchMock.mock.calls[3][1].body as string) as { data: unknown[] }).data).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
