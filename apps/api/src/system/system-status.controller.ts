import { Controller, Get } from "@nestjs/common";
import { SystemStatusService } from "./system-status.service";

@Controller()
export class SystemStatusController {
  constructor(private readonly statusService: SystemStatusService) {}
  @Get("health") health() { return this.statusService.readiness(); }
  @Get("api/v1/system/status") status() { return this.statusService.status(); }
}
