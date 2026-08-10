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
    return { shop, capabilities: await this.adapter.getCapabilities(), outboundEnabled: false, productionAdapterInstalled: false };
  }
}

