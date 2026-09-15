import { BadRequestException, Body, Controller, Get, Headers, Logger, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { CampaignCloneFromPreviewInput, CampaignCreateInput } from "@affiliate/contracts";
import { OutreachService } from "./outreach.service";

@ApiTags("outreach")
@Controller("api/v1/outreach/campaigns")
export class OutreachController {
  private readonly logger = new Logger(OutreachController.name);
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
  @Post(":id/send") async send(@Param("id") id: string, @Body() body: { version: number }) {
    this.logger.log(`Campaign Send requested campaignId=${id} version=${body?.version ?? "MISSING"} endpoint=/api/v1/outreach/campaigns/:id/send`);
    try {
      if (!Number.isInteger(body?.version)) throw new BadRequestException("Campaign version is required");
      const result = await this.service.send(id, body.version);
      this.logger.log(`Campaign Send completed campaignId=${id} state=${result.state}`);
      return result;
    } catch (error) {
      this.logger.warn(`Campaign Send rejected campaignId=${id} error=${error instanceof Error ? error.name : "UNKNOWN"}`);
      throw error;
    }
  }
  @Post(":id/pause") pause(@Param("id") id: string) { return this.service.pause(id); }
  @Post(":id/resume") resume(@Param("id") id: string) { return this.service.resume(id); }
  @Post(":id/cancel") cancel(@Param("id") id: string) { return this.service.cancel(id); }
}
