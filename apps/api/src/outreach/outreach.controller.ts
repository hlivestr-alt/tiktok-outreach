import { Body, Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { CampaignCloneFromPreviewInput, CampaignCreateInput } from "@affiliate/contracts";
import { OutreachService } from "./outreach.service";

@ApiTags("outreach")
@Controller("api/v1/outreach/campaigns")
export class OutreachController {
  constructor(private readonly service: OutreachService) {}
  @Get() list() { return this.service.list(); }
  @Post() create(@Body() body: CampaignCreateInput) { return this.service.create(body); }
  @Post(":id/discovery-runs") discover(@Param("id") id: string) { return this.service.discover(id); }
  @Post(":id/clone-from-preview") cloneFromPreview(
    @Param("id") id: string,
    @Body() body: CampaignCloneFromPreviewInput,
    @Headers("idempotency-key") idempotencyKey?: string
  ) { return this.service.cloneFromPreview(id, body, idempotencyKey); }
  @Post(":id/discovery-runs/cancel") cancelDiscovery(@Param("id") id: string) { return this.service.cancelDiscovery(id); }
  @Get(":id/preview") preview(@Param("id") id: string) { return this.service.preview(id); }
  @Get(":id/recipients") recipients(@Param("id") id: string, @Query("view") view?: string) { return this.service.recipients(id, view); }
  @Get(":id") get(@Param("id") id: string) { return this.service.get(id); }
  @Post(":id/freeze") freeze(@Param("id") id: string, @Body() body: { version: number }) { return this.service.freeze(id, body.version); }
  @Post(":id/send") send(@Param("id") id: string, @Body() body: { version: number }) { return this.service.send(id, body.version); }
  @Post(":id/pause") pause(@Param("id") id: string) { return this.service.pause(id); }
  @Post(":id/resume") resume(@Param("id") id: string) { return this.service.resume(id); }
  @Post(":id/cancel") cancel(@Param("id") id: string) { return this.service.cancel(id); }
}
