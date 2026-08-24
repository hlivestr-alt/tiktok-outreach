import { Injectable } from "@nestjs/common";
import { config, PrismaService, QueueService } from "../shared";
import { TikTokIntegrationService } from "../integrations/tiktok.service";
import { workerOperationalState } from "../worker-heartbeat";

@Injectable()
export class SystemStatusService {
  constructor(private readonly prisma: PrismaService, private readonly queues: QueueService, private readonly integration: TikTokIntegrationService) {}

  private async infrastructure() {
    let postgres = false; let redis = false; let web = false;
    try { await this.prisma.$queryRaw`SELECT 1`; postgres = true; } catch { /* sanitized */ }
    try { redis = await (await this.queues.outreach.client as unknown as { ping(): Promise<string> }).ping() === "PONG"; } catch { /* sanitized */ }
    try { web = (await fetch(`${config.WEB_INTERNAL_URL}/api/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* sanitized */ }
    return { postgres, redis, web };
  }

  async readiness() {
    const infrastructure = await this.infrastructure();
    return { status: infrastructure.postgres && infrastructure.redis ? "healthy" : "unhealthy", api: true, ...infrastructure, version: config.APP_VERSION, buildTimestamp: config.BUILD_TIMESTAMP };
  }

  async status() {
    const now = new Date();
    const [infrastructure, heartbeats, integration, pendingDiscovery, backingOffDiscovery, queuedOutbound, sending, unknown, safetyPaused] = await Promise.all([
      this.infrastructure(), this.prisma.workerHeartbeat.findMany(), this.integration.status(),
      this.prisma.discoveryRun.count({ where: { state: "QUEUED" } }),
      this.prisma.discoveryRun.count({ where: { state: "BACKING_OFF" } }),
      this.prisma.queueOutbox.count({ where: { state: { in: ["PENDING", "ENQUEUED"] } } }),
      this.prisma.outreachDelivery.count({ where: { state: "DISPATCHING" } }),
      this.prisma.outreachDelivery.count({ where: { state: { in: ["DELIVERY_UNKNOWN", "DELIVERY_UNKNOWN_UNRESOLVED"] } } }),
      this.prisma.campaign.count({ where: { state: "SAFETY_PAUSED" } })
    ]);
    const heartbeat = (role: string) => heartbeats.find((item) => item.role === role) ?? null;
    const outboundHeartbeat = heartbeat("outbound-worker");
    const outboundRuntime = outboundHeartbeat?.metadata && typeof outboundHeartbeat.metadata === "object" && !Array.isArray(outboundHeartbeat.metadata)
      ? outboundHeartbeat.metadata as Record<string, unknown> : {};
    const connection = (integration as any).connection ?? null;
    return {
      generatedAt: now, version: { gitSha: config.APP_VERSION, buildTimestamp: config.BUILD_TIMESTAMP },
      services: { api: "HEALTHY", web: infrastructure.web ? "HEALTHY" : "UNHEALTHY", postgres: infrastructure.postgres ? "HEALTHY" : "UNHEALTHY", redis: infrastructure.redis ? "HEALTHY" : "UNHEALTHY" },
      workers: {
        discovery: workerOperationalState(heartbeat("discovery-worker"), now),
        history: workerOperationalState(heartbeat("history-worker"), now),
        outbound: config.OUTBOUND_MODE === "live" ? workerOperationalState(outboundHeartbeat, now) : "STOPPED"
      },
      outbound: { mode: config.OUTBOUND_MODE.toUpperCase(), enabled: (integration as any).outboundEnabled === true, runtime: outboundRuntime },
      tiktok: { state: (integration as any).configurationState, selectedShop: (integration as any).selectedShop ?? (integration as any).shop ?? null, accessTokenExpiresAt: connection?.accessTokenExpiresAt ?? null, refreshState: connection?.refreshState ?? "IDLE", reauthorizationRequired: Boolean(connection && connection.status !== "HEALTHY") },
      workload: { pendingDiscovery, backingOffDiscovery, queuedOutbound, currentlySending: sending, unknownDeliveries: unknown, safetyPausedCampaigns: safetyPaused }
    };
  }
}
