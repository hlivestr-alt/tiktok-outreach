import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@affiliate/db";
import { config } from "./shared";

export type WorkerRole = "discovery-worker" | "history-worker" | "outbound-worker";

export class WorkerHeartbeatPublisher {
  private readonly instanceId = randomUUID();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly role: WorkerRole,
    private readonly metadata: Record<string, string | boolean> = {}
  ) {}

  async start(): Promise<void> {
    await this.publish("RUNNING");
    this.timer = setInterval(() => void this.publish("RUNNING").catch((error) => {
      console.error(JSON.stringify({ level: "error", worker: this.role, event: "heartbeat_failed", error: error instanceof Error ? error.message : "unknown" }));
    }), config.WORKER_HEARTBEAT_INTERVAL_MS ?? 15_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.publish("STOPPED").catch(() => undefined);
  }

  private async publish(status: "RUNNING" | "STOPPED"): Promise<void> {
    const now = new Date();
    await this.prisma.workerHeartbeat.upsert({
      where: { role: this.role },
      update: { instanceId: this.instanceId, status, lastSeenAt: now, metadata: this.metadata },
      create: { role: this.role, instanceId: this.instanceId, status, startedAt: now, lastSeenAt: now, metadata: this.metadata }
    });
  }
}

export function workerOperationalState(heartbeat: { status: string; lastSeenAt: Date } | null, now = new Date()): "RUNNING" | "STALE" | "STOPPED" {
  if (!heartbeat || heartbeat.status === "STOPPED") return "STOPPED";
  return now.getTime() - heartbeat.lastSeenAt.getTime() <= (config.WORKER_STALE_AFTER_MS ?? 45_000) ? "RUNNING" : "STALE";
}
