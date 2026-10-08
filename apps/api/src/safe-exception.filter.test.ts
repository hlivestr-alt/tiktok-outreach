import { BadRequestException, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
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
    const log = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    const send = vi.fn();
    const header = vi.fn();
    new SafeExceptionFilter().catch(new Error("postgresql://user:secret@db/internal/path"), host(send, header));
    const body = send.mock.calls[0][0];
    expect(body).toMatchObject({ statusCode: 500, message: "Unable to complete the request." });
    expect(body.errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(header).toHaveBeenCalledWith("x-error-id", body.errorId);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    log.mockRestore();
  });

  it("never emits callback parameters, arbitrary exception text or stacks", () => {
    const marker = randomBytes(32).toString("base64url");
    const log = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    const send = vi.fn(), header = vi.fn(), response = { header, status: () => ({ send }) };
    header.mockReturnValue(response);
    const names = ["code", "state", "access_token", "refresh_token", "token", "authorization", "auth_code", "secret"];
    const request = { method: "GET", url: "/api/v1/integrations/tiktok/callback?" + names.map(n => `${n}=${marker}`).join("&"), routeOptions: { url: "/api/v1/integrations/tiktok/callback" } };
    new SafeExceptionFilter().catch(new Error(marker), { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as any);
    expect(JSON.stringify([log.mock.calls, send.mock.calls, header.mock.calls]).includes(marker)).toBe(false);
    expect(log.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ method: "GET", pathname: request.routeOptions.url, category: "UNEXPECTED_REQUEST_FAILURE" });
    log.mockRestore();
  });
});
