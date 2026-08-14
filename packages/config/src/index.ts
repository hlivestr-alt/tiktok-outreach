import { z } from "zod";

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
  ENABLE_LIVE_TIKTOK_OUTBOUND: z.string().optional(),
  TIKTOK_APP_KEY: z.string().min(1).optional(),
  TIKTOK_APP_SECRET: z.string().min(1).optional(),
  TIKTOK_SERVICE_ID: z.string().min(1).optional(),
  TIKTOK_TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
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
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  DISCOVERY_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  HISTORY_SYNC_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  HISTORY_SYNC_SUCCESS_SPACING_MS: z.coerce.number().int().min(750).default(1000),
  HISTORY_SYNC_INCREMENTAL_INTERVAL_MS: z.coerce.number().int().min(300000).default(21600000),
  HISTORY_SYNC_INCREMENTAL_PAGES: z.coerce.number().int().min(1).max(20).default(3),
  HISTORY_SYNC_HEAD_EVERY_BACKFILL_PAGES: z.coerce.number().int().min(1).max(100).default(5),
  SHOP_TIMEZONE: z.string().default("Asia/Jakarta"),
  MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().int().positive().default(100),
  MAX_DISPATCH_ATTEMPTS_PER_CAMPAIGN: z.coerce.number().int().positive().default(400),
  MAX_SENDS_PER_DAY: z.coerce.number().int().positive().default(100),
  MAX_SENDS_PER_HOUR: z.coerce.number().int().positive().default(20),
  MAX_DISPATCHES_PER_MINUTE: z.coerce.number().int().positive().default(5),
  OUTBOUND_PACING_MS: z.coerce.number().int().min(1000).default(10000),
  MOCK_RECONCILIATION_DELAYS_MS: z.string().default("300000,1800000,7200000")
});

type ParsedConfig = z.infer<typeof schema>;
export type AppConfig = Omit<ParsedConfig, "OUTBOUND_MODE"> & { OUTBOUND_MODE: "mock" | "read_only" | "live" };
export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = schema.parse(environment);
  const config = { ...parsed, OUTBOUND_MODE: parsed.OUTBOUND_MODE ?? (parsed.APP_MODE === "mock" ? "mock" : "read_only") };
  validateProductionConfig(config, environment);
  return config;
};

export function validateProductionConfig(config: AppConfig, raw: NodeJS.ProcessEnv): void {
  if (config.RUNTIME_ENV !== "production") return;
  const missing: string[] = [];
  for (const name of ["DATABASE_URL", "REDIS_URL"] as const) if (!raw[name]?.trim()) missing.push(name);
  if (!config.SERVICE_ROLE) missing.push("SERVICE_ROLE");
  if (config.APP_MODE !== "read_only") throw new Error("Production APP_MODE must be read_only");
  for (const name of ["TIKTOK_APP_KEY", "TIKTOK_APP_SECRET", "TIKTOK_SERVICE_ID", "TIKTOK_TOKEN_ENCRYPTION_KEY"] as const) {
    if (!config[name]?.trim()) missing.push(name);
  }
  if (config.SERVICE_ROLE === "outbound-worker" && config.OUTBOUND_MODE !== "live") {
    throw new Error("Production outbound worker requires OUTBOUND_MODE=live");
  }
  if (config.OUTBOUND_MODE === "live" && !liveOutboundExplicitlyEnabled(config)) {
    throw new Error("Production live outbound requires ENABLE_LIVE_TIKTOK_OUTBOUND=I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES");
  }
  if (missing.length) throw new Error(`Production configuration missing: ${[...new Set(missing)].join(", ")}`);
}

export function liveOutboundExplicitlyEnabled(config: AppConfig): boolean {
  return config.OUTBOUND_MODE === "live" && config.APP_MODE === "read_only"
    && config.ENABLE_LIVE_TIKTOK_OUTBOUND === "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES";
}

export function tiktokCredentialsConfigured(config: AppConfig): boolean {
  return Boolean(config.TIKTOK_APP_KEY && config.TIKTOK_APP_SECRET && config.TIKTOK_SERVICE_ID && config.TIKTOK_TOKEN_ENCRYPTION_KEY);
}
