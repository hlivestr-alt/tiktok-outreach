import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { config } from "./shared";
import { TikTokApiExceptionFilter } from "./integrations/tiktok-api-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: ["error", "warn", "log"] });
  app.enableCors({ origin: ["http://localhost:3000", "http://127.0.0.1:3000"] });
  app.useGlobalFilters(new TikTokApiExceptionFilter());
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("Affiliate Outreach Operations API").setVersion("1.0").build());
  SwaggerModule.setup("api/docs", app, document);
  await app.listen(config.PORT, config.HOST);
  console.log(JSON.stringify({ level: "info", service: "api", event: "ready", version: config.APP_VERSION, buildTimestamp: config.BUILD_TIMESTAMP }));
}
void bootstrap().catch((error) => { console.error(JSON.stringify({ level: "fatal", service: "api", event: "startup_failed", error: error instanceof Error ? error.message : "unknown" })); process.exitCode = 1; });
