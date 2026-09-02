import { z } from "zod";

const optionalNonBlank = z.preprocess((value) => typeof value === "string" && !value.trim() ? undefined : value, z.string().min(1).optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("127.0.0.1"),
  RUNTIME_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVICE_ROLE: z.enum(["api", "discovery-worker", "history-worker", "outbound-worker"]).optional(),
  WEB_INTERNAL_URL: z.string().url().default("http://web:3000"),
  APP_VERSION: z.string().default("development"),
  BUILD_TIMESTAMP: z.string().default("unknown"),
  APP_MODE: z.enum(["mock", "read_only"]).default("mock"),
  OUTBOUND_MODE: z.enum(["mock", "read_only", "live"]).optional(),
  TIKTOK_APP_KEY: z.string().min(1).optional(),
  TIKTOK_APP_SECRET: z.string().min(1).optional(),
  TIKTOK_SERVICE_ID: z.string().min(1).optional(),
  TIKTOK_TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  TIKTOK_CATEGORY_APP_KEY: optionalNonBlank,
  TIKTOK_CATEGORY_APP_SECRET: optionalNonBlank,
  TIKTOK_CATEGORY_ACCESS_TOKEN: optionalNonBlank,
  TIKTOK_CATEGORY_SHOP_CIPHER: optionalNonBlank,
  TIKTOK_REDIRECT_URI: z.string().url().default("http://127.0.0.1:4000/api/v1/integrations/tiktok/callback"),
  TIKTOK_API_BASE_URL: z.string().url().default("https://open-api.tiktokglobalshop.com"),
  TIKTOK_AUTH_BASE_URL: z.string().url().default("https://auth.tiktok-shops.com"),
  TIKTOK_AUTHORIZATION_BASE_URL: z.string().url().default("https://services.tiktokshop.com/open/authorize"),
  TIKTOK_TOKEN_REFRESH_MARGIN_SECONDS: z.coerce.number().int().min(60).default(1800),
  TIKTOK_TOKEN_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60000).default(300000),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(5000).default(15000),
  WORKER_STALE_AFTER_MS: z.coerce.number().int().min(15000).default(45000),
  MARKETPLACE_SUCCESS_SPACING_MS: z.coerce.number().int().min(1000).default(1000),
  CREATOR_SYNC_INITIAL_PAGE_TOKEN: z.string().min(1).default("b2Zmc2V0PTIwMA=="),
  CREATOR_SYNC_INITIAL_SEARCH_KEY: z.string().min(1).default("QSZE+iqSvaMxdRFk1A6Pf5OQ5HdB7mPYSN/GEc/MNmw="),
  CREATOR_SYNC_INITIAL_PAGES: z.coerce.number().int().min(0).default(10),
  CREATOR_SYNC_INITIAL_CREATORS: z.coerce.number().int().min(0).default(200),
  CREATOR_SYNC_SPREADSHEET_ID: z.string().min(1).default("1h_r1eaSHH0nIu6-0P70tMc03lxsQ1Jg9b1xl9xiCPX4"),
  CREATOR_OBSERVED_SATURATION_MIN_ROWS: z.coerce.number().int().min(1).default(380),
  CREATOR_OBSERVED_SATURATION_MAX_ROWS: z.coerce.number().int().min(1).default(405),
  CREATOR_FIRST_SPLIT_MIN_WIDTH: z.coerce.number().int().min(2).default(500),
  CREATOR_DEEP_SPLIT_MIN_INCREMENTAL_YIELD: z.coerce.number().min(0).max(1).default(0.10),
  CREATOR_LOW_VALUE_COMBINED_YIELD: z.coerce.number().min(0).max(1).default(0.05),
  CREATOR_SCHEDULER_PRIMARY_CYCLE: z.coerce.number().int().min(10).default(10),
  CREATOR_G4_PROBE_CADENCE: z.coerce.number().int().min(100).default(100),
  CREATOR_FOLLOWER_MIN_WIDTH_600_999: z.coerce.number().int().min(1).default(50),
  CREATOR_FOLLOWER_MIN_WIDTH_1000_9999: z.coerce.number().int().min(1).default(100),
  CREATOR_FOLLOWER_MIN_WIDTH_10000_99999: z.coerce.number().int().min(1).default(1000),
  CREATOR_FOLLOWER_MIN_WIDTH_100000_999999: z.coerce.number().int().min(1).default(10000),
  CREATOR_FOLLOWER_MIN_WIDTH_1000000_PLUS: z.coerce.number().int().min(1).default(100000),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  DISCOVERY_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  HISTORY_SYNC_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  HISTORY_SYNC_SUCCESS_SPACING_MS: z.coerce.number().int().min(750).default(1000),
  HISTORY_SYNC_INCREMENTAL_INTERVAL_MS: z.coerce.number().int().min(300000).default(21600000),
  HISTORY_SYNC_INCREMENTAL_PAGES: z.coerce.number().int().min(1).max(20).default(3),
  HISTORY_SYNC_HEAD_EVERY_BACKFILL_PAGES: z.coerce.number().int().min(1).max(100).default(5),
  SHOP_TIMEZONE: z.string().default("Asia/Jakarta"),
  MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().int().positive().default(500),
  OUTBOUND_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(16),
  OUTBOUND_PROVIDER_INITIAL_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  OUTBOUND_PROVIDER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(16),
  OUTBOUND_PROVIDER_PERMIT_LEASE_MS: z.coerce.number().int().min(30000).max(300000).default(120000),
  OUTBOUND_SEND_MESSAGE_INTERVAL_MS: z.coerce.number().int().min(1000).default(1000),
  OUTBOUND_QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(1000),
  OUTBOUND_QUEUE_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(1000),
  MOCK_RECONCILIATION_DELAYS_MS: z.string().default("300000,1800000,7200000")
});

