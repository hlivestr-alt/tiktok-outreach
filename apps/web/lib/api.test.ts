import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

function successfulFetch() {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => vi.unstubAllGlobals());

describe("web API helper headers", () => {
  it("does not add JSON content type to a bodyless GET", async () => {
    const fetcher = successfulFetch(); vi.stubGlobal("fetch", fetcher);
    await api("/bodyless");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has("Content-Type")).toBe(false);
  });

  it("does not add JSON content type to a bodyless POST", async () => {
    const fetcher = successfulFetch(); vi.stubGlobal("fetch", fetcher);
    await api("/bodyless", { method: "POST" });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has("Content-Type")).toBe(false);
  });

  it("adds JSON content type to a string body POST", async () => {
    const fetcher = successfulFetch(); vi.stubGlobal("fetch", fetcher);
    await api("/json", { method: "POST", body: JSON.stringify({ value: 1 }) });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Content-Type")).toBe("application/json");
  });

  it("preserves explicit caller headers", async () => {
    const fetcher = successfulFetch(); vi.stubGlobal("fetch", fetcher);
    await api("/explicit", { method: "POST", body: "value=1", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test": "preserved" } });
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(headers.get("X-Test")).toBe("preserved");
  });
});
