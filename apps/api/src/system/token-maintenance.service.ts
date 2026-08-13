import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { config, PrismaService } from "../shared";
import { TikTokIntegrationService } from "../integrations/tiktok.service";

@Injectable()
export class TokenMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly integration: TikTokIntegrationService) {}

  onModuleInit(): void {
    if (config.APP_MODE !== "read_only") return;
    this.timer = setInterval(() => void this.sweep(), config.TIKTOK_TOKEN_MAINTENANCE_INTERVAL_MS ?? 300_000);
    this.timer.unref();
    setTimeout(() => void this.sweep(), 30_000).unref();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async sweep(now = new Date(), testOnlyForce = false): Promise<"NOT_DUE" | "REFRESHED" | "SKIPPED" | "FAILED"> {
    if (this.running || (!testOnlyForce && config.APP_MODE !== "read_only")) return "SKIPPED";
    this.running = true;
    try {
      const selectedShop = await this.prisma.shop.findFirst({ where: { connectionMode: "READ_ONLY", selectedForReadOnly: true }, select: { id: true } });
      if (!selectedShop) return "NOT_DUE";
      const due = await this.prisma.integrationConnection.findFirst({ where: {
        shopId: selectedShop.id, provider: "TIKTOK_SHOP", status: "HEALTHY", refreshState: "IDLE",
        accessTokenExpiresAt: { lte: new Date(now.getTime() + config.TIKTOK_TOKEN_REFRESH_MARGIN_SECONDS * 1000) }
      }, orderBy: { accessTokenExpiresAt: "asc" } });
      if (!due) return "NOT_DUE";
      await this.integration.refreshToken(due.shopId, "AUTO");
      console.log(JSON.stringify({ level: "info", service: "api", event: "token_refresh_completed", shopId: due.shopId }));
      return "REFRESHED";
    } catch (error) {
      console.error(JSON.stringify({ level: "error", service: "api", event: "token_refresh_failed", error: error instanceof Error ? error.message : "unknown" }));
      return "FAILED";
    } finally { this.running = false; }
  }
}
