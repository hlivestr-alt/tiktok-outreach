import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { config, PrismaService } from "./shared";
import { TikTokReadGovernor } from "./integrations/tiktok-read-governor";
import { TikTokIntegrationService } from "./integrations/tiktok.service";
import { CreatorIdentityResolver } from "./identity/creator-identity-resolver.service";
import { DiscoveryProcessor } from "./outreach/discovery-processor";

@Module({ providers: [PrismaService, TikTokReadGovernor, TikTokIntegrationService, CreatorIdentityResolver, DiscoveryProcessor] })
class DiscoveryWorkerModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(DiscoveryWorkerModule, { logger: ["error", "warn", "log"] });
  const processor = app.get(DiscoveryProcessor);
  let stopping = false;
  const tick = async () => {
    if (stopping) return;
    try { while (await processor.processNext()) { /* drain due local jobs one page at a time */ } }
    catch (error) { console.error("Discovery sweep failed", error instanceof Error ? error.message : "unknown error"); }
  };
  await tick();
  const timer = setInterval(() => void tick(), config.DISCOVERY_POLL_INTERVAL_MS);
  const shutdown = async () => { stopping = true; clearInterval(timer); await app.close(); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  console.log("Read-only Marketplace discovery worker ready", { outboundProvider: "PHYSICALLY_UNAVAILABLE" });
}

void main();
