import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { HistoryService } from "./history.service";

@ApiTags("contact-history")
@Controller("api/v1/contact-history")
export class HistoryController {
  constructor(private readonly service: HistoryService) {}
  @Get() contacts() { return this.service.contacts(); }
  @Post("sync-runs") sync(@Query("validationMode") validationMode?: string) { return this.service.syncMockHistory(undefined, undefined, validationMode === "true"); }
  @Post("imports") importCsv(@Body() body: { sourceName: string; csv: string }) { return this.service.importCsv(body); }
  @Get("readiness") readiness() { return this.service.readiness(); }
}
