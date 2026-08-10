import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  PORT: z.coerce.number().default(4000),
  APP_MODE: z.literal("mock").default("mock"),
  SHOP_TIMEZONE: z.string().default("Asia/Jakarta"),
  MAX_SENDS_PER_CAMPAIGN: z.coerce.number().int().positive().default(1000),
  MAX_SENDS_PER_DAY: z.coerce.number().int().positive().default(1000),
  MAX_DISPATCHES_PER_MINUTE: z.coerce.number().int().positive().default(10),
  MOCK_RECONCILIATION_DELAYS_MS: z.string().default("300000,1800000,7200000")
});

export type AppConfig = z.infer<typeof schema>;
export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => schema.parse(environment);

