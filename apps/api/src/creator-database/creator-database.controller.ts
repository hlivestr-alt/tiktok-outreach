import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreatorDatabaseService } from "./creator-database.service";

@ApiTags("creator-database")
@Controller("api/v1/outreach/creator-database")
export class CreatorDatabaseController {
  constructor(private readonly service: CreatorDatabaseService) {}
  @Get() status() { return this.service.status(); }
  @Post("retry-delay") updateRetryDelay(@Body() body: { marketplaceRetryDelaySeconds?: unknown }) {
    return this.service.updateMarketplaceRetryDelay(body?.marketplaceRetryDelaySeconds);
  }
  @Post("pause") pause() { return this.service.pause(); }
  @Post("resume") resume() { return this.service.resume(); }
  @Post("categories/refresh") refreshCategories() { return this.service.refreshCategories(); }
}
