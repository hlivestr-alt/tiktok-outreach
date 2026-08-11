import { ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import { TikTokApiError } from "@affiliate/tiktok-adapter";

@Catch(TikTokApiError)
export class TikTokApiExceptionFilter implements ExceptionFilter {
  catch(error: TikTokApiError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status(code: number): { send(body: unknown): void } }>();
    const throttled = error.kind === "RATE_LIMIT";
    response.status(throttled ? 429 : 502).send({
      statusCode: throttled ? 429 : 502,
      error: throttled ? "TIKTOK_READ_THROTTLED" : "TIKTOK_READ_FAILED",
      message: throttled ? "TikTok read capacity is temporarily throttled. Wait until the next safe attempt time." : `TikTok read failed (${error.kind}).`,
      operation: error.operation,
      providerCode: error.providerCode ?? null,
      providerRequestId: error.requestId ?? null,
      retryAfterMs: error.retryAfterMs ?? null,
      nextSafeAttemptAt: error.nextPermittedAt?.toISOString() ?? null,
      providerRequestPerformed: !error.locallyBlocked
    });
  }
}
