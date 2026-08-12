import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { CampaignCreateInput } from "@affiliate/contracts";
import { OutreachService } from "./outreach.service";

@ApiTags("outreach")
@Controller("api/v1/outreach/campaigns")
export class OutreachController {
  constructor(private readonly service: OutreachService) {}
  @Get() list() { return this.service.list(); }
  @Post() create(@Body() body: CampaignCreateInput) { return this.service.create(body); }
  @Post(":id/discovery-runs") discover(@Param("id") id: string) { return this.service.discover(id); }
  @Post(":id/discovery-runs/cancel") cancelDiscovery(@Param("id") id: string) { return this.service.cancelDiscovery(id); }
  @Get(":id/preview") preview(@Param("id") id: string) { return this.service.preview(id); }
  @Get(":id/recipients") recipients(@Param("id") id: string, @Query("view") view?: string) { return this.service.recipients(id, view); }
  @Get(":id") get(@Param("id") id: string) { return this.service.get(id); }
  @Post(":id/freeze") freeze(@Param("id") id: string, @Body() body: { version: number }) { return this.service.freeze(id, body.version); }
  @Post(":id/start") start(@Param("id") id: string, @Body() body: { version: number; confirmationName: string; confirmationCount: number }) { return this.service.start(id, body); }
  @Post(":id/pause") pause(@Param("id") id: string) { return this.service.pause(id); }
  @Post(":id/resume") resume(@Param("id") id: string) { return this.service.resume(id); }
}
