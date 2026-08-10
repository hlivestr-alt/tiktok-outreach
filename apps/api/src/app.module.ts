import { Module } from "@nestjs/common";
import { OutreachController } from "./outreach/outreach.controller";
import { OutreachService } from "./outreach/outreach.service";
import { HistoryController } from "./history/history.controller";
import { HistoryService } from "./history/history.service";
import { IntegrationsController } from "./integrations/integrations.controller";
import { PrismaService, QueueService } from "./shared";
import { TikTokIntegrationService } from "./integrations/tiktok.service";

@Module({
  controllers: [OutreachController, HistoryController, IntegrationsController],
  providers: [PrismaService, QueueService, TikTokIntegrationService, OutreachService, HistoryService]
})
export class AppModule {}
