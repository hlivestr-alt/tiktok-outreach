import { randomUUID } from "node:crypto";
import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from "@nestjs/common";

type HttpReply = {
  header(name: string, value: string): HttpReply;
  status(code: number): { send(body: unknown): void };
};

type HttpRequest = { method?: string; url?: string; routeOptions?: { url?: string } };

export function safeRequestFields(request?: HttpRequest) {
  const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(request?.method ?? "") ? request!.method : "UNKNOWN";
  // Fastify's registered route template contains no browser-supplied values.
  // Never log a raw URL, query, exception message, stack or request headers.
  const template = request?.routeOptions?.url;
  const pathname = template && /^\/[A-Za-z0-9_/:.*-]{1,200}$/.test(template) ? template : "UNMATCHED_ROUTE";
  return { method, pathname, category: "UNEXPECTED_REQUEST_FAILURE" };
}

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<HttpReply>();
    if (error instanceof HttpException) {
      response.status(error.getStatus()).send(error.getResponse());
      return;
    }

    const request = http.getRequest<HttpRequest>();
    const errorId = randomUUID();
    response.header("x-error-id", errorId).status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "INTERNAL_SERVER_ERROR",
      message: "Unable to complete the request.",
      errorId
    });
    this.logger.error(JSON.stringify({ errorId, ...safeRequestFields(request) }));
  }
}
