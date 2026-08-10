import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { MockTikTokAffiliateAdapter } from "@affiliate/tiktok-adapter";
import { ensureMockShop, PrismaService } from "../shared";

@ApiTags("integrations")
@Controller("api/v1/integrations")
export class IntegrationsController {
  private readonly adapter = new MockTikTokAffiliateAdapter();
  constructor(private readonly prisma: PrismaService) {}
  @Get("tiktok")
  async status() {
    const shop = await ensureMockShop(this.prisma);
    const safetySettingsAudit = await this.prisma.safetySettingsAudit.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" }, take: 10 });
    return {
      shop, capabilities: await this.adapter.getCapabilities(), outboundEnabled: false, productionAdapterInstalled: false,
      safetySettingsSource: "PERSISTENT_DATABASE_AFTER_INITIAL_CREATION",
      environmentRole: "INITIAL_DEFAULTS_ONLY",
      safetySettingsAudit
    };
  }
}
