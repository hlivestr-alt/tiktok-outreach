import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { SafeExceptionFilter } from "./safe-exception.filter";

function host(send: ReturnType<typeof vi.fn>, header: ReturnType<typeof vi.fn>) {
  const response = {
    header,
    status: vi.fn(() => ({ send }))
  };
  header.mockReturnValue(response);
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: "POST", url: "/api/v1/outreach/campaigns/campaign-1/send" })
    })
  } as any;
}

describe("SafeExceptionFilter", () => {
  it("preserves known safe HTTP errors", () => {
    const send = vi.fn();
    const header = vi.fn();
    new SafeExceptionFilter().catch(new BadRequestException("Preview is stale"), host(send, header));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: "Preview is stale" }));
    expect(header).not.toHaveBeenCalled();
  });

  it("hides unexpected details and returns a correlation ID", () => {
    const send = vi.fn();
    const header = vi.fn();
    new SafeExceptionFilter().catch(new Error("postgresql://user:secret@db/internal/path"), host(send, header));
    const body = send.mock.calls[0][0];
    expect(body).toMatchObject({ statusCode: 500, message: "Unable to complete the request." });
    expect(body.errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(header).toHaveBeenCalledWith("x-error-id", body.errorId);
  });
});
