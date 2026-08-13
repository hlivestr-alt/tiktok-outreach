import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { config, PrismaService } from "./shared";
import { TikTokReadGovernor } from "./integrations/tiktok-read-governor";
import { TikTokIntegrationService } from "./integrations/tiktok.service";
import { CreatorIdentityResolver } from "./identity/creator-identity-resolver.service";
import { DiscoveryProcessor } from "./outreach/discovery-processor";
import { WorkerHeartbeatPublisher } from "./worker-heartbeat";

@Module({ providers: [PrismaService, TikTokReadGovernor, TikTokIntegrationService, CreatorIdentityResolver, DiscoveryProcessor] })
class DiscoveryWorkerModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(DiscoveryWorkerModule, { logger: ["error", "warn", "log"] });
  const processor = app.get(DiscoveryProcessor);
  const heartbeat = new WorkerHeartbeatPublisher(app.get(PrismaService), "discovery-worker", { capability: "SEARCH_CREATORS", mutations: false });
  await heartbeat.start();
  let stopping = false;
  const tick = async () => {
    if (stopping) return;
    try { while (await processor.processNext()) { /* drain due local jobs one page at a time */ } }
    catch (error) { console.error("Discovery sweep failed", error instanceof Error ? error.message : "unknown error"); }
  };
  await tick();
  const timer = setInterval(() => void tick(), config.DISCOVERY_POLL_INTERVAL_MS);
  const shutdown = async () => { stopping = true; clearInterval(timer); await heartbeat.stop(); await app.close(); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  console.log(JSON.stringify({ level: "info", worker: "discovery-worker", event: "ready", outboundProvider: "PHYSICALLY_UNAVAILABLE" }));
}

void main().catch((error) => { console.error(JSON.stringify({ level: "fatal", worker: "discovery-worker", event: "startup_failed", error: error instanceof Error ? error.message : "unknown" })); process.exitCode = 1; });
