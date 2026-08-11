import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TikTokIntegrationService } from "./tiktok.service";

@ApiTags("integrations")
@Controller("api/v1/integrations")
export class IntegrationsController {
  constructor(private readonly tiktok: TikTokIntegrationService) {}
  @Get("tiktok")
  status() { return this.tiktok.status(); }
  @Post("tiktok/authorize") authorize() { return this.tiktok.initiateAuthorization(); }
  @Get("tiktok/callback") callback(@Query() query: { state?: string; code?: string; error?: string }) { return this.tiktok.callback(query); }
  @Post("tiktok/shop-selection") select(@Body() body: { externalShopId: string }) { return this.tiktok.selectShop(body.externalShopId); }
  @Post("tiktok/refresh") refresh() { return this.tiktok.refreshToken().then(() => this.tiktok.status()); }
  @Get("tiktok/creators/:creatorOpenId/performance") performance(@Param("creatorOpenId") creatorOpenId: string, @Query("validationMode") validationMode?: string) { return this.tiktok.creatorPerformance(creatorOpenId, validationMode === "true"); }
}
