import { describe, expect, it } from "vitest";
import { liveOutboundExplicitlyEnabled, loadConfig } from "./index";

const base = { DATABASE_URL: "postgresql://localhost/test" };
describe("outbound activation", () => {
  it("defaults mock and real environments to their safe provider modes", () => {
    expect(loadConfig({ ...base, APP_MODE: "mock" }).OUTBOUND_MODE).toBe("mock");
    expect(loadConfig({ ...base, APP_MODE: "read_only" }).OUTBOUND_MODE).toBe("read_only");
  });
  it("requires both live mode and the exact acknowledgement", () => {
    expect(liveOutboundExplicitlyEnabled(loadConfig({ ...base, APP_MODE: "read_only", OUTBOUND_MODE: "live" }))).toBe(false);
    expect(liveOutboundExplicitlyEnabled(loadConfig({ ...base, APP_MODE: "read_only", OUTBOUND_MODE: "live", ENABLE_LIVE_TIKTOK_OUTBOUND: "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES" }))).toBe(true);
    expect(liveOutboundExplicitlyEnabled(loadConfig({ ...base, APP_MODE: "mock", OUTBOUND_MODE: "live", ENABLE_LIVE_TIKTOK_OUTBOUND: "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES" }))).toBe(false);
  });

  it("fails production startup for missing repository secrets and infrastructure", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgresql://localhost/test", RUNTIME_ENV: "production", APP_MODE: "read_only", SERVICE_ROLE: "api" })).toThrow(/REDIS_URL.*TIKTOK_APP_KEY/);
  });

  it("requires the exact live acknowledgement in production", () => {
    const production = {
      ...base, REDIS_URL: "redis://redis:6379", RUNTIME_ENV: "production", SERVICE_ROLE: "outbound-worker",
      APP_MODE: "read_only", OUTBOUND_MODE: "live", TIKTOK_APP_KEY: "key", TIKTOK_APP_SECRET: "secret",
      TIKTOK_SERVICE_ID: "service", TIKTOK_TOKEN_ENCRYPTION_KEY: "01234567890123456789012345678901"
    };
    expect(() => loadConfig(production)).toThrow(/exact|requires ENABLE_LIVE/);
    expect(loadConfig({ ...production, ENABLE_LIVE_TIKTOK_OUTBOUND: "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES" }).OUTBOUND_MODE).toBe("live");
  });

  it("rejects mock provider mode in production", () => {
    expect(() => loadConfig({ ...base, REDIS_URL: "redis://redis:6379", RUNTIME_ENV: "production", SERVICE_ROLE: "api", APP_MODE: "mock" })).toThrow(/APP_MODE/);
  });
});
