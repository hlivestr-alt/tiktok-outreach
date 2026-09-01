import { describe, expect, it } from "vitest";
import { configuredOutboundCapability, loadConfig } from "./index";

const base = { DATABASE_URL: "postgresql://localhost/test" };
describe("outbound activation", () => {
  it("defaults mock and real environments to their safe provider modes", () => {
    expect(loadConfig({ ...base, APP_MODE: "mock" }).OUTBOUND_MODE).toBe("mock");
    expect(loadConfig({ ...base, APP_MODE: "read_only" }).OUTBOUND_MODE).toBe("read_only");
  });
  it("defaults the shared campaign recipient ceiling to 500", () => {
    expect(loadConfig(base).MAX_RECIPIENTS_PER_CAMPAIGN).toBe(500);
  });
  it("has no daily or per-campaign dispatch-attempt capacity settings", () => {
    const value = loadConfig({ ...base, MAX_SENDS_PER_DAY: "1", MAX_DISPATCH_ATTEMPTS_PER_CAMPAIGN: "1", MAX_SENDS_PER_HOUR: "1", MAX_DISPATCHES_PER_MINUTE: "1", OUTBOUND_PACING_MS: "10000", OUTBOUND_QUEUE_JOBS_PER_MINUTE: "1" });
    expect(value).not.toHaveProperty("MAX_SENDS_PER_DAY");
    expect(value).not.toHaveProperty("MAX_DISPATCH_ATTEMPTS_PER_CAMPAIGN");
    expect(value).not.toHaveProperty("MAX_SENDS_PER_HOUR");
    expect(value).not.toHaveProperty("MAX_DISPATCHES_PER_MINUTE");
    expect(value).not.toHaveProperty("OUTBOUND_PACING_MS");
    expect(value).not.toHaveProperty("OUTBOUND_QUEUE_JOBS_PER_MINUTE");
  });
  it("uses an adaptive provider ceiling below the worker's technical scheduler ceiling", () => {
    expect(loadConfig(base)).toMatchObject({
      OUTBOUND_WORKER_CONCURRENCY: 16,
      OUTBOUND_PROVIDER_INITIAL_CONCURRENCY: 4,
      OUTBOUND_PROVIDER_MAX_CONCURRENCY: 16,
      OUTBOUND_PROVIDER_PERMIT_LEASE_MS: 120_000,
      OUTBOUND_SEND_MESSAGE_INTERVAL_MS: 1_000,
      OUTBOUND_QUEUE_RECONCILE_BATCH_SIZE: 1_000
    });
  });
  it("centralizes the V2 follower split defaults", () => {
    const value = loadConfig(base);
    expect(value).toMatchObject({ CREATOR_FOLLOWER_MIN_WIDTH_600_999: 50, CREATOR_FOLLOWER_MIN_WIDTH_1000_9999: 100,
      CREATOR_FOLLOWER_MIN_WIDTH_10000_99999: 1_000, CREATOR_FOLLOWER_MIN_WIDTH_100000_999999: 10_000,
      CREATOR_FOLLOWER_MIN_WIDTH_1000000_PLUS: 100_000, CREATOR_OBSERVED_SATURATION_MIN_ROWS: 380,
      CREATOR_OBSERVED_SATURATION_MAX_ROWS: 405, CREATOR_FIRST_SPLIT_MIN_WIDTH: 500,
      CREATOR_DEEP_SPLIT_MIN_INCREMENTAL_YIELD: 0.10, CREATOR_LOW_VALUE_COMBINED_YIELD: 0.05,
      CREATOR_V2_EXPLORATION_INTERVAL: 7 });
  });
  it("treats blank optional category credentials as not configured", () => {
    const value = loadConfig({ ...base, TIKTOK_CATEGORY_APP_KEY: "", TIKTOK_CATEGORY_APP_SECRET: "",
      TIKTOK_CATEGORY_ACCESS_TOKEN: "", TIKTOK_CATEGORY_SHOP_CIPHER: "" });
    expect(value.TIKTOK_CATEGORY_APP_KEY).toBeUndefined();
  });
  it("uses one shared capability model without a recurring acknowledgement", () => {
    const value = loadConfig({ ...base, APP_MODE: "read_only", OUTBOUND_MODE: "live" });
    expect(configuredOutboundCapability(value)).toEqual({ mode: "LIVE", mutationCapability: true });
  });

  it("fails production startup for missing repository secrets and infrastructure", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgresql://localhost/test", RUNTIME_ENV: "production", APP_MODE: "read_only", SERVICE_ROLE: "api" })).toThrow(/REDIS_URL.*TIKTOK_APP_KEY/);
  });

  it("defaults production outbound to LIVE and does not require an acknowledgement", () => {
    const production = {
      ...base, REDIS_URL: "redis://redis:6379", RUNTIME_ENV: "production", SERVICE_ROLE: "outbound-worker",
      APP_MODE: "read_only", OUTBOUND_MODE: "live", TIKTOK_APP_KEY: "key", TIKTOK_APP_SECRET: "secret",
      TIKTOK_SERVICE_ID: "service", TIKTOK_TOKEN_ENCRYPTION_KEY: "01234567890123456789012345678901"
    };
    expect(loadConfig(production).OUTBOUND_MODE).toBe("live");
    expect(loadConfig({ ...production, OUTBOUND_MODE: undefined }).OUTBOUND_MODE).toBe("live");
  });

  it("rejects mock provider mode in production", () => {
    expect(() => loadConfig({ ...base, REDIS_URL: "redis://redis:6379", RUNTIME_ENV: "production", SERVICE_ROLE: "api", APP_MODE: "mock" })).toThrow(/APP_MODE/);
  });
});
