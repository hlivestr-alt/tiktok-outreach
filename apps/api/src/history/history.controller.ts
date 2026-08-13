import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { HistoryService } from "./history.service";

@ApiTags("contact-history")
@Controller("api/v1/contact-history")
export class HistoryController {
  constructor(private readonly service: HistoryService) {}
  @Get() contacts() { return this.service.contacts(); }
  @Get("sync-job") historyStatus() { return this.service.historyStatus(); }
  @Post("sync-job/start") start() { return this.service.startHistorySync(); }
  @Post("sync-job/pause") pause() { return this.service.pauseHistorySync(); }
  @Post("sync-job/resume") resume() { return this.service.resumeHistorySync(); }
  @Post("sync-job/incremental") incremental() { return this.service.runIncrementalNow(); }
  @Post("sync-runs") sync() { return this.service.startHistorySync(); }
  @Post("validation/conversations") validateConversations() { return this.service.validateConversationList(); }
  @Post("validation/conversations/:conversationId/messages") validateMessages(
    @Param("conversationId") conversationId: string,
    @Body() body: { creatorImId?: string } = {}
  ) { return this.service.validateMessageList(conversationId, body.creatorImId); }
  @Post("imports") importCsv(@Body() body: { sourceName: string; csv: string }) { return this.service.importCsv(body); }
  @Get("readiness") readiness() { return this.service.readiness(); }
}
