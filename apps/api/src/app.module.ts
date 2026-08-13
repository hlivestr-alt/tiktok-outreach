import { Module } from "@nestjs/common";
import { OutreachController } from "./outreach/outreach.controller";
import { OutreachService } from "./outreach/outreach.service";
import { HistoryController } from "./history/history.controller";
import { HistoryService } from "./history/history.service";
import { IntegrationsController } from "./integrations/integrations.controller";
import { PrismaService, QueueService } from "./shared";
import { TikTokIntegrationService } from "./integrations/tiktok.service";
import { CreatorIdentityResolver } from "./identity/creator-identity-resolver.service";
import { TikTokReadGovernor } from "./integrations/tiktok-read-governor";
import { DiscoveryProcessor } from "./outreach/discovery-processor";
import { HistoryProcessor } from "./history/history-processor";
import { SystemStatusController } from "./system/system-status.controller";
import { SystemStatusService } from "./system/system-status.service";
import { TokenMaintenanceService } from "./system/token-maintenance.service";

@Module({
  controllers: [OutreachController, HistoryController, IntegrationsController, SystemStatusController],
  providers: [PrismaService, QueueService, TikTokReadGovernor, TikTokIntegrationService, CreatorIdentityResolver, DiscoveryProcessor, HistoryProcessor, OutreachService, HistoryService, SystemStatusService, TokenMaintenanceService]
})
export class AppModule {}
