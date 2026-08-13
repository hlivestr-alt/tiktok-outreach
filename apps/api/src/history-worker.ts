import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { config, PrismaService } from "./shared";
import { TikTokReadGovernor } from "./integrations/tiktok-read-governor";
import { TikTokIntegrationService } from "./integrations/tiktok.service";
import { CreatorIdentityResolver } from "./identity/creator-identity-resolver.service";
import { HistoryProcessor } from "./history/history-processor";
import { WorkerHeartbeatPublisher } from "./worker-heartbeat";

@Module({ providers: [PrismaService, TikTokReadGovernor, TikTokIntegrationService, CreatorIdentityResolver, HistoryProcessor] })
class HistoryWorkerModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(HistoryWorkerModule, { logger: ["error", "warn", "log"] });
  const processor = app.get(HistoryProcessor);
  const heartbeat = new WorkerHeartbeatPublisher(app.get(PrismaService), "history-worker", { capabilities: "LIST_CONVERSATIONS,LIST_MESSAGES", mutations: false });
  await heartbeat.start();
  let stopping = false;
  const tick = async () => {
    if (stopping) return;
    try { while (await processor.processNext()) { /* one persisted provider page per claim */ } }
    catch (error) { console.error("History sweep failed", error instanceof Error ? error.message : "unknown error"); }
  };
  await tick();
  const timer = setInterval(() => void tick(), config.HISTORY_SYNC_POLL_INTERVAL_MS);
  const shutdown = async () => { stopping = true; clearInterval(timer); await heartbeat.stop(); await app.close(); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  console.log(JSON.stringify({ level: "info", worker: "history-worker", event: "ready", capabilities: ["LIST_CONVERSATIONS", "LIST_MESSAGES"], outboundProvider: "PHYSICALLY_UNAVAILABLE" }));
}

void main().catch((error) => { console.error(JSON.stringify({ level: "fatal", worker: "history-worker", event: "startup_failed", error: error instanceof Error ? error.message : "unknown" })); process.exitCode = 1; });
