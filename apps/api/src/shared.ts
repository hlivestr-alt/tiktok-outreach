import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@affiliate/db";
import { loadConfig } from "@affiliate/config";
import { Queue } from "bullmq";

export const config = loadConfig();
const redis = new URL(config.REDIS_URL);
export const queueConnection = { host: redis.hostname, port: Number(redis.port || 6379), password: redis.password || undefined };

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> { await this.$disconnect(); }
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly outreach = new Queue("outreach", { connection: queueConnection });
  async onModuleDestroy(): Promise<void> { await this.outreach.close(); }
}

export async function ensureMockShop(prisma: PrismaService) {
  const existing = await prisma.shop.findFirst({ orderBy: { createdAt: "asc" } });
  if (existing) return existing;
  return prisma.shop.create({ data: {
    name: "Indonesia Mock Shop", region: "ID", currency: "IDR", timezone: config.SHOP_TIMEZONE,
    connectionMode: "MOCK", maxSendsPerCampaign: config.MAX_SENDS_PER_CAMPAIGN,
    maxSendsPerDay: config.MAX_SENDS_PER_DAY, maxDispatchesPerMinute: config.MAX_DISPATCHES_PER_MINUTE
  }});
}