type ParsedConfig = z.infer<typeof schema>;
export type AppConfig = Omit<ParsedConfig, "OUTBOUND_MODE"> & { OUTBOUND_MODE: "mock" | "read_only" | "live" };
export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = schema.parse(environment);
  const config = { ...parsed, OUTBOUND_MODE: parsed.OUTBOUND_MODE ?? (
    parsed.RUNTIME_ENV === "production" ? "live" : parsed.APP_MODE === "mock" ? "mock" : "read_only"
  ) };
  if (config.OUTBOUND_MODE === "live" && config.APP_MODE !== "read_only") {
    throw new Error("Live outbound requires APP_MODE=read_only");
  }
  validateProductionConfig(config, environment);
  return config;
};

export function validateProductionConfig(config: AppConfig, raw: NodeJS.ProcessEnv): void {
  if (config.RUNTIME_ENV !== "production") return;
  const missing: string[] = [];
  for (const name of ["DATABASE_URL", "REDIS_URL"] as const) if (!raw[name]?.trim()) missing.push(name);
  if (!config.SERVICE_ROLE) missing.push("SERVICE_ROLE");
  if (config.APP_MODE !== "read_only") throw new Error("Production APP_MODE must be read_only");
  if (config.OUTBOUND_MODE !== "live") throw new Error("Production outbound mode must remain live");
  for (const name of ["TIKTOK_APP_KEY", "TIKTOK_APP_SECRET", "TIKTOK_SERVICE_ID", "TIKTOK_TOKEN_ENCRYPTION_KEY"] as const) {
    if (!config[name]?.trim()) missing.push(name);
  }
  if (config.SERVICE_ROLE === "outbound-worker" && config.OUTBOUND_MODE !== "live") {
    throw new Error("Production outbound worker requires OUTBOUND_MODE=live");
  }
  if (missing.length) throw new Error(`Production configuration missing: ${[...new Set(missing)].join(", ")}`);
}

export type ConfiguredOutboundCapability = {
  mode: "MOCK" | "READ_ONLY" | "LIVE";
  mutationCapability: boolean;
};

/**
 * The single configuration-level outbound capability model shared by API and
 * workers. Production validation requires LIVE; no per-deployment
 * acknowledgement gate can make otherwise-identical processes disagree.
 */
export function configuredOutboundCapability(config: Pick<AppConfig, "OUTBOUND_MODE">): ConfiguredOutboundCapability {
  const mode = config.OUTBOUND_MODE.toUpperCase() as ConfiguredOutboundCapability["mode"];
  return { mode, mutationCapability: mode !== "READ_ONLY" };
}

export function tiktokCredentialsConfigured(config: AppConfig): boolean {
  return Boolean(config.TIKTOK_APP_KEY && config.TIKTOK_APP_SECRET && config.TIKTOK_SERVICE_ID && config.TIKTOK_TOKEN_ENCRYPTION_KEY);
}

export function tiktokCategoryCredentialsConfigured(config: AppConfig): boolean {
  return Boolean(config.TIKTOK_CATEGORY_APP_KEY && config.TIKTOK_CATEGORY_APP_SECRET
    && config.TIKTOK_CATEGORY_ACCESS_TOKEN && config.TIKTOK_CATEGORY_SHOP_CIPHER);
}
