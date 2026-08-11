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

@Module({
  controllers: [OutreachController, HistoryController, IntegrationsController],
  providers: [PrismaService, QueueService, TikTokReadGovernor, TikTokIntegrationService, CreatorIdentityResolver, OutreachService, HistoryService]
})
export class AppModule {}
