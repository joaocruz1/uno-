import { appUrl } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { ZodError } from "zod";

export { requireActor, requireAdmin } from "./auth/actor";
export type { Actor } from "./auth/actor";

type ErrorEnvelope = {
  requestId: string;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export function requestId(request?: Request): string {
  const supplied = request?.headers.get("x-request-id")?.trim();
  if (supplied && /^[A-Za-z0-9_-]{8,128}$/.test(supplied)) return supplied;
  return `req_${crypto.randomUUID()}`;
}

export function errorResponse(error: unknown, id = requestId()): Response {
  let appError: AppError;
  if (error instanceof ZodError) {
    appError = new AppError("invalid_request", "A solicitação contém dados inválidos.", 400);
  } else if (error instanceof AppError && error.code !== "service_unavailable") {
    appError = error;
  } else if (error instanceof AppError) {
    appError = new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  } else {
    appError = new AppError("internal_error", "Não foi possível concluir a solicitação.", 500);
  }
  const body: ErrorEnvelope = {
    requestId: id,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
    },
  };
  const headers: Record<string, string> = { "cache-control": "no-store" };
  const retryAfterSeconds = appError.details?.retryAfterSeconds;
  if ((appError.status === 429 || appError.status === 409) && typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)) {
    headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
  }
  return Response.json(body, { status: appError.status, headers });
}

function isMutation(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function isCsrfExempt(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith("/api/auth/")) return true;
  if (pathname.startsWith("/api/webhooks/") || pathname === "/api/stripe/webhook") return true;
  return pathname.startsWith("/api/v1/") && /^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "");
}

export function assertSameOrigin(request: Request): void {
  if (!isMutation(request.method) || isCsrfExempt(request)) return;
  const origin = request.headers.get("origin");
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(appUrl()).origin;
  } catch {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  if (!origin || origin !== expectedOrigin) {
    throw new AppError("invalid_origin", "Origem da solicitação não permitida.", 403);
  }
}

export function withJsonHandler(
  handler: (request: Request, id: string) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const id = requestId(request);
    try {
      assertSameOrigin(request);
      return await handler(request, id);
    } catch (error) {
      return errorResponse(error, id);
    }
  };
}
