import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("127.0.0.1"),
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
  MARKETPLACE_SUCCESS_SPACING_MS: z.coerce.number().int().min(1000).default(1000),
  DISCOVERY_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  HISTORY_SYNC_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  HISTORY_SYNC_SUCCESS_SPACING_MS: z.coerce.number().int().min(750).default(1000),
  HISTORY_SYNC_INCREMENTAL_INTERVAL_MS: z.coerce.number().int().min(300000).default(21600000),
  HISTORY_SYNC_INCREMENTAL_PAGES: z.coerce.number().int().min(1).max(20).default(3),
  HISTORY_SYNC_HEAD_EVERY_BACKFILL_PAGES: z.coerce.number().int().min(1).max(100).default(5),
  SHOP_TIMEZONE: z.string().default("Asia/Jakarta"),
  MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().int().positive().default(1000),
  MAX_DISPATCH_ATTEMPTS_PER_CAMPAIGN: z.coerce.number().int().positive().default(4000),
  MAX_SENDS_PER_DAY: z.coerce.number().int().positive().default(1000),
  MAX_SENDS_PER_HOUR: z.coerce.number().int().positive().default(50),
  MAX_DISPATCHES_PER_MINUTE: z.coerce.number().int().positive().default(10),
  OUTBOUND_PACING_MS: z.coerce.number().int().min(1000).default(5000),
  MOCK_RECONCILIATION_DELAYS_MS: z.string().default("300000,1800000,7200000")
});

type ParsedConfig = z.infer<typeof schema>;
export type AppConfig = Omit<ParsedConfig, "OUTBOUND_MODE"> & { OUTBOUND_MODE: "mock" | "read_only" | "live" };
export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = schema.parse(environment);
  return { ...parsed, OUTBOUND_MODE: parsed.OUTBOUND_MODE ?? (parsed.APP_MODE === "mock" ? "mock" : "read_only") };
};

export function liveOutboundExplicitlyEnabled(config: AppConfig): boolean {
  return config.OUTBOUND_MODE === "live" && config.APP_MODE === "read_only"
    && config.ENABLE_LIVE_TIKTOK_OUTBOUND === "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES";
}

export function tiktokCredentialsConfigured(config: AppConfig): boolean {
  return Boolean(config.TIKTOK_APP_KEY && config.TIKTOK_APP_SECRET && config.TIKTOK_SERVICE_ID && config.TIKTOK_TOKEN_ENCRYPTION_KEY);
}
