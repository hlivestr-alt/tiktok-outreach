import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { HistoryService } from "./history.service";

@ApiTags("contact-history")
@Controller("api/v1/contact-history")
export class HistoryController {
  constructor(private readonly service: HistoryService) {}
  @Get() contacts() { return this.service.contacts(); }
  @Post("sync-runs") sync(@Query("validationMode") validationMode?: string) { return this.service.syncMockHistory(undefined, undefined, validationMode === "true"); }
  @Post("validation/conversations") validateConversations() { return this.service.validateConversationList(); }
  @Post("validation/conversations/:conversationId/messages") validateMessages(
    @Param("conversationId") conversationId: string,
    @Body() body: { creatorImId?: string } = {}
  ) { return this.service.validateMessageList(conversationId, body.creatorImId); }
  @Post("imports") importCsv(@Body() body: { sourceName: string; csv: string }) { return this.service.importCsv(body); }
  @Get("readiness") readiness() { return this.service.readiness(); }
}
