import { randomUUID } from "node:crypto";
import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from "@nestjs/common";

type HttpReply = {
  header(name: string, value: string): HttpReply;
  status(code: number): { send(body: unknown): void };
};

type HttpRequest = { method?: string; url?: string };

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
    this.logger.error(
      `Unexpected API failure errorId=${errorId} method=${request?.method ?? "UNKNOWN"} path=${request?.url ?? "UNKNOWN"}`,
      error instanceof Error ? error.stack : String(error)
    );
  }
}
